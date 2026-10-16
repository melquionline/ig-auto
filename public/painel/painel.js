// Painel de automações — SPA sem build. Rotas por hash: #/automacoes, #/automacoes/novo, #/automacoes/:id, #/leads
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
let ME = { username: '' }; // conta logada (preenchida no boot)

const SOURCES = [
  { id: 'post_comment', label: 'Comentar em post ou reel', short: 'Comentário' },
  { id: 'live_comment', label: 'Comentar na live', short: 'Live' },
  { id: 'dm', label: 'Mandar no direct', short: 'Direct' },
  { id: 'story_reply', label: 'Responder story', short: 'Story' },
];
const COMMENT_SOURCES = ['post_comment', 'live_comment'];
const MATCH = [
  { id: 'contains', label: 'contém a palavra' },
  { id: 'exact', label: 'é exatamente a palavra' },
  { id: 'any', label: 'qualquer mensagem' },
];
const DELAYS = [0, 1, 2, 3, 5, 10, 20];

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`api/${path}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error('login'); }
  if (!res.ok) { const e = new Error(data.error || 'Algo deu errado.'); e.data = data; throw e; }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}

function ago(ts) {
  if (!ts) return '—';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d < 30 ? `há ${d} dia${d > 1 ? 's' : ''}` : new Date(ts).toLocaleDateString('pt-BR');
}

// ---------- Fluxo ⇄ blocos lineares ----------
// O motor guarda um grafo; o painel edita uma sequência. Ids dos blocos existentes são preservados
// para não quebrar botões de quem está no meio de um fluxo.
function flowToForm(flow) {
  const nodes = flow?.nodes ?? {};
  let id = flow?.start;
  let replies = [];
  if (nodes[id]?.type === 'comment_reply') { replies = [...nodes[id].variations]; id = nodes[id].next; }
  const blocks = [];
  const seen = new Set();
  while (id && nodes[id] && !seen.has(id)) {
    seen.add(id);
    const n = nodes[id];
    const cont = n.buttons?.find((b) => b.next);
    blocks.push({
      id, kind: n.type,
      text: n.text ?? '', delay: n.delay ?? 0,
      title: n.title ?? '', subtitle: n.subtitle ?? '', image_url: n.image_url ?? '',
      tags: n.tags ?? [],
      continueTitle: n.wait && cont ? cont.title : '',
      links: (n.buttons ?? []).filter((b) => b.url).map((b) => ({ title: b.title, url: b.url })),
    });
    id = n.next ?? cont?.next;
  }
  const gate = flow?.followGate;
  return { replies, blocks, gateOn: !!gate, gateText: gate?.text ?? GATE_TEXT, gateButton: gate?.button ?? GATE_BUTTON };
}

const GATE_TEXT = 'Pra liberar, é só me seguir aqui no Instagram 🙏\n\nAssim que seguir, toca no botão abaixo que eu te mando na hora.';
const GATE_BUTTON = 'Já segui ✅';

function formToFlow({ replies, blocks, gateOn, gateText, gateButton }, useReplies) {
  const nodes = {};
  const ids = blocks.map((b) => b.id || `b${Math.random().toString(36).slice(2, 8)}`);
  blocks.forEach((b, i) => {
    const next = ids[i + 1];
    const links = b.links.filter((l) => l.title || l.url).map((l) => ({ title: l.title.trim(), url: l.url.trim() }));
    if (b.kind === 'tag') {
      nodes[ids[i]] = { type: 'tag', tags: b.tags, ...(next && { next }) };
    } else if (b.kind === 'card') {
      nodes[ids[i]] = { type: 'card', title: b.title, subtitle: b.subtitle || undefined, image_url: b.image_url || undefined,
        delay: b.delay || undefined, buttons: links, ...(next && { next }) };
    } else {
      const cont = b.continueTitle.trim() && next;
      nodes[ids[i]] = {
        type: 'message', text: b.text, delay: b.delay || undefined,
        buttons: [...(cont ? [{ title: b.continueTitle.trim(), next }] : []), ...links],
        ...(cont ? { wait: true, on_text: next } : next ? { next } : {}),
      };
      if (!nodes[ids[i]].buttons.length) delete nodes[ids[i]].buttons;
    }
  });
  // Trava de seguir: vale para toda mensagem depois da primeira (antes do clique a Meta ainda não diz quem é)
  if (gateOn) {
    blocks.filter((b) => b.kind !== 'tag').slice(1).forEach((b) => { nodes[ids[blocks.indexOf(b)]].requireFollow = true; });
  }
  let start = ids[0];
  const cleanReplies = replies.map((r) => r.trim()).filter(Boolean);
  if (useReplies && cleanReplies.length) {
    nodes.reply = { type: 'comment_reply', variations: cleanReplies, ...(ids[0] && { next: ids[0] }) };
    start = 'reply';
  }
  return { start, nodes, ...(gateOn && { followGate: { text: gateText.trim(), button: gateButton.trim() } }) };
}

// ---------- Roteamento ----------
async function route() {
  const [, section = 'automacoes', id] = location.hash.split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  view.innerHTML = '<p class="loading">Carregando…</p>';
  try {
    if (section === 'leads') await renderLeads();
    else if (id) await renderEditor(id === 'novo' ? null : Number(id));
    else await renderList();
  } catch (e) {
    if (e.message !== 'login') view.innerHTML = `<div class="errors">${esc(e.message)}</div>`;
  }
  view.focus({ preventScroll: true });
}

// ---------- Lista de automações ----------
function funnelHtml(a) {
  const s = a.stats;
  const base = Math.max(s.runs, 1);
  const hasContinue = Object.values(a.flow.nodes).some((n) => n.wait);
  const steps = [
    { n: s.runs, label: 'Disparos' },
    ...(hasContinue ? [{ n: s.continued, label: 'Seguiram a conversa' }] : []),
    ...linkTitles(a).map((t) => ({ n: s.clicks.find((c) => c.title === t)?.people ?? 0, label: `Clicaram em ${t}` })),
  ];
  return `<div class="funnel" style="--steps:${steps.length}">${steps.map((st, i) => `
    <div class="step">
      <span class="step-n">${st.n}</span>
      <span class="step-label" title="${esc(st.label)}">${esc(st.label)}</span>
      <span class="step-bar"><i style="width:${i === 0 ? (s.runs ? 100 : 0) : Math.round((st.n / base) * 100)}%"></i></span>
      ${i > 0 && s.runs ? `<span class="step-pct">${Math.round((st.n / base) * 100)}%</span>` : ''}
    </div>`).join('')}</div>`;
}
const linkTitles = (a) => [...new Set(Object.values(a.flow.nodes).flatMap((n) => (n.buttons ?? []).filter((b) => b.url).map((b) => b.title)))];

async function renderList() {
  const list = await api('automations');
  view.innerHTML = `
    <header class="page-head">
      <div><h1>Automações</h1><p>Quem comentar, mandar direct ou responder story com a palavra certa recebe a conversa na hora.</p></div>
      <a class="btn btn--accent" href="#/automacoes/novo">Nova automação</a>
    </header>
    ${list.length ? `<div class="auto-list">${list.map((a) => `
      <article class="auto ${a.active ? '' : 'is-off'}" data-open="${a.id}">
        <div>
          <div class="auto-name">${esc(a.name)}</div>
          <div class="auto-meta">
            ${a.matchMode === 'any' ? '<span class="kw">qualquer mensagem</span>' : a.keywords.map((k) => `<span class="kw">${esc(k)}</span>`).join('')}
            <span>${a.sources.map((s) => SOURCES.find((x) => x.id === s)?.short).join(' · ')}</span>
            <span>${a.mediaId ? 'Um conteúdo específico' : a.sources.every((x) => x === 'story_reply') ? 'Qualquer story' : 'Qualquer post'}</span>
            ${a.stats.last_run_at ? `<span>Último disparo ${ago(a.stats.last_run_at)}</span>` : ''}
          </div>
        </div>
        <label class="switch" data-stop>
          <input type="checkbox" data-toggle="${a.id}" ${a.active ? 'checked' : ''} aria-label="Automação ligada">
          <span class="track"></span><span data-state>${a.active ? 'Ligada' : 'Desligada'}</span>
        </label>
        <div class="auto-funnel">${funnelHtml(a)}</div>
      </article>`).join('')}</div>`
    : `<div class="empty">
        <h2>Nenhuma automação ainda</h2>
        <p>Escolha a palavra que o público vai comentar e escreva a conversa que ele recebe no direct.</p>
        <a class="btn btn--accent" href="#/automacoes/novo">Criar a primeira automação</a>
      </div>`}`;

  view.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]')) return;
    location.hash = `#/automacoes/${el.dataset.open}`;
  }));
  view.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('change', async () => {
    const card = el.closest('.auto');
    try {
      await api(`automations/${el.dataset.toggle}/active`, { method: 'PATCH', body: { active: el.checked } });
      card.classList.toggle('is-off', !el.checked);
      card.querySelector('[data-state]').textContent = el.checked ? 'Ligada' : 'Desligada';
      toast(el.checked ? 'Automação ligada' : 'Automação desligada');
    } catch (e) { el.checked = !el.checked; toast(e.message); }
  }));
}

// ---------- Editor ----------
const blank = () => ({
  name: '', active: true, sources: ['post_comment'], mediaId: null, media: null, keywords: [], matchMode: 'contains',
  replies: ['Te mandei no direct! 📩', 'Acabei de te chamar no direct 👊'],
  blocks: [{ id: '', kind: 'message', text: '', delay: 0, continueTitle: 'Quero ver 👉', links: [], title: '', subtitle: '', image_url: '', tags: [] }],
  gateOn: false, gateText: GATE_TEXT, gateButton: GATE_BUTTON,
});

let state;

async function renderEditor(id) {
  if (id) {
    const a = await api(`automations/${id}`);
    state = { ...a, media: a.flow.meta?.media ?? null, ...flowToForm(a.flow) };
  } else {
    state = blank();
  }
  state.id = id;

  view.innerHTML = `
    <header class="page-head">
      <div>
        <a class="link-btn" href="#/automacoes">← Automações</a>
        <input class="input input--name" id="f-name" placeholder="Nome da automação" value="${esc(state.name)}" aria-label="Nome da automação" style="margin-top:10px">
      </div>
      <label class="switch"><input type="checkbox" id="f-active" ${state.active ? 'checked' : ''}><span class="track"></span><span>Ligada</span></label>
    </header>
    <div class="editor">
      <div class="form">
        <section class="sec">
          <div class="sec-head"><h2>Quando alguém…</h2></div>
          <div class="pills" id="f-sources">${SOURCES.map((s) => `
            <label class="pill"><input type="checkbox" value="${s.id}" ${state.sources.includes(s.id) ? 'checked' : ''}><span>${s.label}</span></label>`).join('')}
          </div>
          <div class="field" style="margin-top:18px">
            <span class="label">Em qual conteúdo</span>
            <div class="media-pick" id="f-media"></div>
          </div>
        </section>

        <section class="sec">
          <div class="sec-head"><h2>…com a palavra</h2></div>
          <div class="row" style="margin-bottom:10px">
            <span class="muted">A mensagem</span>
            <select class="select" id="f-match" style="width:auto">${MATCH.map((m) => `<option value="${m.id}" ${state.matchMode === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
          </div>
          <div class="chips" id="f-keywords"></div>
          <p class="sec-hint" style="margin:8px 0 0">Maiúscula, acento e emoji não fazem diferença. Aperte Enter para adicionar.</p>
        </section>

        <section class="sec" id="sec-replies">
          <div class="sec-head"><h2>Resposta pública no comentário</h2></div>
          <p class="sec-hint">Uma delas é sorteada a cada comentário, para não parecer robô.</p>
          <div id="f-replies"></div>
          <div class="add-row"><button class="btn btn--small" type="button" id="add-reply">+ Outra variação</button></div>
        </section>

        <section class="sec">
          <div class="sec-head"><h2>Conversa no direct</h2></div>
          <p class="sec-hint">As mensagens saem nesta ordem. O Instagram só libera a segunda mensagem depois que a pessoa interage — por isso a primeira leva um botão de continuar.</p>
          <div class="blocks" id="f-blocks"></div>
          <div class="add-row">
            <button class="btn btn--small" type="button" data-add="message">+ Mensagem</button>
            <button class="btn btn--small" type="button" data-add="card">+ Cartão com links</button>
            <button class="btn btn--small" type="button" data-add="tag">+ Etiqueta</button>
          </div>
        </section>

        <section class="sec">
          <div class="sec-head"><h2>Só para quem me segue</h2>
            <label class="switch"><input type="checkbox" id="f-gate" ${state.gateOn ? 'checked' : ''}><span class="track"></span><span>Trava ligada</span></label>
          </div>
          <p class="sec-hint">A primeira mensagem sai para todo mundo. Da segunda em diante, quem ainda não te segue recebe o aviso abaixo e só continua depois de seguir.</p>
          <div id="f-gate-fields" ${state.gateOn ? '' : 'hidden'}>
            <div class="field"><span class="label">Aviso para quem não segue</span>
              <textarea class="input" id="f-gate-text" rows="3">${esc(state.gateText)}</textarea></div>
            <div class="field" style="margin-top:10px"><span class="label">Botão depois de seguir (até 20 caracteres)</span>
              <input class="input" id="f-gate-button" maxlength="20" value="${esc(state.gateButton)}"></div>
          </div>
        </section>

        <div class="savebar">
          <div id="f-errors"></div>
          <div class="row">
            <button class="btn btn--accent" type="button" id="save">Salvar automação</button>
            ${id ? '<button class="btn btn--danger" type="button" id="delete">Excluir</button>' : ''}
          </div>
        </div>
      </div>

      <div class="phone-wrap">
        <div class="phone"><div class="screen">
          <div class="screen-top"><span class="avatar">${esc(ME.username.slice(0, 1).toUpperCase())}</span><div><b>${esc(ME.username)}</b><small>Como o lead vê</small></div></div>
          <div class="thread" id="preview"></div>
        </div></div>
        <button class="btn btn--small" type="button" id="play">▶ Reproduzir a conversa</button>
      </div>
    </div>`;

  bindEditor();
  renderMedia(); renderKeywords(); renderReplies(); renderBlocks(); renderPreview();
}

function bindEditor() {
  $('#f-name').addEventListener('input', (e) => { state.name = e.target.value; });
  $('#f-active').addEventListener('change', (e) => { state.active = e.target.checked; });
  $('#f-sources').addEventListener('change', () => {
    state.sources = [...$('#f-sources').querySelectorAll('input:checked')].map((i) => i.value);
    renderReplies(); renderPreview();
  });
  $('#f-match').addEventListener('change', (e) => { state.matchMode = e.target.value; renderKeywords(); renderPreview(); });
  $('#add-reply').addEventListener('click', () => { state.replies.push(''); renderReplies(); $('#f-replies textarea:last-of-type')?.focus(); });
  view.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    state.blocks.push({ id: '', kind: b.dataset.add, text: '', delay: state.blocks.length ? 5 : 0, continueTitle: '', links: b.dataset.add === 'card' ? [{ title: '', url: '' }] : [],
      title: '', subtitle: '', image_url: '', tags: [] });
    renderBlocks(); renderPreview();
  }));
  $('#f-gate').addEventListener('change', (e) => { state.gateOn = e.target.checked; $('#f-gate-fields').hidden = !state.gateOn; });
  $('#f-gate-text').addEventListener('input', (e) => { state.gateText = e.target.value; });
  $('#f-gate-button').addEventListener('input', (e) => { state.gateButton = e.target.value; });
  $('#save').addEventListener('click', save);
  $('#delete')?.addEventListener('click', remove);
  $('#play').addEventListener('click', () => renderPreview(true));
}

function renderMedia() {
  const el = $('#f-media');
  el.innerHTML = state.mediaId
    ? `${state.media?.thumb ? `<img class="media-thumb" src="${esc(state.media.thumb)}" alt="">` : ''}
       <div><div>${esc(state.media?.caption?.slice(0, 70) || 'Post escolhido')}</div>
       <div class="row" style="margin-top:6px"><button class="link-btn" type="button" data-pick>Trocar</button><button class="link-btn" type="button" data-any>Usar em qualquer post</button></div></div>`
    : `<span>Qualquer post, reel ou story</span><button class="link-btn" type="button" data-pick>Escolher um específico</button>`;
  el.querySelector('[data-pick]').addEventListener('click', openPicker);
  el.querySelector('[data-any]')?.addEventListener('click', () => { state.mediaId = null; state.media = null; renderMedia(); });
}

async function openPicker() {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="Escolher conteúdo">
    <div class="modal-head"><h2>Escolha o conteúdo</h2><button class="icon-btn" type="button" data-close aria-label="Fechar">✕</button></div>
    <div id="pick-body"><p class="loading">Buscando seus posts…</p></div></div>`;
  document.body.append(m);
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); });
  try {
    const { posts, stories, error } = await api('media');
    const tile = (x) => `<button class="tile" type="button" data-id="${esc(x.id)}"><img src="${esc(x.thumb ?? '')}" alt="" loading="lazy"><small>${esc(x.kind === 'story' ? 'Story ativo' : x.caption || x.type)}</small></button>`;
    $('#pick-body', m).innerHTML = `
      ${error ? `<div class="errors">${esc(error)}</div>` : ''}
      ${stories.length ? `<p class="eyebrow" style="margin:0 0 10px">Stories no ar</p><div class="grid" style="margin-bottom:20px">${stories.map(tile).join('')}</div>` : ''}
      <p class="eyebrow" style="margin:0 0 10px">Posts e reels</p>
      <div class="grid">${posts.map(tile).join('') || '<p class="muted">Nenhum post encontrado.</p>'}</div>`;
    const all = [...posts, ...stories];
    m.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => {
      const x = all.find((p) => p.id === b.dataset.id);
      state.mediaId = x.id;
      state.media = { id: x.id, thumb: x.thumb, caption: x.caption, permalink: x.permalink, kind: x.kind };
      renderMedia(); close();
    }));
  } catch (e) { $('#pick-body', m).innerHTML = `<div class="errors">${esc(e.message)}</div>`; }
}

function renderKeywords() {
  const el = $('#f-keywords');
  if (state.matchMode === 'any') {
    el.innerHTML = '<span class="muted" style="padding:4px">Dispara com qualquer comentário ou mensagem — use com cuidado.</span>';
    return;
  }
  el.innerHTML = state.keywords.map((k, i) => `<span class="kw">${esc(k)}<button type="button" data-rm="${i}" aria-label="Remover ${esc(k)}">×</button></span>`).join('') +
    `<input id="kw-input" placeholder="${state.keywords.length ? 'Outra palavra…' : 'Ex.: ebook'}" aria-label="Nova palavra-chave">`;
  const input = $('#kw-input');
  const add = () => {
    const v = input.value.trim().replace(/,$/, '');
    if (v && !state.keywords.includes(v)) state.keywords.push(v);
    renderKeywords(); renderPreview(); $('#kw-input').focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    if (e.key === 'Backspace' && !input.value && state.keywords.length) { state.keywords.pop(); renderKeywords(); renderPreview(); $('#kw-input').focus(); }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) add(); });
  el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { state.keywords.splice(+b.dataset.rm, 1); renderKeywords(); renderPreview(); }));
}

const hasComments = () => state.sources.some((s) => COMMENT_SOURCES.includes(s));

function renderReplies() {
  $('#sec-replies').hidden = !hasComments();
  $('#f-replies').innerHTML = state.replies.map((r, i) => `
    <div class="row" style="margin-bottom:8px; flex-wrap:nowrap">
      <input class="input" data-reply="${i}" value="${esc(r)}" placeholder="Ex.: Te mandei no direct! 📩" aria-label="Variação ${i + 1}">
      <button class="icon-btn" type="button" data-rm-reply="${i}" aria-label="Remover variação" ${state.replies.length < 2 ? 'disabled' : ''}>✕</button>
    </div>`).join('');
  view.querySelectorAll('[data-reply]').forEach((el) => el.addEventListener('input', () => { state.replies[+el.dataset.reply] = el.value; renderPreview(); }));
  view.querySelectorAll('[data-rm-reply]').forEach((el) => el.addEventListener('click', () => { state.replies.splice(+el.dataset.rmReply, 1); renderReplies(); renderPreview(); }));
}

const KIND = { message: 'Mensagem', card: 'Cartão com links', tag: 'Etiqueta' };

function renderBlocks() {
  const el = $('#f-blocks');
  let msgIndex = 0;
  el.innerHTML = state.blocks.map((b, i) => {
    const isLast = i === state.blocks.length - 1;
    const n = b.kind === 'tag' ? '' : `<b>${++msgIndex}</b> · `;
    const delay = b.kind === 'tag' ? '' : `
      <select class="select" data-f="delay" style="width:auto" aria-label="Pausa antes">${DELAYS.map((d) => `<option value="${d}" ${+b.delay === d ? 'selected' : ''}>${d ? `espera ${d}s` : 'sem pausa'}</option>`).join('')}</select>`;
    let body = '';
    if (b.kind === 'message') {
      body = `
        <textarea class="textarea" data-f="text" placeholder="Escreva a mensagem…" aria-label="Texto da mensagem">${esc(b.text)}</textarea>
        <div class="row" style="justify-content:flex-end"><span class="count ${b.text.length > 1000 ? 'over' : ''}">${b.text.length}/1000</span></div>
        ${isLast ? '' : `
        <div class="continue ${b.continueTitle ? 'on' : ''}">
          <label class="switch"><input type="checkbox" data-f="continue" ${b.continueTitle ? 'checked' : ''}><span class="track"></span>
            <span>Esperar a pessoa tocar num botão antes de seguir</span></label>
          ${b.continueTitle ? `<input class="input" data-f="continueTitle" value="${esc(b.continueTitle)}" maxlength="20" placeholder="Texto do botão" aria-label="Texto do botão de continuar">` : ''}
        </div>`}
        ${linksHtml(b)}`;
    } else if (b.kind === 'card') {
      body = `
        <div class="field"><span class="label">Título <span class="count ${b.title.length > 80 ? 'over' : ''}">${b.title.length}/80</span></span>
          <input class="input" data-f="title" value="${esc(b.title)}" placeholder="Ex.: Seu ebook está aqui"></div>
        <div class="field"><span class="label">Subtítulo <span class="count ${b.subtitle.length > 80 ? 'over' : ''}">${b.subtitle.length}/80</span></span>
          <input class="input" data-f="subtitle" value="${esc(b.subtitle)}" placeholder="Opcional"></div>
        <div class="field"><span class="label">Imagem (link https)</span>
          <input class="input" data-f="image_url" value="${esc(b.image_url)}" placeholder="Opcional — https://…"></div>
        ${linksHtml(b)}`;
    } else {
      body = `<input class="input" data-f="tags" value="${esc(b.tags.join(', '))}" placeholder="Ex.: ebook, lead-quente" aria-label="Etiquetas separadas por vírgula">
        <p class="sec-hint" style="margin:8px 0 0">Aparece na lista de leads. Separe por vírgula.</p>`;
    }
    return `<div class="block" data-i="${i}">
      <div class="block-head">
        <span class="block-kind">${n}${KIND[b.kind]}</span>${delay}
        <button class="icon-btn" type="button" data-mv="-1" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" type="button" data-mv="1" aria-label="Descer" ${isLast ? 'disabled' : ''}>↓</button>
        <button class="icon-btn" type="button" data-rm-block aria-label="Remover bloco">✕</button>
      </div>${body}</div>`;
  }).join('');

  // Caixa de texto cresce com a mensagem
  const fit = (t) => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; };
  el.querySelectorAll('textarea').forEach((t) => { fit(t); t.addEventListener('input', () => fit(t)); });

  el.querySelectorAll('.block').forEach((blockEl) => {
    const b = state.blocks[+blockEl.dataset.i];
    blockEl.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      if (!f || f === 'continue' || f === 'delay') return;
      if (f === 'tags') b.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean);
      else if (f === 'link-title') b.links[+e.target.dataset.l].title = e.target.value;
      else if (f === 'link-url') b.links[+e.target.dataset.l].url = e.target.value;
      else b[f] = e.target.value;
      const count = e.target.closest('.field, .block')?.querySelector('.count');
      if (count && (f === 'text' || f === 'title' || f === 'subtitle')) {
        const max = f === 'text' ? 1000 : 80;
        count.textContent = `${b[f].length}/${max}`;
        count.classList.toggle('over', b[f].length > max);
      }
      renderPreview();
    });
    blockEl.addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      if (f === 'delay') { b.delay = +e.target.value; renderPreview(); }
      if (f === 'continue') { b.continueTitle = e.target.checked ? 'Quero ver 👉' : ''; renderBlocks(); renderPreview(); }
    });
    blockEl.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const i = +blockEl.dataset.i;
      if (t.dataset.mv) {
        const j = i + +t.dataset.mv;
        [state.blocks[i], state.blocks[j]] = [state.blocks[j], state.blocks[i]];
      } else if (t.hasAttribute('data-rm-block')) {
        state.blocks.splice(i, 1);
      } else if (t.hasAttribute('data-add-link')) {
        b.links.push({ title: '', url: '' });
      } else if (t.dataset.rmLink !== undefined) {
        b.links.splice(+t.dataset.rmLink, 1);
      } else return;
      renderBlocks(); renderPreview();
    });
  });
}

function linksHtml(b) {
  const room = 3 - b.links.length - (b.continueTitle ? 1 : 0);
  return `<div class="sub-label">Botões com link</div>
    ${b.links.map((l, j) => `<div class="btn-row">
      <input class="input" data-f="link-title" data-l="${j}" value="${esc(l.title)}" maxlength="20" placeholder="Texto do botão">
      <input class="input" data-f="link-url" data-l="${j}" value="${esc(l.url)}" placeholder="https://…" inputmode="url">
      <button class="icon-btn" type="button" data-rm-link="${j}" aria-label="Remover botão">✕</button></div>`).join('')}
    ${room > 0 ? `<button class="link-btn" type="button" data-add-link style="margin-top:8px">+ Botão com link</button>` : ''}`;
}

// ---------- Pré-visualização (o celular) ----------
let playToken = 0;
function previewItems() {
  const items = [];
  const kw = state.matchMode === 'any' ? 'oi!' : (state.keywords[0] || 'palavra');
  const replies = state.replies.map((r) => r.trim()).filter(Boolean);
  if (hasComments()) {
    items.push({ html: '<div class="stamp">No post</div>' });
    items.push({ html: `<div class="comment"><span class="avatar avatar--lead">DR</span><div><b>dr.cliente</b>${esc(kw)}</div></div>` });
    if (replies[0]) items.push({ html: `<div class="comment comment--reply"><span class="avatar">${esc(ME.username.slice(0, 1).toUpperCase())}</span><div><b>${esc(ME.username)}</b>${esc(replies[0])}</div></div>`, wait: 600 });
    items.push({ html: '<div class="stamp">No direct</div>' });
  } else {
    items.push({ html: '<div class="stamp">Hoje</div>' });
    items.push({ html: `<div class="bubble bubble--out">${esc(kw)}</div>` });
  }
  state.blocks.forEach((b, i) => {
    const wait = Math.min((b.delay || 1) * 250, 1500);
    if (b.kind === 'tag') {
      if (b.tags.length) items.push({ html: `<div class="tagline">etiqueta: ${esc(b.tags.join(', '))}</div>` });
      return;
    }
    const cont = b.kind === 'message' && b.continueTitle && i < state.blocks.length - 1;
    const btns = [...(cont ? [`<span class="is-next">${esc(b.continueTitle)}</span>`] : []), ...b.links.filter((l) => l.title).map((l) => `<span>${esc(l.title)}</span>`)];
    if (b.kind === 'card') {
      items.push({ typing: true, wait, html: `<div class="ig-card">${b.image_url ? `<img src="${esc(b.image_url)}" alt="">` : '<div class="ph"></div>'}
        <div class="t">${esc(b.title || 'Título do cartão')}</div>${b.subtitle ? `<div class="s">${esc(b.subtitle)}</div>` : ''}
        ${btns.length ? `<div class="bubble-btns">${btns.join('')}</div>` : ''}</div>` });
    } else {
      items.push({ typing: i > 0, wait, html: `<div class="bubble bubble--in">${esc(b.text || '…')}</div>${btns.length ? `<div class="bubble-btns">${btns.join('')}</div>` : ''}` });
    }
    if (cont) items.push({ html: `<div class="bubble bubble--out">${esc(b.continueTitle)}</div>`, wait: 700 });
  });
  return items;
}

async function renderPreview(animate = false) {
  const el = $('#preview');
  if (!el) return;
  const token = ++playToken;
  const items = previewItems();
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.innerHTML = items.map((i) => i.html).join('');
    return;
  }
  el.innerHTML = '';
  for (const it of items) {
    if (token !== playToken) return;
    if (it.typing) {
      const t = document.createElement('div');
      t.className = 'typing enter'; t.innerHTML = '<i></i><i></i><i></i>';
      el.append(t); el.scrollTop = el.scrollHeight;
      await new Promise((r) => setTimeout(r, it.wait));
      t.remove();
    } else if (it.wait) {
      await new Promise((r) => setTimeout(r, it.wait));
    }
    if (token !== playToken) return;
    const wrap = document.createElement('div');
    wrap.style.display = 'contents';
    wrap.innerHTML = it.html;
    [...wrap.children].forEach((c) => c.classList.add('enter'));
    el.append(...wrap.children);
    el.scrollTop = el.scrollHeight;
  }
}

// ---------- Salvar / excluir ----------
async function save() {
  const btn = $('#save');
  const body = {
    name: state.name, active: state.active, sources: state.sources, mediaId: state.mediaId,
    keywords: state.keywords, matchMode: state.matchMode,
    flow: { ...formToFlow(state, hasComments()), meta: { media: state.media } },
  };
  btn.disabled = true;
  $('#f-errors').innerHTML = '';
  try {
    const { id } = await api(state.id ? `automations/${state.id}` : 'automations', { method: state.id ? 'PUT' : 'POST', body });
    toast('Automação salva');
    if (!state.id) location.hash = `#/automacoes/${id}`;
    else { const fresh = await api(`automations/${id}`); Object.assign(state, flowToForm(fresh.flow)); renderBlocks(); }
  } catch (e) {
    const errs = e.data?.errors ?? [e.message];
    $('#f-errors').innerHTML = `<div class="errors"><b>Falta ajustar antes de salvar:</b><ul>${errs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  } finally { btn.disabled = false; }
}

async function remove() {
  const btn = $('#delete');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Toque de novo para excluir';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Excluir'; }, 3000);
    return;
  }
  await api(`automations/${state.id}`, { method: 'DELETE' });
  toast('Automação excluída');
  location.hash = '#/automacoes';
}

// ---------- Leads ----------
async function renderLeads() {
  const rows = await api('leads');
  view.innerHTML = `
    <header class="page-head"><div><h1>Leads</h1><p>${rows.length} pessoa${rows.length === 1 ? '' : 's'} que interagiram com as automações.</p></div></header>
    ${rows.length ? `
    <div class="toolbar"><input class="input" id="q" placeholder="Buscar por @, etiqueta ou automação" aria-label="Buscar"></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Pessoa</th><th>Automação</th><th>Etiquetas</th><th>Clicou em</th><th>Última interação</th><th></th></tr></thead>
      <tbody id="rows"></tbody></table></div>`
    : `<div class="empty"><h2>Ninguém por aqui ainda</h2><p>Quando alguém disparar uma automação, aparece nesta lista com as etiquetas e os links em que clicou.</p></div>`}`;
  if (!rows.length) return;
  const draw = (q = '') => {
    const f = q.toLowerCase();
    $('#rows').innerHTML = rows.filter((r) => !f || [r.username, ...r.tags, ...r.automations].join(' ').toLowerCase().includes(f)).map((r) => `
      <tr>
        <td class="who">${r.username ? `<a href="https://instagram.com/${esc(r.username)}" target="_blank" rel="noopener">@${esc(r.username)}</a>` : '<span class="muted">sem @ ainda</span>'}</td>
        <td>${r.automations.map(esc).join('<br>') || '<span class="muted">—</span>'}</td>
        <td>${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted">—</span>'}</td>
        <td>${r.clicked.map((c) => `<span class="clicked">✓ ${esc(c)}</span>`).join('<br>') || '<span class="muted">—</span>'}</td>
        <td class="muted">${ago(r.last_run_at ?? r.last_inbound_at ?? r.first_seen_at)}</td>
        <td>${r.username ? `<a class="btn btn--small" href="https://ig.me/m/${esc(r.username)}" target="_blank" rel="noopener">Abrir direct</a>` : ''}</td>
      </tr>`).join('');
  };
  draw();
  $('#q').addEventListener('input', (e) => draw(e.target.value));
}

// ---------- Início ----------
function showLogin() { $('#shell').hidden = true; $('#login').hidden = false; }

async function boot() {
  try {
    const me = await api('me');
    ME = me;
    $('#me-user').textContent = `@${me.username}`;
    $('#shell').hidden = false;
    $('#login').hidden = true;
    $('#logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }); showLogin(); });
    window.addEventListener('hashchange', route);
    if (!location.hash) location.hash = '#/automacoes'; else route();
  } catch { /* showLogin já tratou */ }
}
boot();
