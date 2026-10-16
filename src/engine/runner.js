import { log } from '../logger.js';
import { runs, contacts } from '../db.js';
import * as graph from '../meta/graph.js';
import { sendNode } from './send.js';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const MAX_STEPS = 30; // trava de segurança contra fluxo em loop

// Trava "precisa me seguir": na dúvida (erro da API) entrega, para não perder o lead
async function follows(account, igsid) {
  if (config.dryRun) return true;
  try {
    const p = await graph.getUserProfile(account.access_token, igsid);
    return p?.is_user_follow_business === true;
  } catch (e) {
    log.warn('follow_check_failed', { err: e.message });
    return true;
  }
}

// Executa o fluxo a partir de `nodeId` até terminar ou parar esperando a pessoa.
export async function execute({ run, automation, account, nodeId, ev }) {
  const { nodes } = automation.flow;
  const ctx = run.context;
  let current = nodeId;

  for (let step = 0; current && step < MAX_STEPS; step++) {
    const node = { id: current, ...nodes[current] };
    if (!nodes[current]) {
      log.error('flow_missing_node', { automation: automation.name, node: current });
      break;
    }

    if (node.delay) {
      if (ctx.igsid) graph.typing(account.access_token, account.ig_user_id, ctx.igsid);
      await sleep(node.delay * 1000);
    }

    switch (node.type) {
      case 'comment_reply':
        if (ev?.commentId) {
          await graph.replyToComment(account.access_token, ev.commentId, pick(node.variations));
        }
        break;

      case 'message':
      case 'card': {
        // Bloco travado: quem não segue recebe o aviso com "Já segui", que volta para este mesmo bloco
        const gate = automation.flow.followGate;
        if (node.requireFollow && gate && ctx.igsid && !(await follows(account, ctx.igsid))) {
          await sendNode({
            account,
            automationId: automation.id,
            node: { id: `${current}-gate`, type: 'message', text: gate.text, buttons: [{ title: gate.button, next: current }] },
            run,
            to: { igsid: ctx.igsid },
          });
          ctx.sentAny = true;
          ctx.gateShown = (ctx.gateShown ?? 0) + 1;
          ctx.gateAt = current;
          if (ctx.igsid) contacts.addTags(account.ig_user_id, ctx.igsid, ['nao-seguia']);
          runs.update(run.id, { currentNode: current, status: 'waiting', context: ctx });
          log.info('flow_follow_gate', { automation: automation.name, node: current, times: ctx.gateShown });
          return;
        }
        delete ctx.gateAt;
        // A primeira mensagem de um fluxo vindo de comentário sai como DM privada (1 por comentário)
        const usePrivate = ctx.commentId && !ctx.privateReplyUsed;
        await sendNode({
          account,
          automationId: automation.id,
          node,
          run,
          to: usePrivate ? { commentId: ctx.commentId } : { igsid: ctx.igsid },
        });
        if (usePrivate) ctx.privateReplyUsed = true;
        ctx.sentAny = true;

        // Bloco com botão de continuar: para e espera o clique (ou uma resposta em texto)
        if (node.wait) {
          runs.update(run.id, { currentNode: current, status: 'waiting', context: ctx });
          log.info('flow_waiting', { automation: automation.name, node: current });
          return;
        }
        break;
      }

      case 'tag':
        if (ctx.igsid) contacts.addTags(account.ig_user_id, ctx.igsid, node.tags);
        break;

      default:
        log.error('flow_unknown_node_type', { type: node.type, node: current });
    }

    runs.update(run.id, { currentNode: current, status: 'running', context: ctx });
    current = node.next;
  }

  runs.update(run.id, { currentNode: current ?? null, status: 'done', context: ctx });
  log.info('flow_done', { automation: automation.name, run: run.id });
}
