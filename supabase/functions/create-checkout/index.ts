// Edge Function: create-checkout
// El entrenador (con sesión) pide pagar un plan. Devuelve la URL de la página
// de pago de Stripe (Checkout). El plan NO se activa aquí: lo activa el
// webhook cuando Stripe confirma el pago.
//
// Recibe { plan: 'individual'|'duo'|'grupo4', interval: 'month'|'year', return_url }.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json, priceTable, safeReturnUrl, stripe, PLANS } from "../_shared/stripe.ts";

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
    const user = userData.user;

    const { plan, interval, return_url } = await req.json().catch(() => ({}));
    if (!PLANS.includes(plan) || !["month", "year"].includes(interval)) {
      return json({ error: "Plan no válido." }, 400);
    }
    const price = priceTable()[plan]?.[interval];
    if (!price) return json({ error: "Este plan todavía no está disponible." }, 400);

    const { data: coach } = await admin
      .from("coaches")
      .select("id, display_name, stripe_customer_id, subscription_status, billing_owner_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!coach) return json({ error: "Solo los entrenadores pueden suscribirse." }, 403);
    if (coach.billing_owner_id) {
      return json({ error: "Tu plan lo paga otro entrenador de tu Dúo o Grupo. Si quieres pagar por tu cuenta, pídele que te quite de su plan.", code: "group_member" }, 409);
    }
    if (["active", "trialing", "past_due"].includes(coach.subscription_status || "")) {
      return json({ error: "Ya tienes una suscripción. Gestiónala desde 'Mi suscripción'.", code: "already_subscribed" }, 409);
    }

    // Cliente de Stripe: uno por entrenador, reutilizado en futuras compras.
    let customerId = coach.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe("POST", "/customers", {
        email: user.email,
        name: coach.display_name || undefined,
        preferred_locales: { 0: "es" },
        metadata: { coach_id: coach.id },
      }, "customer-" + coach.id);
      customerId = customer.id;
      await admin.from("coaches").update({ stripe_customer_id: customerId }).eq("id", coach.id);
    }

    const base = safeReturnUrl(return_url, DEFAULT_RETURN);
    const taxRate = Deno.env.get("STRIPE_TAX_RATE"); // txr_… del IVA 21 % (incluido)

    const session = await stripe("POST", "/checkout/sessions", {
      mode: "subscription",
      customer: customerId,
      client_reference_id: coach.id,
      line_items: { 0: { price, quantity: 1 } },
      locale: "es",
      success_url: base + "?pago=ok",
      cancel_url: base + "?pago=cancelado",
      metadata: { coach_id: coach.id, plan },
      subscription_data: {
        metadata: { coach_id: coach.id, plan },
        default_tax_rates: taxRate ? { 0: taxRate } : undefined,
      },
      // Para que un club pueda poner su NIF y recibir la factura a su nombre.
      tax_id_collection: { enabled: true },
      billing_address_collection: "auto",
      customer_update: { name: "auto", address: "auto" },
    });

    return json({ url: session.url });
  } catch (e) {
    console.error("create-checkout", (e as Error).message);
    return json({ error: "No se pudo abrir el pago. Inténtalo de nuevo." }, 500);
  }
});
