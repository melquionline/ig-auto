import crypto from 'node:crypto';
import { config } from '../config.js';
import { accounts } from '../db.js';

// Sessão = cookie assinado "<igUserId>.<expira>.<hmac>" — sem estado no servidor
const COOKIE = 'igauto_sess';
const TTL_MS = 30 * 86_400_000;
// Caminho do cookie = caminho do PUBLIC_URL (ex.: https://site.com/ig-auto → /ig-auto)
const cookiePath = () => (config.devLogin ? '/' : new URL(config.publicUrl || 'http://x/').pathname.replace(/\/$/, '') || '/');
const secret = () => config.sessionSecret || crypto.createHash('sha256').update(`sess:${config.appSecret}`).digest('hex');
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');

export function setSession(res, igUserId) {
  const v = `${igUserId}.${Date.now() + TTL_MS}`;
  res.cookie(COOKIE, `${v}.${sign(v)}`, {
    httpOnly: true, secure: !config.devLogin, sameSite: 'lax', path: cookiePath(), maxAge: TTL_MS,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: cookiePath() });
}

function readSession(req) {
  const raw = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [id, exp, sig] = decodeURIComponent(raw).split('.');
  const expected = sign(`${id}.${exp}`);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now()) return null;
  return id;
}

export const canUsePanel = (username) => config.panelUsers.includes(username);

export function requireSession(req, res, next) {
  const account = accounts.get(readSession(req) ?? '');
  if (!account || !canUsePanel(account.username)) return res.status(401).json({ error: 'Entre com o Instagram para continuar.' });
  req.account = account;
  next();
}
