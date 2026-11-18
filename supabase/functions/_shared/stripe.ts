// Utilidades comunes para las funciones de pago de Ondrift (Stripe).
// La clave secreta NUNCA está en el código: se lee de los Secrets de Supabase
// (STRIPE_SECRET_KEY), que pega el titular en el panel.

export const STRIPE_API = "https://api.stripe.com/v1";

// Precios de Stripe por plan e intervalo. En modo test van aquí; para pasar a
// real, se pone el JSON con los precios live en el Secret STRIPE_PRICES y
// ese valor manda sobre este.
const PRICES_TEST: Record<string, Record<string, string>> = {
  individual: {
    month: "price_1UcizNIKWoKP9qYORVfzwbSw",
    year: "price_1Ucj4tIKWoKP9qYO19SJSL46",
  },
  duo: {
    month: "price_1Ucj2VIKWoKP9qYOCxOiJq6b",
    year: "price_1Ucj9KIKWoKP9qYO6k2iZ3Zh",
  },
  grupo4: {
    month: "price_1Ucj2tIKWoKP9qYOmiysA7Al",
    year: "price_1UcjArIKWoKP9qYOexnlS04N",
  },
};

export function priceTable(): Record<string, Record<string, string>> {
  const raw = Deno.env.get("STRIPE_PRICES");
  if (raw) {
    try { return JSON.parse(raw); } catch (_) { /* cae al de test */ }
  }
  return PRICES_TEST;
}

export const PLANS = ["individual", "duo", "grupo4"] as const;

// Direcciones a las que Stripe puede devolver al usuario tras pagar.
const RETURN_ORIGINS = [
  /^https:\/\/ondrift\.app$/,
  /^https:\/\/[a-z0-9-]+\.ondrift-akt\.pages\.dev$/,
  /^https:\/\/ondrift-akt\.pages\.dev$/,
  /^https:\/\/pablohschneider-81\.github\.io$/,
  /^http:\/\/localhost(:\d+)?$/,
];

export function safeReturnUrl(candidate: unknown, fallback: string): string {
  if (typeof candidate !== "string") return fallback;
  try {
    const u = new URL(candidate);
    if (RETURN_ORIGINS.some((re) => re.test(u.origin))) return u.origin + u.pathname;
  } catch (_) { /* inválida */ }
  return fallback;
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

// Codifica objetos anidados al formato de formulario de la API de Stripe
// (a[b][0][c]=valor).
function encode(obj: Record<string, unknown>, prefix = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") encode(v as Record<string, unknown>, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  }
  return out;
}

export async function stripe(
  method: "GET" | "POST",
  path: string,
  params?: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Falta STRIPE_SECRET_KEY en los Secrets de Supabase");
  const headers: Record<string, string> = {
    Authorization: "Bearer " + key,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const body = params ? encode(params).join("&") : undefined;
  const url = method === "GET" && body ? `${STRIPE_API}${path}?${body}` : `${STRIPE_API}${path}`;
  const res = await fetch(url, { method, headers, body: method === "POST" ? body : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error("Stripe " + res.status + ": " + (data?.error?.message || "error"));
  return data;
}
