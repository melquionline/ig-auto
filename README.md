# ig-auto

Automações nativas de Instagram no estilo ManyChat, rodando no seu próprio servidor e usando a API oficial da Meta (Instagram API com login do Instagram). Você não paga mensalidade por contato.

- **Gatilhos:** comentário em post ou reel, comentário em live, direct e resposta de story, por palavra-chave ou qualquer mensagem
- **Fluxos:** resposta pública com variações, DM com botões, cartão com links, etiquetas, espera e delay
- **Trava "precisa me seguir":** da segunda mensagem em diante, quem ainda não segue o perfil recebe um aviso com o botão "Já segui" e só continua depois de seguir
- **Painel web:** login com Instagram, editor de automações com prévia do celular, funil (disparos → seguiram a conversa → cliques) e lista de leads
- **Links rastreados:** cada botão de link passa por `/r/<código>`, então você sabe quem clicou em quê
- **Multi-conta:** cada conta conectada tem suas próprias automações
- **Sem dependências pesadas:** Node 22, Express e o SQLite nativo do Node (`node:sqlite`)

> 📘 **Primeira vez?** O ebook [**Seu ManyChat próprio**](ebook/ig-auto-ebook.pdf) ensina o passo a passo completo, do servidor até a primeira automação no ar, sem precisar ser programador. Também está em [versão web](ebook/index.html).

## Requisitos

- Node **22.13+**
- Um servidor com HTTPS (a Meta só entrega webhook em `https://`), por exemplo uma VPS com nginx e Let's Encrypt
- Uma conta do Instagram **profissional** (comercial ou criador de conteúdo)
- Uma conta de desenvolvedor na Meta (developers.facebook.com)

## 1. Rodar o servidor

```bash
git clone <este-repo> ig-auto && cd ig-auto
npm install
cp .env.example .env   # preencha depois de criar o app na Meta
npm start
```

O processo escuta só em `127.0.0.1:PORT`. Exponha com um proxy reverso. Exemplo de nginx para servir em `https://seudominio.com/ig-auto/`:

```nginx
location /ig-auto/ {
    proxy_pass http://127.0.0.1:3020/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Para manter no ar: `pm2 start npm --name ig-auto -- start` (ou o gerenciador de processos que você preferir).

Rotas: `/webhook`, `/connect?key=ADMIN_KEY`, `/oauth/callback`, `/painel/`, `/r/:code`, `/admin/status?key=ADMIN_KEY`, `/health`.

## 2. Criar o app na Meta

1. Em developers.facebook.com, crie um app com o caso de uso **"Gerenciar mensagens e conteúdo no Instagram"** (API com login do Instagram).
2. Em **Configuração da API com login do Instagram**, copie o **ID do app do Instagram** e a **chave secreta** para `IG_APP_ID` e `IG_APP_SECRET`.
3. **Webhook:**
   - URL de callback: `PUBLIC_URL/webhook`
   - Token de verificação: o mesmo valor do seu `VERIFY_TOKEN`
   - Assine os campos `comments`, `live_comments`, `messages`, `messaging_postbacks`, `messaging_seen` e `message_reactions`
4. **Login comercial do Instagram:** cadastre `PUBLIC_URL/oauth/callback` como URI de redirecionamento.
5. **Política de privacidade:** a Meta exige uma URL. Há um modelo em `privacidade/index.html`; troque os `[colchetes]` e publique. Os campos de Termos e Exclusão de dados vêm preenchidos com facebook.com, então troque-os também.
6. **Publique o app.** O webhook só entrega eventos com o app publicado. No acesso padrão, só contas com função no app (testadores) podem conectar, e isso já basta para automatizar o **seu** perfil: comentários e DMs de qualquer pessoa chegam normalmente.
7. Adicione sua conta do Instagram como **Testador do Instagram** e aceite o convite no app do Instagram (Configurações → Apps e sites).

> Pegadinha: se o convite pela aba Funções der "O formulário não pode ser salvo", use o botão **"Adicionar conta"** no passo de geração de tokens e escolha o perfil na lista de sugestões.

## 3. Conectar a conta e testar

1. Abra `PUBLIC_URL/connect?key=SEU_ADMIN_KEY` e autorize. Isso guarda o token (60 dias, renovado automaticamente) e assina os webhooks da conta.
2. Com `SMOKE_TEST=1`, comente **teste** num post usando **outra** conta. Deve chegar uma resposta pública e uma DM.
3. Depois de validar, use `SIGNATURE_ENFORCE=1` e `SMOKE_TEST=0` e reinicie o processo.

## 4. Criar automações

**Pelo painel:** acesse `PUBLIC_URL/painel/` e entre com o Instagram. Só os usernames listados em `PANEL_USERS` têm acesso.

**Por arquivo:** veja `automations/exemplo-ebook.js` e rode:

```bash
node --no-warnings scripts/seed.js            # cria as que ainda não existem
node --no-warnings scripts/seed.js --force    # sobrescreve pelo nome
```

Depois do primeiro seed, **o banco é a fonte da verdade**: edições no painel não são apagadas por um seed sem `--force`.

### Blocos disponíveis

| Tipo | O que faz |
|---|---|
| `comment_reply` | Resposta pública ao comentário, sorteada entre `variations` |
| `message` | DM com `text`, até 3 `buttons` (`next` ou `url`), `wait` para esperar a pessoa e `on_text` para seguir quando ela digitar em vez de clicar |
| `card` | Cartão com `title`, `subtitle`, `image_url` e até 3 botões de link |
| `tag` | Aplica etiquetas ao contato |

Qualquer bloco aceita `delay` (segundos) e `next`.

### Regras da Meta que o motor já respeita

- A partir de um comentário sai **uma** DM (resposta privada) até a pessoa interagir. Por isso o primeiro direct deve ter um botão.
- Há cooldown de 12h por pessoa e automação. Quem repete a palavra recebe só a resposta pública.
- Se a Meta recusar um template, o envio cai para quick replies e depois para texto puro.

## Se parar de responder

Se o log mostra erro `190` / "session has been invalidated", a Meta derrubou o token. O caso mais comum é a senha do Instagram ter sido trocada. O servidor continua no ar e o `/health` responde normalmente, mas nenhuma resposta sai. Para resolver, entre de novo em `PUBLIC_URL/painel/` com **Entrar com Instagram** (ou abra `/connect?key=ADMIN_KEY`). Isso salva o token novo e reassina os webhooks. As tentativas que falharam antes de enviar qualquer DM não contam na pausa de 12h, então quem tentou durante a queda pode tentar de novo na hora.

## Teste local sem a Meta

```bash
DATA_DIR=/tmp/ig-auto DRY_RUN=1 DEV_LOGIN=1 PUBLIC_URL=http://localhost:3020 npm start
# abra http://localhost:3020/painel/dev-login?as=<igUserId>
```

## Arquitetura

```
src/
  index.js            rotas (webhook, OAuth, painel, links, renovação de token)
  webhook/normalize.js  traduz o payload da Meta em eventos (post_comment, live_comment, dm, story_reply, postback…)
  engine/index.js     escolhe a automação pelo evento
  engine/runner.js    executa o fluxo bloco a bloco
  engine/send.js      envia com fallback de formato
  engine/validate.js  validação única (painel + seed)
  panel/              API e sessão do painel
  meta/               cliente da Graph API e verificação de assinatura
public/painel/        SPA do painel (sem build)
automations/          automações em arquivo para o seed
```

## Segurança

- Nunca versione o `.env` nem a pasta `data/`. O banco guarda os tokens de acesso e os dados dos seus leads. O `.gitignore` já ignora os dois.
- Ative `SIGNATURE_ENFORCE=1` em produção.
- Os dados dos leads ficam no seu servidor. Você é responsável por cumprir a LGPD/GDPR e a política de privacidade publicada.

## Licença

MIT. Veja [LICENSE](LICENSE).
