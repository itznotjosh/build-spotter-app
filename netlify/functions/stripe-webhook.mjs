// /api/stripe-webhook  ← Stripe calls this after a payment. Adds the purchased credits to the account.
// Set up in Stripe → Developers → Webhooks → Add endpoint:
//   URL     https://YOUR-SITE.netlify.app/api/stripe-webhook
//   Events  checkout.session.completed, checkout.session.async_payment_succeeded
// then copy the endpoint's signing secret (whsec_…) into the STRIPE_WEBHOOK_SECRET variable.
import crypto from "node:crypto";
import { accountsOn, creditSession, json } from "../lib/accounts.mjs";

export function verify(payload, header, secret, tolerance = 300) {
  const parts = Object.fromEntries((header || "").split(",").map(p => p.split("=")).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = (header || "").split(",").filter(p => p.trim().startsWith("v1=")).map(p => p.trim().slice(3));
  const t = parseInt(parts.t || "0", 10);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method" });
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  const payload = await req.text();
  if (!secret || !verify(payload, req.headers.get("stripe-signature"), secret)) return json(400, { error: "bad signature" });
  if (!accountsOn()) return json(500, { error: "accounts not configured" });
  let ev; try { ev = JSON.parse(payload); } catch { return json(400, { error: "bad json" }); }
  if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
    try {
      const r = await creditSession(ev.data?.object);
      console.log("credited", ev.data?.object?.id, JSON.stringify(r));
    } catch (e) { return json(500, { error: "could not credit" }); }   // Stripe retries on 5xx
  }
  return json(200, { received: true });
};

export const config = { path: "/api/stripe-webhook" };
