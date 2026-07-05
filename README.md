# Vaquinha da Lud — Sistema de Arrecadação via Pix

Micro-SaaS de financiamento coletivo para os 15 anos da Ludmila. Stack: HTML5 + CSS3 + JS puro no frontend, Supabase (Postgres + Edge Functions em Deno) no backend, InfinitePay como gateway de checkout.

## Estrutura

```
vaquinha/
├── database/
│   └── schema.sql                       # Script único para rodar no SQL Editor do Supabase
├── supabase/functions/
│   ├── _shared/cors.ts                  # CORS compartilhado
│   ├── create-checkout/index.ts         # Gera o link de pagamento
│   └── webhook-pix/index.ts             # Recebe e confirma pagamentos (HMAC)
└── frontend/
    ├── index.html
    ├── style.css
    └── app.js
```

## 1. Banco de dados

No painel do Supabase, abra o **SQL Editor** e rode o conteúdo de `database/schema.sql`. Ele cria:

- `public.events` — dados do evento, leitura pública via RLS (`SELECT` liberado para `anon`/`authenticated` apenas em eventos `is_active = true`).
- `public.transactions` — RLS habilitado **sem nenhuma policy** (nega tudo por padrão). Só a `service_role` (usada dentro das Edge Functions) consegue ler/gravar.
- RPC `confirm_payment(p_transaction_id, p_txid, p_paid_amount)` — idempotente: só credita o valor se a transação ainda estiver `pending`.
- Publicação Realtime na tabela `events`.
- Uma linha de exemplo (`ludmila-15-anos`) — ajuste `goal_amount` e `infinitepay_handle` para os dados reais, ou insira uma nova linha e use o `id` gerado.

## 2. Edge Functions

Deploy (usando a Supabase CLI):

```bash
supabase functions deploy create-checkout
supabase functions deploy webhook-pix
```

### Variáveis de ambiente (Secrets)

```bash
supabase secrets set INFINITEPAY_API_TOKEN="token_do_painel_infinitepay"
supabase secrets set INFINITEPAY_WEBHOOK_SECRET="chave_secreta_do_webhook"
supabase secrets set INFINITEPAY_SIGNATURE_HEADER="x-webhook-signature"   # ajuste conforme o painel
supabase secrets set APP_REDIRECT_URL="https://seudominio.com.br/obrigado"
supabase secrets set WEBHOOK_URL="https://SEU-PROJETO.functions.supabase.co/webhook-pix"
supabase secrets set ALLOWED_ORIGIN="https://seudominio.com.br"
```

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já são injetadas automaticamente pelo Supabase — não precisam ser configuradas manualmente.

### ⚠️ Nota importante sobre a assinatura HMAC do webhook

A documentação pública da InfinitePay descreve o payload do webhook (`order_nsu`, `transaction_nsu`, `amount`, `paid_amount`, etc.), mas o **nome exato do header de assinatura e o algoritmo usado podem variar conforme a versão da sua conta/API**. A função `webhook-pix` já está pronta para validar HMAC-SHA256 sobre o corpo bruto da requisição, mas **confirme no painel de desenvolvedor da sua conta InfinitePay**:

1. O nome do header (configurável via `INFINITEPAY_SIGNATURE_HEADER`, padrão `x-webhook-signature`).
2. O algoritmo (a função já assume SHA-256; ajuste `computeHmacSha256Hex` em `webhook-pix/index.ts` se for outro).

Sem essa confirmação, teste o webhook em ambiente de homologação antes de ir para produção.

### Decisão de arquitetura: `order_nsu` como chave de conciliação

A API de criação de link da InfinitePay retorna apenas `{ "url": "..." }` — nenhum ID de transação. Por isso, o `id` da transação já criada no nosso banco (status `pending`) é enviado como `order_nsu` para a InfinitePay. O webhook devolve esse mesmo `order_nsu`, permitindo localizar a transação com precisão; o `transaction_nsu` retornado pela InfinitePay é então gravado no campo `txid` como comprovante.

## 3. Frontend

Edite as constantes no topo de `frontend/app.js`:

```js
const CONFIG = {
  SUPABASE_URL: "https://SEU-PROJETO.supabase.co",
  SUPABASE_ANON_KEY: "SUA_CHAVE_ANON_PUBLICA",   // chave pública, segura para o cliente
  EVENT_SLUG: "ludmila-15-anos",                 // deve bater com a coluna slug em public.events
  CREATE_CHECKOUT_FUNCTION_URL: "https://SEU-PROJETO.functions.supabase.co/functions/v1/create-checkout",
};
```

O frontend busca o evento pelo `slug` em tempo de carregamento (não é preciso descobrir/colar o UUID manualmente). Basta o `slug` em `app.js` bater com o valor inserido em `public.events` no `schema.sql`.

Depois é só hospedar `index.html`, `style.css` e `app.js` em qualquer serviço de arquivos estáticos (Vercel, Netlify, Supabase Storage, etc.) — não há build step, pois é HTML/CSS/JS puro.

## 4. Segurança implementada

- **RLS estrito**: frontend só lê `events` ativos; `transactions` é inacessível ao cliente.
- **Chaves privadas nunca no frontend**: `INFINITEPAY_API_TOKEN`, `INFINITEPAY_WEBHOOK_SECRET` e a `service_role_key` só existem nas Edge Functions.
- **Validação de HMAC** no webhook, com comparação em tempo constante.
- **Idempotência**: `confirm_payment` só transiciona `pending → paid` uma única vez, mesmo com reenvios do gateway.
- **Validação de inputs**: valores negativos/zerados são rejeitados, limites mínimo (R$ 5) e máximo (R$ 50.000) de doação, sanitização de textos.
- **CORS restrito**: configure `ALLOWED_ORIGIN` com o domínio real em produção (evite deixar `*`).

## 5. Fluxo de UI

`Formulário → Loading → Redirecionamento ao checkout InfinitePay → Retorno com faixa de agradecimento + confetes` e, em paralelo, qualquer visitante com a página aberta vê o selo de progresso atualizar sozinho via WebSocket (Supabase Realtime) quando uma nova doação é confirmada.
