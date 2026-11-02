// Shared helpers for accounts, credits and Stripe. Used by the functions in netlify/functions.
// No npm packages: everything talks to Supabase and Stripe over their REST APIs.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   SUPABASE_URL               https://xxxx.supabase.co            (Supabase → Project Settings → API)
//   SUPABASE_ANON_KEY          the "anon public" key               (safe to send to browsers)
//   SUPABASE_SERVICE_ROLE_KEY  the "service_role" key              (secret: server only)
//   STRIPE_SECRET_KEY          sk_live_… or sk_test_…              (Stripe → Developers → API keys)
//   STRIPE_WEBHOOK_SECRET      whsec_…                             (Stripe → Developers → Webhooks → your endpoint)
//   FREE_SCANS_PER_MONTH       optional, default 5
//   CREDIT_PACKS               optional JSON, e.g. [{"id":"p20","credits":20,"cents":299}, …]
//   CURRENCY                   optional, default usd

const env = k => (process.env[k] || "").trim();

export const SB_URL = () => env("SUPABASE_URL").replace(/\/+$/, "");
export const SB_ANON = () => env("SUPABASE_ANON_KEY");
const SB_SERVICE = () => env("SUPABASE_SERVICE_ROLE_KEY");
export const accountsOn = () => !!(SB_URL() && SB_ANON() && SB_SERVICE());
export const paymentsOn = () => !!env("STRIPE_SECRET_KEY");
export const FREE = () => Math.max(0, parseInt(env("FREE_SCANS_PER_MONTH") || "5", 10) || 0);
export const CURRENCY = () => (env("CURRENCY") || "usd").toLowerCase();

const DEFAULT_PACKS = [
  { id: "p20", credits: 20, cents: 299 },
  { id: "p50", credits: 50, cents: 599, tag: "Most popular" },
  { id: "p120", credits: 120, cents: 1199, tag: "Best value" },
];
export function packs() {
  try {
    const p = JSON.parse(env("CREDIT_PACKS") || "null");
    if (Array.isArray(p) && p.length && p.every(x => x.id && x.credits > 0 && x.cents >= 50)) return p;
  } catch {}
  return DEFAULT_PACKS;
}

export const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Who is calling? Verifies the Supabase access token sent by the browser.
export async function getUser(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m || !accountsOn()) return null;
  try {
    const r = await fetch(`${SB_URL()}/auth/v1/user`, { headers: { apikey: SB_ANON(), authorization: `Bearer ${m[1]}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? { id: u.id, email: u.email || "" } : null;
  } catch { return null; }
}

// Calls one of the credit functions in supabase/schema.sql with the server key.
export async function rpc(name, args) {
  const r = await fetch(`${SB_URL()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SB_SERVICE(), authorization: `Bearer ${SB_SERVICE()}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const t = await r.text();
  if (!r.ok) { console.error("supabase rpc", name, r.status, t.slice(0, 300)); throw { status: 500, code: "accounts_down" }; }
  return t ? JSON.parse(t) : null;
}

export const balance = uid => rpc("bs_balance", { p_user: uid, p_free: FREE() });
export const spend = uid => rpc("bs_spend", { p_user: uid, p_free: FREE() });
export const refund = (uid, source) => rpc("bs_refund", { p_user: uid, p_source: source });
export const addPaid = (uid, credits, ref) => rpc("bs_add_paid", { p_user: uid, p_credits: credits, p_ref: ref });

// Stripe REST helper (form-encoded, like Stripe's own SDKs send).
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === "object") form(v, key, out); else if (v !== undefined && v !== null) out.append(key, String(v));
  }
  return out;
}
export async function stripe(method, path, params) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${env("STRIPE_SECRET_KEY")}`, ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: params ? form(params) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("stripe", path, r.status, JSON.stringify(j).slice(0, 300)); throw { status: 502, code: "payments_down", message: j.error?.message }; }
  return j;
}

// Credits a paid Checkout session. Safe to call more than once for the same session.
export async function creditSession(s, expectUser) {
  if (s?.object !== "checkout.session" || s.payment_status !== "paid") return null;
  const uid = s.metadata?.user_id || s.client_reference_id;
  const credits = parseInt(s.metadata?.credits || "0", 10);
  if (!uid || !(credits > 0)) return null;
  if (expectUser && uid !== expectUser) return null;
  return addPaid(uid, credits, s.id);
}

export const shape = b => b ? { free: b.free ?? 0, paid: b.paid ?? 0, total: (b.free ?? 0) + (b.paid ?? 0) } : null;
