// /api/checkout  POST { pack: "p20" }  → { url } of a Stripe Checkout page for that credit pack.
// Prices live on the server (netlify/lib/accounts.mjs or the CREDIT_PACKS variable), never in the browser.
import { accountsOn, paymentsOn, getUser, packs, stripe, CURRENCY, json } from "../lib/accounts.mjs";

export default async (req) => {
  if (req.method !== "POST") return json(405, { code: "api", message: "Method not allowed" });
  if (!accountsOn() || !paymentsOn()) return json(404, { code: "payments_off" });
  const user = await getUser(req);
  if (!user) return json(401, { code: "signin" });
  const b = await req.json().catch(() => ({}));
  const pack = packs().find(p => p.id === b.pack);
  if (!pack) return json(400, { code: "api", message: "Unknown credit pack." });
  const origin = (process.env.URL && /^https:/.test(process.env.URL)) ? process.env.URL : new URL(req.url).origin;
  try {
    const s = await stripe("POST", "checkout/sessions", {
      mode: "payment",
      success_url: `${origin}/?paid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=1`,
      client_reference_id: user.id,
      customer_email: user.email || undefined,
      line_items: { 0: { quantity: 1, price_data: { currency: CURRENCY(), unit_amount: pack.cents,
        product_data: { name: `Build Spotter · ${pack.credits} scans`, description: "Scan credits. They never expire." } } } },
      metadata: { user_id: user.id, credits: pack.credits, pack: pack.id },
      payment_intent_data: { metadata: { user_id: user.id, credits: pack.credits, pack: pack.id } },
    });
    return json(200, { url: s.url });
  } catch (e) {
    return json(e.status || 502, { code: e.code || "payments_down", message: e.message });
  }
};

export const config = { path: "/api/checkout" };
