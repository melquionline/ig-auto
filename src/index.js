import express from 'express';
import crypto from 'node:crypto';
import { config, WEBHOOK_FIELDS } from './config.js';
import { log } from './logger.js';
import { accounts, events, links } from './db.js';
import { api } from './panel/api.js';
import { setSession, canUsePanel } from './panel/auth.js';
import { isValidSignature } from './meta/signature.js';
import * as graph from './meta/graph.js';
import { normalize } from './webhook/normalize.js';
import { handleEvent } from './engine/index.js';

const app = express();
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

const requireAdmin = (req, res, next) =>
  config.adminKey && req.query.key === config.adminKey ? next() : res.status(401).send('unauthorized');

app.get('/health', (_req, res) => res.json({ ok: true, accounts: accounts.list().length }));

// ---------- Webhook: verificação (a Meta chama uma vez ao configurar) ----------
app.get('/webhook', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.verifyToken;
  log.info('webhook_verify', { ok });
  return ok ? res.status(200).send(req.query['hub.challenge']) : res.sendStatus(403);
});

// ---------- Webhook: eventos ----------
app.post('/webhook', (req, res) => {
  const validSig = isValidSignature(req.rawBody, req.get('x-hub-signature-256'));
  if (!validSig) {
    log.warn('webhook_bad_signature', { enforce: config.signatureEnforce });
    if (config.signatureEnforce) return res.sendStatus(401);
  }
  res.sendStatus(200); // responde rápido; a Meta reenvia se demorar

  const list = normalize(req.body);
  if (!list.length) log.info('webhook_unhandled', { body: req.body });
  for (const ev of list) {
    const fresh = events.insert({ accountId: ev.accountId, source: ev.source, dedupeKey: ev.dedupeKey, payload: ev.raw });
    if (!fresh) continue;
    log.info('event', { source: ev.source, accountId: ev.accountId, text: ev.text?.slice(0, 80) });
    handleEvent(ev).catch((e) => log.error('handle_failed', { source: ev.source, err: e.message, meta: e.meta }));
  }
});

// ---------- Conectar conta (login com Instagram) ----------
const pendingStates = new Map(); // state -> { exp, purpose }
const startOAuth = (res, purpose) => {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { exp: Date.now() + 10 * 60_000, purpose });
  res.redirect(graph.oauth.authorizeUrl(state));
};
app.get('/connect', requireAdmin, (_req, res) => startOAuth(res, 'connect'));
app.get('/painel/entrar', (_req, res) => startOAuth(res, 'login'));

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error_description } = req.query;
  if (error_description) return res.status(400).send(`Instagram recusou: ${error_description}`);
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (!pending || pending.exp < Date.now()) {
    return res.status(400).send(`<meta charset="utf-8">O login expirou. <a href="${config.publicUrl}/painel/entrar">Entrar de novo</a>`);
  }
  try {
    const short = await graph.oauth.exchangeCode(String(code).replace(/#_$/, ''));
    const long = await graph.oauth.longLived(short.access_token);
    const me = await graph.getMe(long.access_token);
    accounts.upsert({
      igUserId: String(me.user_id),
      username: me.username,
      accessToken: long.access_token,
      expiresAt: Date.now() + long.expires_in * 1000,
    });
    try {
      await graph.subscribeWebhooks(long.access_token, WEBHOOK_FIELDS);
    } catch {
      await graph.subscribeWebhooks(long.access_token, WEBHOOK_FIELDS.filter((f) => f !== 'live_comments'));
      log.warn('live_comments_not_subscribed');
    }
    log.info('account_connected', { username: me.username, igUserId: me.user_id, purpose: pending.purpose });
    if (pending.purpose === 'login') {
      if (!canUsePanel(me.username)) return res.status(403).send(`<meta charset="utf-8">@${me.username} não tem acesso a este painel.`);
      setSession(res, String(me.user_id));
      return res.redirect(`${config.publicUrl}/painel/`);
    }
    res.send(`<meta charset="utf-8"><h2>✅ @${me.username} conectado</h2><p>Webhooks assinados. Pode fechar esta aba.</p>`);
  } catch (e) {
    log.error('oauth_failed', { err: e.message, meta: e.meta });
    res.status(500).send(`<meta charset="utf-8">Falha ao conectar: ${e.message}`);
  }
});

// ---------- Links rastreados das DMs ----------
app.get('/r/:code', (req, res) => {
  const l = links.hit(req.params.code);
  if (!l) return res.status(404).send('Link não encontrado.');
  log.info('link_click', { automation: l.automation_id, title: l.title });
  res.redirect(302, l.target_url);
});

// ---------- Painel ----------
app.get('/painel', (req, res, next) => (req.path.endsWith('/') ? next() : res.redirect(`${config.publicUrl}/painel/`)));
if (config.devLogin) {
  app.get('/painel/dev-login', (req, res) => { setSession(res, String(req.query.as)); res.redirect('/painel/'); });
}
app.use('/painel/api', api);
app.use('/painel', express.static(new URL('../public/painel', import.meta.url).pathname, { maxAge: 0 }));

// ---------- Admin (debug) ----------
app.get('/admin/status', requireAdmin, (_req, res) =>
  res.json({ accounts: accounts.list(), recentEvents: events.recent(30) }));

// ---------- Renovação de token (tokens longos duram 60 dias) ----------
async function refreshTokens() {
  for (const acc of accounts.expiringBefore(Date.now() + 10 * 86_400_000)) {
    try {
      const r = await graph.oauth.refresh(acc.access_token);
      accounts.updateToken(acc.ig_user_id, r.access_token, Date.now() + r.expires_in * 1000);
      log.info('token_refreshed', { username: acc.username });
    } catch (e) {
      log.error('token_refresh_failed', { username: acc.username, err: e.message });
    }
  }
}
setInterval(refreshTokens, 12 * 3_600_000);
setTimeout(refreshTokens, 30_000);

app.listen(config.port, '127.0.0.1', () => log.info('ig-auto up', { port: config.port }));
