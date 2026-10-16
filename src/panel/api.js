import express from 'express';
import { automations, leads } from '../db.js';
import * as graph from '../meta/graph.js';
import { validateAutomation } from '../engine/validate.js';
import { requireSession, clearSession } from './auth.js';
import { log } from '../logger.js';

export const api = express.Router();
api.use(requireSession);

const EMPTY_STATS = { runs: 0, people: 0, continued: 0, completed: 0, clicks: [] };

const publicAutomation = (a, stats) => ({
  id: a.id, name: a.name, active: !!a.active, sources: a.sources, mediaId: a.media_id,
  keywords: a.keywords, matchMode: a.match_mode, priority: a.priority, flow: a.flow,
  updatedAt: a.updated_at, stats: stats ?? EMPTY_STATS,
});

const fromBody = (b) => ({
  name: String(b.name ?? '').trim(),
  active: b.active !== false,
  sources: Array.isArray(b.sources) ? b.sources : [],
  mediaId: b.mediaId || null,
  keywords: (Array.isArray(b.keywords) ? b.keywords : []).map((k) => String(k).trim()).filter(Boolean),
  matchMode: b.matchMode ?? 'contains',
  priority: b.mediaId ? 20 : 10, // automação de um post específico ganha da de "qualquer post"
  flow: b.flow,
});

api.get('/me', (req, res) => res.json({ username: req.account.username, igUserId: req.account.ig_user_id }));

api.post('/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });

api.get('/automations', (req, res) => {
  const stats = automations.stats(req.account.ig_user_id);
  res.json(automations.listAll(req.account.ig_user_id).map((a) => publicAutomation(a, stats[a.id])));
});

api.get('/automations/:id', (req, res) => {
  const a = automations.get(Number(req.params.id));
  if (!a || a.account_id !== req.account.ig_user_id) return res.status(404).json({ error: 'Automação não encontrada.' });
  res.json(publicAutomation(a, automations.stats(req.account.ig_user_id)[a.id]));
});

function save(req, res, id) {
  const a = fromBody(req.body);
  const errors = validateAutomation(a);
  if (errors.length) return res.status(422).json({ errors });
  const acc = req.account.ig_user_id;
  if (automations.listAll(acc).some((x) => x.name === a.name && x.id !== id)) {
    return res.status(422).json({ errors: [`Já existe uma automação chamada "${a.name}".`] });
  }
  if (id) {
    if (!automations.update(acc, id, a)) return res.status(404).json({ error: 'Automação não encontrada.' });
  } else {
    id = automations.create(acc, a);
  }
  log.info('panel_saved', { id, name: a.name });
  res.json({ id });
}
api.post('/automations', (req, res) => save(req, res, null));
api.put('/automations/:id', (req, res) => save(req, res, Number(req.params.id)));

api.patch('/automations/:id/active', (req, res) => {
  const ok = automations.setActive(req.account.ig_user_id, Number(req.params.id), !!req.body.active);
  ok ? res.json({ ok: true }) : res.status(404).json({ error: 'Automação não encontrada.' });
});

api.delete('/automations/:id', (req, res) => {
  const ok = automations.remove(req.account.ig_user_id, Number(req.params.id));
  ok ? res.json({ ok: true }) : res.status(404).json({ error: 'Automação não encontrada.' });
});

api.get('/leads', (req, res) => res.json(leads.list(req.account.ig_user_id)));

// Posts, reels e stories ativos, para escolher onde a automação vale
api.get('/media', async (req, res) => {
  const t = req.account.access_token;
  const [posts, stories] = await Promise.allSettled([graph.listMedia(t), graph.listStories(t)]);
  const pick = (m, kind) => ({
    id: m.id, kind, type: m.media_product_type ?? m.media_type, caption: (m.caption ?? '').slice(0, 140),
    thumb: m.thumbnail_url ?? m.media_url, permalink: m.permalink, timestamp: m.timestamp,
  });
  res.json({
    posts: posts.status === 'fulfilled' ? (posts.value.data ?? []).map((m) => pick(m, 'post')) : [],
    stories: stories.status === 'fulfilled' ? (stories.value.data ?? []).map((m) => pick(m, 'story')) : [],
    error: posts.status === 'rejected' ? 'Não consegui carregar seus posts agora. Tente de novo em instantes.' : null,
  });
});
