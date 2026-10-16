// Exemplo: a pessoa comenta EBOOK num post (ou manda no direct) → recebe a DM com o link do material.
// Copie este arquivo, troque textos e links, e rode `node --no-warnings scripts/seed.js`.
// Depois disso o painel passa a ser a fonte da verdade (o seed não sobrescreve sem --force).
const LINK = 'https://seudominio.com/ebook?utm_source=instagram&utm_medium=dm&utm_campaign=ebook';

export default {
  name: 'Exemplo — Ebook',
  sources: ['post_comment', 'live_comment', 'dm', 'story_reply'],
  mediaId: null, // null = qualquer post; ou o ID de um post específico
  keywords: ['ebook'],
  matchMode: 'contains',
  priority: 10,
  flow: {
    start: 'reply',
    nodes: {
      reply: {
        type: 'comment_reply',
        variations: [
          'Te mandei no direct! 📩',
          'Acabei de te chamar no direct 👀',
          'Chegou no seu direct, confere lá 👊',
        ],
        next: 'intro',
      },
      // Regra da Meta: depois de um comentário só sai 1 DM até a pessoa interagir — por isso o botão.
      intro: {
        type: 'message',
        text: 'Oi! 👋\n\nVi que você pediu o ebook. Posso te mandar o link?',
        buttons: [{ title: 'Quero o ebook 👉', next: 'etiqueta' }],
        wait: true,
        on_text: 'etiqueta', // se responder "sim" em vez de clicar, segue igual
      },
      etiqueta: { type: 'tag', tags: ['ebook'], next: 'entrega' },
      entrega: {
        type: 'card',
        delay: 2,
        title: 'Seu ebook está aqui',
        subtitle: 'Toque no botão para baixar 👇',
        buttons: [{ title: 'Baixar o ebook', url: LINK }],
      },
    },
  },
};
