import { config } from '../config.js';
import { log } from '../logger.js';
import { accounts, contacts, automations, runs } from '../db.js';
import * as graph from '../meta/graph.js';
import { matches } from './text.js';
import { parsePayload } from './send.js';
import { execute } from './runner.js';

const TRIGGER_COOLDOWN_MS = 12 * 3_600_000; // mesma pessoa não recebe o mesmo fluxo 2x em 12h

export async function handleEvent(ev) {
  const account = accounts.get(ev.accountId);
  if (!account) {
    log.warn('event_for_unknown_account', { accountId: ev.accountId, source: ev.source });
    return;
  }
  // Nunca reagir à própria conta (evita loop respondendo a si mesmo)
  if (ev.senderId === account.ig_user_id) return;

  if (ev.senderId) {
    const inbound = ['dm', 'story_reply', 'story_mention', 'postback', 'reaction'].includes(ev.source);
    contacts.touch({ accountId: account.ig_user_id, igsid: ev.senderId, username: ev.senderUsername, inbound });
    if (inbound && !contacts.get(account.ig_user_id, ev.senderId)?.username) fillUsername(account, ev.senderId);
  }

  // 1) Clique em botão / resposta rápida → retoma o fluxo no bloco indicado
  const payload = parsePayload(ev.postbackPayload ?? ev.quickReplyPayload);
  if (payload) return resume(account, ev, payload);

  // 2) Texto no direct enquanto um fluxo espera resposta → segue o fluxo
  if (ev.source === 'dm' || ev.source === 'story_reply') {
    const waiting = runs.latestWaiting(account.ig_user_id, ev.senderId);
    if (waiting) {
      const automation = automations.get(waiting.automation_id);
      const node = automation?.flow.nodes[waiting.current_node];
      // Parado na trava de seguir: qualquer texto ("já segui") confere de novo o mesmo bloco
      const next = waiting.context.gateAt === waiting.current_node
        ? waiting.current_node
        : node?.on_text ?? node?.buttons?.find((b) => b.next)?.next;
      // Só continua se a mensagem não for gatilho de outra automação
      if (next && !findAutomation(account, ev)) {
        waiting.context.continued = true;
        return execute({ run: waiting, automation, account, nodeId: next, ev });
      }
    }
  }

  // 3) Gatilho novo: origem + mídia + palavra-chave
  const automation = findAutomation(account, ev);
  if (automation) return start(account, automation, ev);

  if (config.smokeTest) await smokeTest(account, ev);
}

function findAutomation(account, ev) {
  return automations.listActive(account.ig_user_id).find((a) =>
    a.sources.includes(ev.source) &&
    (!a.media_id || a.media_id === ev.mediaId || a.media_id === ev.storyId) &&
    matches(ev.text, a.keywords, a.match_mode));
}

async function start(account, automation, ev) {
  const isComment = ev.source === 'post_comment' || ev.source === 'live_comment';
  const recent = runs.startedSince(automation.id, account.ig_user_id, ev.senderId, Date.now() - TRIGGER_COOLDOWN_MS);

  // Já recebeu esse fluxo há pouco: em comentário, só responde publicamente; no direct, ignora
  if (recent) {
    log.info('flow_cooldown', { automation: automation.name, source: ev.source });
    const first = automation.flow.nodes[automation.flow.start];
    if (isComment && first?.type === 'comment_reply') {
      await graph.replyToComment(account.access_token, ev.commentId, first.variations[Math.floor(Math.random() * first.variations.length)]);
    }
    return;
  }

  const run = runs.create({
    automationId: automation.id,
    accountId: account.ig_user_id,
    igsid: ev.senderId,
    context: { igsid: ev.senderId, trigger: ev.source, commentId: isComment ? ev.commentId : null, mediaId: ev.mediaId ?? ev.storyId ?? null, text: ev.text },
  });
  log.info('flow_start', { automation: automation.name, source: ev.source, run: run.id });
  // Fora de comentário não há o que responder publicamente: pula o bloco comment_reply
  try {
    return await execute({ run, automation, account, nodeId: automation.flow.start, ev });
  } catch (e) {
    // Falhou antes de mandar qualquer DM (ex.: token caído): não conta na pausa de 12h
    if (!run.context.sentAny) runs.update(run.id, { currentNode: null, status: 'failed', context: run.context });
    throw e;
  }
}

async function resume(account, ev, { automationId, nodeId }) {
  const automation = automations.get(automationId);
  if (!automation?.active || !automation.flow.nodes[nodeId]) return;
  const waiting = runs.latestWaiting(account.ig_user_id, ev.senderId);
  const run = waiting?.automation_id === automationId
    ? waiting
    : runs.create({ automationId, accountId: account.ig_user_id, igsid: ev.senderId, context: { igsid: ev.senderId, trigger: 'postback' } });
  run.context.igsid = ev.senderId; // o clique traz o ID de mensagem definitivo da pessoa
  run.context.continued = true;
  log.info('flow_resume', { automation: automation.name, node: nodeId, run: run.id });
  return execute({ run, automation, account, nodeId, ev });
}

// Quem chega por direct/story não vem com @ no webhook: busca no perfil (melhor esforço)
function fillUsername(account, igsid) {
  graph.getUserProfile(account.access_token, igsid)
    .then((p) => p?.username && contacts.setUsername(account.ig_user_id, igsid, p.username))
    .catch(() => null);
}

async function smokeTest(account, ev) {
  if (!matches(ev.text, ['teste'])) return;
  const token = account.access_token;
  const id = account.ig_user_id;
  if (ev.source === 'post_comment' || ev.source === 'live_comment') {
    await graph.replyToComment(token, ev.commentId, 'Te chamei no direct 👀');
    await graph.privateReply(token, id, ev.commentId, { text: '🚀 Funcionou! Essa DM saiu da automação nativa — sem ManyChat.' });
  } else if (['dm', 'story_reply'].includes(ev.source)) {
    await graph.sendMessage(token, id, ev.senderId, { text: `🚀 Recebi seu "${ev.text}". Automação nativa no ar!` });
  }
}
