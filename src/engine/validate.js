// Regras da Meta + regras do motor. Devolve lista de erros em linguagem de quem usa o painel.
const COMMENT_SOURCES = ['post_comment', 'live_comment'];
const SOURCES = ['post_comment', 'live_comment', 'dm', 'story_reply'];

export function validateAutomation(a) {
  const errs = [];
  if (!a.name?.trim()) errs.push('Dê um nome para a automação.');
  if (!a.sources?.length) errs.push('Escolha pelo menos um lugar onde a automação dispara.');
  if (a.sources?.some((s) => !SOURCES.includes(s))) errs.push('Origem desconhecida.');
  if (!['contains', 'exact', 'any'].includes(a.matchMode)) errs.push('Modo de palavra-chave inválido.');
  if (a.matchMode !== 'any' && !a.keywords?.filter((k) => k.trim()).length) errs.push('Adicione pelo menos uma palavra-chave.');

  const { nodes, start } = a.flow ?? {};
  if (!nodes || !nodes[start]) { errs.push('A automação precisa de pelo menos uma mensagem.'); return errs; }

  const gate = a.flow.followGate;
  if (gate) {
    if (!gate.text?.trim()) errs.push('Escreva a mensagem para quem ainda não te segue.');
    if (gate.text?.length > 640) errs.push('A mensagem para quem não te segue passa de 640 caracteres (limite do botão no Instagram).');
    if (!gate.button?.trim()) errs.push('Dê um texto para o botão "Já segui".');
    if (gate.button?.length > 20) errs.push('O botão de quem acabou de seguir passa de 20 caracteres.');
    if (!Object.values(nodes).some((n) => n.requireFollow)) errs.push('A trava de seguir precisa de pelo menos uma mensagem depois da primeira.');
  }

  for (const [id, n] of Object.entries(nodes)) {
    const where = n.type === 'card' ? `No cartão "${n.title || id}"` : `No bloco ${id}`;
    if (n.next && !nodes[n.next]) errs.push(`${where}: aponta para um bloco que não existe.`);
    if (n.type === 'comment_reply' && !n.variations?.filter((v) => v.trim()).length) errs.push('Escreva pelo menos uma resposta pública.');
    if (n.type === 'message' && !n.text?.trim()) errs.push(`${where}: a mensagem está vazia.`);
    if (n.type === 'message' && n.text?.length > 1000) errs.push(`${where}: a mensagem passa de 1000 caracteres (limite do Instagram).`);
    if (n.type === 'card') {
      if (!n.title?.trim()) errs.push('Todo cartão precisa de título.');
      if (n.title?.length > 80) errs.push(`${where}: o título passa de 80 caracteres.`);
      if (n.subtitle?.length > 80) errs.push(`${where}: o subtítulo passa de 80 caracteres.`);
      if (!n.buttons?.length) errs.push(`${where}: adicione pelo menos um botão de link.`);
    }
    if ((n.buttons?.length ?? 0) > 3) errs.push(`${where}: o Instagram aceita no máximo 3 botões.`);
    for (const b of n.buttons ?? []) {
      if (!b.title?.trim()) errs.push(`${where}: há um botão sem texto.`);
      if (b.title?.length > 20) errs.push(`${where}: o botão "${b.title}" passa de 20 caracteres.`);
      if (b.url !== undefined && !/^https:\/\/\S+$/.test(b.url)) errs.push(`${where}: o link do botão "${b.title}" precisa começar com https://`);
      if (b.next && !nodes[b.next]) errs.push(`${where}: o botão "${b.title}" não leva a nenhuma mensagem.`);
    }
    if (n.type === 'tag' && !n.tags?.length) errs.push('Bloco de etiqueta sem etiqueta.');
  }

  // Regra da Meta: a partir de um comentário só sai 1 DM até a pessoa interagir.
  if (a.sources?.some((s) => COMMENT_SOURCES.includes(s))) {
    let id = nodes[start].type === 'comment_reply' ? nodes[start].next : start;
    while (id && nodes[id]?.type === 'tag') id = nodes[id].next;
    const first = nodes[id];
    const rest = first && (first.next || first.buttons?.some((b) => b.next));
    if (first && rest && !first.wait) {
      errs.push('Quando dispara por comentário, o Instagram só deixa mandar 1 mensagem antes da pessoa responder. Coloque um botão de continuar na primeira mensagem.');
    }
  }
  return [...new Set(errs)];
}
