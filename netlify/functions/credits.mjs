// /api/credits
//   GET                     → the signed-in user's balance: { credits: { free, paid, total }, email }
//   POST { session_id }     → after returning from Stripe Checkout: confirms the payment and adds the credits
//                             right away (the Stripe webhook does the same; whichever comes first wins, never both).
import { accountsOn, getUser, balance, stripe, paymentsOn, creditSession, shape, json } from "../lib/accounts.mjs";

export default async (req) => {
  if (!accountsOn()) return json(404, { code: "accounts_off" });
  const user = await getUser(req);
  if (!user) return json(401, { code: "signin" });
  try {
    let added = 0;
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const sid = String(b.session_id || "");
      if (paymentsOn() && /^cs_[A-Za-z0-9_]+$/.test(sid)) {
        const s = await stripe("GET", `checkout/sessions/${encodeURIComponent(sid)}`);
        const r = await creditSession(s, user.id);
        added = r?.added || 0;
      }
    }
    return json(200, { credits: shape(await balance(user.id)), added, email: user.email });
  } catch (e) {
    return json(e.status || 500, { code: e.code || "accounts_down" });
  }
};

export const config = { path: "/api/credits" };
