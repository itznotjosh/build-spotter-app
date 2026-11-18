// Build Spotter server function: /api/guide  (Creative mode)
// The AI build guide: the user describes their car and what they want; the guide asks for anything it needs and
// recommends parts that fit, with fitment details and a shopping search for each.
//
// Cost: a build session uses 1 scan and includes GUIDE_REPLIES_PER_SCAN guide replies (default 15). After that,
// the next reply starts a new session (1 more scan). A reply that fails gives its scan / reply back.
// Needs the Creative mode part of supabase/schema.sql (table guide_chats, functions bs_guide_turn / bs_guide_undo).
//
// POST { car: {year, make, model, generation, trim, transmission, drivetrain, mods, goals, budget},
//        messages: [{role: "user"|"assistant", content}], chat: "<session id from the last reply, or null>" }
//  -> streamed lines of JSON: {p: reply-so-far}..., then {done: true, result: {reply, questions, parts, steps, warnings, car},
//     chat, left, credits} or {error: true, status, code, message, credits}. Checks before billing answer with plain JSON.

import { accountsOn, getUser, guideTurn, guideUndo, GUIDE_MAX, shape } from "../lib/accounts.mjs";
import { guideJSON, DEFAULTS } from "../lib/ai-text.mjs";
import { guideSystem, GUIDE_SCHEMA } from "../lib/guide-prompt.mjs";

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0, n);
const CAR_KEYS = { year: 20, make: 40, model: 60, generation: 80, trim: 80, transmission: 40, drivetrain: 20, mods: 800, goals: 300, budget: 60, garage: 700 };

export default async (req) => {
  if (req.method !== "POST") return json(405, { code: "api", message: "Method not allowed" });
  const provider = (process.env.AI_PROVIDER || "anthropic").toLowerCase().trim();
  const key = (process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return json(500, { code: "server_key" });
  const code = (process.env.ACCESS_CODE || "").trim();
  const accounts = accountsOn();
  const replyCode = (process.env.REPLY_CODE || "").trim();
  const isOwner = replyCode && (req.headers.get("x-reply-code") || "").trim() === replyCode;
  if (!accounts && code && !isOwner && (req.headers.get("x-access-code") || "").trim() !== code) return json(401, { code: "bad_code" });

  let b; try { b = await req.json(); } catch { return json(400, { code: "api", message: "Bad request" }); }
  const car = {};
  for (const [k, n] of Object.entries(CAR_KEYS)) if (b?.car?.[k]) car[k] = clean(b.car[k], n);
  if (!car.make && !car.model) return json(400, { code: "api", message: "Add your car's make and model first." });
  let messages = (Array.isArray(b?.messages) ? b.messages : []).slice(-24)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: clean(m.content, m.role === "user" ? 2000 : 6000) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  // merge accidental back-to-back turns from the same side (the APIs want them alternating)
  messages = messages.reduce((a, m) => { const l = a[a.length - 1]; if (l && l.role === m.role) l.content += "\n\n" + m.content; else a.push({ ...m }); return a; }, []);
  if (!messages.length || messages[messages.length - 1].role !== "user") return json(400, { code: "api", message: "Say what you want to do with the car." });

  // Accounts: one scan per session of GUIDE_MAX replies.
  let user = null, turn = null;
  const chat = /^[0-9a-f-]{36}$/i.test(String(b?.chat || "")) ? String(b.chat) : null;
  if (accounts && !isOwner) {
    user = await getUser(req);
    if (!user) return json(401, { code: "signin" });
    try { turn = await guideTurn(user.id, chat); }
    catch (e) {
      if (e?.http === 404 || /PGRST202|could not find the function/i.test(e?.body || "")) return json(500, { code: "guide_setup" });
      return json(500, { code: "accounts_down" });
    }
    if (!turn?.ok) return json(402, { code: "no_credits", credits: shape(turn) });
  }

  // Streamed as lines of JSON: {"p": "<reply so far>"} while the guide writes (blank lines keep the connection open),
  // then one last line, either {"done": true, result, chat, left, credits} or {"error": true, status, code, message, credits}.
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      const send = o => { try { ctrl.enqueue(enc.encode((o ? JSON.stringify(o) : "") + "\n")); } catch {} };
      const beat = setInterval(() => send(null), 4000);
      send(null);
      let out;
      try {
        const model = process.env.GUIDE_MODEL || process.env.AI_MODEL || DEFAULTS[provider] || DEFAULTS.anthropic;
        const result = await guideJSON(provider, key, model, guideSystem(car), messages, { schema: GUIDE_SCHEMA, timeoutMs: 55000, onReply: p => send({ p }) });
        if (!result || typeof result !== "object") throw { status: 502, code: "invalid_json" };
        out = { done: true, result, chat: turn?.chat || null, left: turn ? Math.max(0, GUIDE_MAX() - turn.replies) : null, charged: !!turn?.charged, credits: shape(turn) };
      } catch (e) {
        let credits = shape(turn);
        if (turn?.ok) { try { credits = shape(await guideUndo(user.id, turn.chat, turn.charged, turn.source)); } catch {} }   // failed replies are free
        out = { error: true, status: e?.status || 502, code: e?.code || "api", message: e?.message, credits };
      }
      clearInterval(beat);
      send(out);
      ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" } });
};

export const config = { path: "/api/guide" };
