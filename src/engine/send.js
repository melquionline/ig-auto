import { log } from '../logger.js';
import * as graph from '../meta/graph.js';
import { config } from '../config.js';
import { links } from '../db.js';

// Payload dos botões: "go:<automationId>:<nodeId>" — o clique retoma o fluxo naquele bloco
export const buttonPayload = (automationId, nodeId) => `go:${automationId}:${nodeId}`;
export const parsePayload = (p = '') => {
  const m = /^go:(\d+):([\w-]+)$/.exec(p);
  return m && { automationId: Number(m[1]), nodeId: m[2] };
};

// Monta as variantes de uma mensagem, da mais rica para a mais simples.
// Se a Meta recusar um formato, cai para o próximo — nenhum bloco deixa de ser entregue.
function variants(node, automationId) {
  const postbacks = (node.buttons ?? []).filter((b) => b.next);
  const links = (node.buttons ?? []).filter((b) => b.url);

  if (node.type === 'card') {
    return [
      { attachment: { type: 'template', payload: { template_type: 'generic', elements: [{
        title: node.title,
        subtitle: node.subtitle,
        ...(node.image_url && { image_url: node.image_url }),
        buttons: node.buttons.map((b) => b.url
          ? { type: 'web_url', url: b.url, title: b.title }
          : { type: 'postback', title: b.title, payload: buttonPayload(automationId, b.next) }),
      }] } } },
      { text: [node.title, node.subtitle, '', ...links.map((b) => `👉 ${b.title}: ${b.url}`)].filter((l) => l !== undefined).join('\n') },
    ];
  }

  if (postbacks.length || links.length) {
    const out = [
      { attachment: { type: 'template', payload: { template_type: 'button', text: node.text, buttons: node.buttons.map((b) => b.url
        ? { type: 'web_url', url: b.url, title: b.title }
        : { type: 'postback', title: b.title, payload: buttonPayload(automationId, b.next) }) } } },
    ];
    if (postbacks.length && !links.length) {
      out.push({ text: node.text, quick_replies: postbacks.map((b) => ({ content_type: 'text', title: b.title, payload: buttonPayload(automationId, b.next) })) });
    }
    out.push({ text: [node.text, ...links.map((b) => `👉 ${b.title}: ${b.url}`), ...(postbacks.length ? [`(responda "${postbacks[0].title.replace(/[^\p{L}\p{N} ]/gu, '').trim()}")`] : [])].join('\n\n') });
    return out;
  }
  return [{ text: node.text }];
}

// Troca cada link por /r/<code>, que registra o clique (de quem, em qual botão) e redireciona
function trackLinks(node, { account, automationId, run }) {
  if (!node.buttons?.some((b) => b.url) || !config.publicUrl) return node;
  return {
    ...node,
    buttons: node.buttons.map((b) => b.url ? {
      ...b,
      url: `${config.publicUrl}/r/${links.create({
        accountId: account.ig_user_id, automationId, runId: run?.id, igsid: run?.context.igsid,
        nodeId: node.id, title: b.title, targetUrl: b.url,
      })}`,
    } : b),
  };
}

// to: { commentId } para a DM privada a partir de comentário, ou { igsid } para DM normal
export async function sendNode({ account, to, node, automationId, run }) {
  const { access_token: token, ig_user_id: id } = account;
  node = trackLinks(node, { account, automationId, run });
  let lastErr;
  for (const message of variants(node, automationId)) {
    try {
      const r = to.commentId
        ? await graph.privateReply(token, id, to.commentId, message)
        : await graph.sendMessage(token, id, to.igsid, message);
      return r;
    } catch (e) {
      lastErr = e;
      log.warn('send_variant_failed', { node: node.id, format: message.attachment?.payload?.template_type ?? (message.quick_replies ? 'quick_replies' : 'text'), err: e.message });
    }
  }
  throw lastErr;
}
