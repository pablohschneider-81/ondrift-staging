// Edge Function: create-portal
// Devuelve la URL del portal de cliente de Stripe: el entrenador cambia la
// tarjeta, descarga facturas o cancela. Recibe { return_url }.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json, safeReturnUrl, stripe } from "../_shared/stripe.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_RETURN = "https://ondrift.app/app/";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Inicia sesión de nuevo." }, 401);

    const { data: coach } = await admin
      .from("coaches")
      .select("stripe_customer_id")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (!coach?.stripe_customer_id) return json({ error: "Todavía no tienes ninguna suscripción." }, 404);

    const { return_url } = await req.json().catch(() => ({}));
    const portal = await stripe("POST", "/billing_portal/sessions", {
      customer: coach.stripe_customer_id,
      return_url: safeReturnUrl(return_url, DEFAULT_RETURN),
      locale: "es",
    });
    return json({ url: portal.url });
  } catch (e) {
    console.error("create-portal", (e as Error).message);
    return json({ error: "No se pudo abrir la gestión de la suscripción." }, 500);
  }
});
