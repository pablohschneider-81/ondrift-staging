// Edge Function: stripe-webhook
// Stripe avisa aquí de pagos, renovaciones y cancelaciones. Es lo ÚNICO que
// cambia el plan de un entrenador por un pago.
//
// Seguridad:
// - Firma: cada aviso trae la cabecera Stripe-Signature (HMAC-SHA256 con el
//   secreto del webhook, STRIPE_WEBHOOK_SECRET). Sin firma válida o con más de
//   5 minutos de antigüedad, se rechaza: nadie puede regalarse un plan.
// - Idempotencia: Stripe puede repetir un aviso. Cada id de evento se guarda en
//   stripe_events; si ya está, se responde 200 sin volver a procesarlo. Si el
//   procesado falla, se borra la marca y se devuelve 500 para que Stripe reintente.
//
// Estados: active / trialing / past_due mantienen el plan (en past_due Stripe
// reintenta el cobro y se avisa antes de cortar). canceled / unpaid /
// incomplete_expired pasan el plan a 'expired' = solo lectura.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { priceTable, stripe } from "../_shared/stripe.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOLERANCE_SECONDS = 300;

const KEEP_ACCESS = ["active", "trialing", "past_due"];

function hex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function verifySignature(payload: string, header: string, secret: string) {
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find((p) => p[0] === "t")?.[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!t || sigs.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some((s) => safeEqual(s, mac));
}

// Plan a partir de los metadatos de la suscripción o, si faltan, del precio.
function planOf(sub: any): string | null {
  if (sub?.metadata?.plan) return sub.metadata.plan;
  const priceId = sub?.items?.data?.[0]?.price?.id;
  for (const [plan, byInterval] of Object.entries(priceTable())) {
    if (Object.values(byInterval).includes(priceId)) return plan;
  }
  return null;
}

function periodEnd(sub: any): string | null {
  // Según la versión de la API, la fecha está en la suscripción o en su línea.
  const ts = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

async function applySubscription(admin: any, sub: any, coachIdHint?: string | null) {
  let coachId = coachIdHint || sub?.metadata?.coach_id || null;
  if (!coachId) {
    const { data } = await admin.from("coaches").select("id")
      .or(`stripe_subscription_id.eq.${sub.id},stripe_customer_id.eq.${sub.customer}`).maybeSingle();
    coachId = data?.id || null;
  }
  if (!coachId) throw new Error("Suscripción sin entrenador: " + sub.id);

  const status: string = sub.status;
  const patch: Record<string, unknown> = {
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    subscription_status: status,
    billing_interval: sub?.items?.data?.[0]?.price?.recurring?.interval || null,
    current_period_end: periodEnd(sub),
  };
  if (KEEP_ACCESS.includes(status)) {
    const plan = planOf(sub);
    if (plan) patch.plan = plan;
    // Quien paga no espera a la aprobación manual: pagar ya demuestra que no es un bot.
    patch.status = "approved";
  } else if (["canceled", "unpaid", "incomplete_expired"].includes(status)) {
    patch.plan = "expired";
  }
  const { error } = await admin.from("coaches").update(patch).eq("id", coachId);
  if (error) throw new Error("No se pudo actualizar el entrenador: " + error.message);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("Webhook sin configurar", { status: 500 });

  const payload = await req.text();
  const signature = req.headers.get("stripe-signature") || "";
  if (!(await verifySignature(payload, signature, secret))) {
    return new Response("Firma no válida", { status: 400 });
  }

  const event = JSON.parse(payload);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { error: dupErr } = await admin.from("stripe_events").insert({ id: event.id, type: event.type });
  if (dupErr) {
    if (dupErr.code === "23505") return new Response("ok (repetido)", { status: 200 });
    return new Response("Error de base de datos", { status: 500 });
  }

  try {
    const obj = event.data?.object;
    switch (event.type) {
      case "checkout.session.completed": {
        if (obj.mode === "subscription" && obj.subscription) {
          const sub = await stripe("GET", `/subscriptions/${obj.subscription}`);
          await applySubscription(admin, sub, obj.client_reference_id || obj.metadata?.coach_id);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await applySubscription(admin, obj);
        break;
      default:
        break; // El resto de avisos no cambian nada en Ondrift.
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("stripe-webhook", event.type, (e as Error).message);
    await admin.from("stripe_events").delete().eq("id", event.id);
    return new Response("Error procesando el evento", { status: 500 });
  }
});
