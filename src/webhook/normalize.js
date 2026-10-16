// Converte o payload da Meta em eventos num formato único que o motor entende:
// { accountId, source, dedupeKey, senderId, senderUsername, text, mediaId, mediaType,
//   commentId, parentId, storyId, postbackPayload, quickReplyPayload, raw }

export function normalize(body) {
  const out = [];
  if (body?.object !== 'instagram') return out;

  for (const entry of body.entry ?? []) {
    const accountId = String(entry.id);

    // Comentários (post, reel, anúncio) e comentários de live
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (change.field === 'comments' || change.field === 'live_comments') {
        out.push({
          accountId,
          source: change.field === 'live_comments' ? 'live_comment' : 'post_comment',
          dedupeKey: `c:${v.id}`,
          senderId: v.from?.id,
          senderUsername: v.from?.username,
          text: v.text ?? '',
          mediaId: v.media?.id,
          mediaType: v.media?.media_product_type, // FEED | REELS | AD | STORY...
          commentId: v.id,
          parentId: v.parent_id,
          raw: change,
        });
      }
    }

    // Mensagens diretas, respostas/menções de story, cliques em botão, reações
    for (const m of entry.messaging ?? []) {
      const base = { accountId, senderId: m.sender?.id, raw: m };

      if (m.message) {
        if (m.message.is_echo) continue; // mensagem que nós mesmos enviamos
        const msg = m.message;
        const mention = (msg.attachments ?? []).find((a) => a.type === 'story_mention');
        let source = 'dm';
        if (mention) source = 'story_mention';
        else if (msg.reply_to?.story) source = 'story_reply';
        out.push({
          ...base,
          source,
          dedupeKey: `m:${msg.mid}`,
          text: msg.text ?? '',
          storyId: msg.reply_to?.story?.id,
          quickReplyPayload: msg.quick_reply?.payload,
          attachments: msg.attachments ?? [],
        });
      } else if (m.postback) {
        out.push({
          ...base,
          source: 'postback',
          dedupeKey: `p:${m.postback.mid ?? `${m.sender?.id}:${m.timestamp}`}`,
          text: m.postback.title ?? '',
          postbackPayload: m.postback.payload,
        });
      } else if (m.reaction) {
        out.push({
          ...base,
          source: 'reaction',
          dedupeKey: `r:${m.reaction.mid}:${m.reaction.action}:${m.timestamp}`,
          text: m.reaction.emoji ?? m.reaction.reaction ?? '',
        });
      }
      // messaging_seen / read: ignorados por enquanto
    }
  }
  return out;
}
