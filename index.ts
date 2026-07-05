// ============================================================================
// supabase/functions/webhook-pix/index.ts
// ----------------------------------------------------------------------------
// Recebe as notificações de pagamento da InfinitePay, valida a assinatura
// HMAC do payload e confirma a transação de forma idempotente via RPC
// `confirm_payment`.
//
// IMPORTANTE - Assinatura HMAC:
// O nome exato do header de assinatura e o algoritmo usado pela InfinitePay
// devem ser confirmados no painel de desenvolvedor da sua conta (a
// documentação pública pode variar por versão de conta/API). Esta function
// foi escrita de forma configurável via variáveis de ambiente para que você
// ajuste sem precisar reescrever a lógica:
//   INFINITEPAY_WEBHOOK_SECRET       -> chave simétrica usada no HMAC
//   INFINITEPAY_SIGNATURE_HEADER     -> nome do header (default: x-webhook-signature)
// A comparação é feita em HMAC-SHA256 (hex) sobre o corpo bruto (raw body)
// da requisição, que é o padrão mais comum em webhooks de gateways de
// pagamento. Ajuste a função `computeSignature` caso a InfinitePay use outro
// algoritmo (ex: sha1) ou formato (ex: base64).
//
// Variáveis de ambiente necessárias:
//   SUPABASE_URL                     -> injetada automaticamente
//   SUPABASE_SERVICE_ROLE_KEY        -> injetada automaticamente
//   INFINITEPAY_WEBHOOK_SECRET       -> chave secreta do webhook (painel InfinitePay)
//   INFINITEPAY_SIGNATURE_HEADER     -> opcional, default "x-webhook-signature"
//   ALLOWED_ORIGIN                   -> não é usado para bloquear (webhook é
//                                        server-to-server), mas mantemos os
//                                        headers de CORS por padronização.
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildCorsHeaders, handleCorsPreflight } from "../_shared/cors.ts";

const DEFAULT_SIGNATURE_HEADER = "x-webhook-signature";

interface InfinitePayWebhookPayload {
  order_nsu?: string;
  transaction_nsu?: string;
  invoice_slug?: string;
  amount?: number;
  paid_amount?: number;
  capture_method?: string;
  installments?: number;
  receipt_url?: string;
}

/**
 * Calcula o HMAC-SHA256 (hex) do corpo bruto usando a chave secreta.
 */
async function computeHmacSha256Hex(secret: string, rawBody: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(rawBody));
  return Array.from(new Uint8Array(signatureBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Comparação em tempo constante para evitar timing attacks na verificação
 * da assinatura.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const webhookSecret = Deno.env.get("INFINITEPAY_WEBHOOK_SECRET");
    const signatureHeaderName =
      Deno.env.get("INFINITEPAY_SIGNATURE_HEADER") ?? DEFAULT_SIGNATURE_HEADER;

    if (!supabaseUrl || !serviceRoleKey || !webhookSecret) {
      console.error("webhook-pix: variáveis de ambiente ausentes.");
      // Retorna 200 seria enganoso; usamos 500 pois é falha nossa, não do payload.
      return new Response(JSON.stringify({ error: "Configuração do servidor incompleta." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Lemos o corpo BRUTO (raw) antes de qualquer parse, pois a assinatura
    // HMAC é calculada sobre os bytes exatos recebidos.
    const rawBody = await req.text();

    // -----------------------------------------------------------------
    // 1. VALIDAÇÃO OBRIGATÓRIA DA ASSINATURA HMAC
    // -----------------------------------------------------------------
    const receivedSignature = req.headers.get(signatureHeaderName);
    if (!receivedSignature) {
      console.warn("webhook-pix: assinatura ausente no header.", signatureHeaderName);
      return new Response(JSON.stringify({ error: "Assinatura ausente." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const expectedSignature = await computeHmacSha256Hex(webhookSecret, rawBody);

    // Aceita tanto o valor puro quanto prefixado (ex: "sha256=...")
    const normalizedReceived = receivedSignature.replace(/^sha256=/i, "").trim().toLowerCase();

    if (!timingSafeEqual(normalizedReceived, expectedSignature.toLowerCase())) {
      console.warn("webhook-pix: assinatura inválida. Possível tentativa de fraude.");
      return new Response(JSON.stringify({ error: "Assinatura inválida." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // -----------------------------------------------------------------
    // 2. PARSE E VALIDAÇÃO DO PAYLOAD
    // -----------------------------------------------------------------
    let payload: InfinitePayWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: "JSON inválido." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const transactionId = payload.order_nsu;
    const transactionNsu = payload.transaction_nsu ?? payload.invoice_slug ?? null;
    const paidAmountCents = payload.paid_amount ?? payload.amount;

    if (!transactionId || !paidAmountCents || paidAmountCents <= 0) {
      console.error("webhook-pix: payload incompleto ou inválido.", payload);
      // 400 sinaliza à InfinitePay que algo está errado com o payload (não retenta indefinidamente com o mesmo erro).
      return new Response(JSON.stringify({ error: "Payload incompleto." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const paidAmountReais = paidAmountCents / 100;

    // -----------------------------------------------------------------
    // 3. CONFIRMAÇÃO IDEMPOTENTE VIA RPC (service_role bypassa RLS)
    // -----------------------------------------------------------------
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: confirmed, error: rpcError } = await supabase.rpc("confirm_payment", {
      p_transaction_id: transactionId,
      p_txid: transactionNsu,
      p_paid_amount: paidAmountReais,
    });

    if (rpcError) {
      console.error("webhook-pix: erro ao executar confirm_payment.", rpcError);
      // 500 faz a InfinitePay retentar depois - correto para erro transitório nosso.
      return new Response(JSON.stringify({ error: "Erro ao processar confirmação." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!confirmed) {
      // Idempotência: já havia sido confirmada antes, ou id não existe.
      // Retornamos 200 para que o gateway pare de retentar (não é um erro).
      console.info("webhook-pix: transação já confirmada anteriormente ou inexistente.", transactionId);
    }

    // -----------------------------------------------------------------
    // 4. RESPOSTA 200 - cessa os reenvios do gateway
    // -----------------------------------------------------------------
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (unexpectedError) {
    console.error("webhook-pix: erro inesperado.", unexpectedError);
    return new Response(JSON.stringify({ error: "Erro interno do servidor." }), {
      status: 500,
      headers: { ...buildCorsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });
  }
});
