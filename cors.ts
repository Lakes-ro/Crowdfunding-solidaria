// ============================================================================
// _shared/cors.ts
// Utilitário de CORS reutilizado pelas Edge Functions do projeto.
// ============================================================================
// Defina a variável de ambiente ALLOWED_ORIGIN no painel do Supabase com o
// domínio exato do seu frontend em produção (ex: https://vaquinha.seudominio.com.br).
// Use "*" apenas em desenvolvimento.
// ----------------------------------------------------------------------------

const configuredOrigin = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

export function buildCorsHeaders(requestOrigin: string | null): Record<string, string> {
  // Se ALLOWED_ORIGIN for "*", reflete a origem recebida (necessário quando
  // credentials não são usadas) ou aplica o wildcard diretamente.
  const originToUse =
    configuredOrigin === "*" ? requestOrigin ?? "*" : configuredOrigin;

  return {
    "Access-Control-Allow-Origin": originToUse,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: buildCorsHeaders(req.headers.get("origin")),
    });
  }
  return null;
}

export function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  req: Request,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...buildCorsHeaders(req.headers.get("origin")),
      "Content-Type": "application/json",
    },
  });
}
