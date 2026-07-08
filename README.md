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
