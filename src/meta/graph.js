import { config } from '../config.js';
import { log } from '../logger.js';

const GRAPH = () => `https://graph.instagram.com/${config.graphVersion}`;

async function call(method, url, { token, body, form } = {}) {
  if (config.dryRun) {
    log.info('dry_run', { method, url: url.split('?')[0], body });
    return { dry_run: true };
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (form) payload = new URLSearchParams(form);
  const res = await fetch(url, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = new Error(data.error?.message || `HTTP ${res.status}`);
    err.meta = data.error;
    log.error('graph_error', { method, url: url.split('?')[0], status: res.status, error: data.error });
    throw err;
  }
  return data;
}

// ---------- OAuth (login com Instagram) ----------
export const oauth = {
  authorizeUrl(state) {
    const p = new URLSearchParams({
      client_id: config.appId,
      redirect_uri: `${config.publicUrl}/oauth/callback`,
      response_type: 'code',
      scope: ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'].join(','),
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${p}`;
  },
  exchangeCode: (code) =>
    call('POST', 'https://api.instagram.com/oauth/access_token', {
      form: {
        client_id: config.appId,
        client_secret: config.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: `${config.publicUrl}/oauth/callback`,
        code,
      },
    }),
  longLived: (shortToken) =>
    call('GET', `https://graph.instagram.com/access_token?${new URLSearchParams({
      grant_type: 'ig_exchange_token', client_secret: config.appSecret, access_token: shortToken,
    })}`),
  refresh: (token) =>
    call('GET', `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({
      grant_type: 'ig_refresh_token', access_token: token,
    })}`),
};

// ---------- Conta ----------
// user_id = ID profissional usado nos webhooks (≠ "id", que é app-scoped)
export const getMe = (token) => call('GET', `${GRAPH()}/me?fields=user_id,username`, { token });

export const subscribeWebhooks = (token, fields) =>
  call('POST', `${GRAPH()}/me/subscribed_apps?subscribed_fields=${fields.join(',')}`, { token });

// ---------- Ações ----------
export const replyToComment = (token, commentId, message) =>
  call('POST', `${GRAPH()}/${commentId}/replies`, { token, body: { message } });

// DM privada a partir de um comentário (1 por comentário, até 7 dias; live: só durante a live)
export const privateReply = (token, igUserId, commentId, message) =>
  call('POST', `${GRAPH()}/${igUserId}/messages`, { token, body: { recipient: { comment_id: commentId }, message } });

// DM normal (precisa da janela de 24h aberta)
export const sendMessage = (token, igUserId, igsid, message) =>
  call('POST', `${GRAPH()}/${igUserId}/messages`, { token, body: { recipient: { id: igsid }, message } });

// Perfil de quem interagiu — inclui se segue a conta (base do "precisa seguir")
export const getUserProfile = (token, igsid) =>
  call('GET', `${GRAPH()}/${igsid}?fields=name,username,is_user_follow_business,is_business_follow_user`, { token });

// "digitando..." — cosmético, falha silenciosamente
export const typing = (token, igUserId, igsid) =>
  call('POST', `${GRAPH()}/${igUserId}/messages`, { token, body: { recipient: { id: igsid }, sender_action: 'typing_on' } })
    .catch(() => null);

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp';
export const listMedia = (token, limit = 30) => call('GET', `${GRAPH()}/me/media?fields=${MEDIA_FIELDS}&limit=${limit}`, { token });
export const listStories = (token) => call('GET', `${GRAPH()}/me/stories?fields=${MEDIA_FIELDS}`, { token });
