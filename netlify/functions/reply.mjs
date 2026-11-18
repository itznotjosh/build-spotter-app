// Build Spotter Reply Desk: /api/reply  (owner only)
// Turns a Build Spotter scan result into a short, honest reply for a "what part is this?" post.
// Each call picks a different style so replies never read the same, but every reply must:
//   answer the asker's question, include the site link once, and disclose in the first person that you built the tool.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   REPLY_CODE   required  your private code for the Reply Desk page (keeps others from using it)
//   AI_API_KEY   required  same key the app uses
//   AI_PROVIDER  optional  anthropic (default) | openai | gemini
//   AI_MODEL     optional  model name

const DEFAULTS = { anthropic: "claude-sonnet-5-5", openai: "gpt-5.5", gemini: "gemini-3.6-flash" };
const TONES = {
  casual: "relaxed and friendly, like a car person replying between errands",
  matter: "matter-of-fact and concise, no filler",
  keen: "warm and a little enthusiastic about the build, but still brief",
  detailed: "helpful and specific, includes one useful extra detail (size, fitment or what to check)",
};
const OPENERS = {
  part: "open by naming the main part they asked about",
  car: "open by naming the car, then get to the part",
  confirm: "open with a short confirmation or reaction to their photo, then the answer",
  tip: "open with the answer framed as a practical tip (what to search for or check)",
  question: "open by restating what they want to know in a few words, then answer it",
};
const LINKS = {
  end: "put the link in the last sentence",
  middle: "work the link into a sentence in the middle",
  ps: "add the link as a short P.S.-style final line",
};
const SHAPES = {
  para: "one short paragraph",
  two: "two short lines separated by a blank line",
  list: "a one-line answer followed by a short list (2-3 items, using '- ') of the parts you spotted",
};
const PLATFORMS = { reddit: "a Reddit comment", forum: "a reply on a car enthusiast forum", other: "a reply in an online car community" };

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const pick = (obj, k) => (Object.prototype.hasOwnProperty.call(obj, k) ? k : Object.keys(obj)[0]);
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);

function trimResult(r) {
  const v = r && r.vehicle ? r.vehicle : null;
  return {
    subject: clean(r?.subject, 10),
    vehicle: v ? { year: clean(v.year, 20), make: clean(v.make, 40), model: clean(v.model, 40), trim: clean(v.trim, 60), confidence: clean(v.confidence, 10) } : null,
    parts: (Array.isArray(r?.parts) ? r.parts : []).slice(0, 10).map(p => ({
      category: clean(p.category, 20), name: clean(p.name, 80), detail: clean(p.detail, 140),
      confidence: clean(p.confidence, 10), alternatives: (Array.isArray(p.alternatives) ? p.alternatives : []).slice(0, 3).map(a => clean(a, 50)),
    })),
  };
}

function makePrompt(o) {
  return `Write ${PLATFORMS[o.platform]} replying to someone who posted a photo asking what car or part it is.
I am the person who built Build Spotter, a free web app that identifies a car and its parts from a photo. I ran their photo through it. Here is what it found (JSON):
${JSON.stringify(o.result)}
${o.post ? `\nTheir post says: "${o.post}"\n` : ""}
Requirements (all mandatory):
1. Answer their actual question first, using the scan result. Lead with the part they asked about if their post names one.
2. Be honest about certainty: for "medium" or "low" confidence say it "looks like" or name the likely alternatives. Never claim it is definitely a brand unless confidence is "high". Suggest confirming size/fitment when relevant.
3. Include this exact link exactly once, written plainly: ${o.link}
4. Clearly say in the first person that I built/made the tool (for example "I built", "I made", "a free tool I made"). Do not hide or soften this.
5. Keep it under ${o.platform === "reddit" ? 75 : 110} words. Plain text only: no headings, no bold, no hashtags, no emojis.
6. Sound like a real enthusiast, not an ad: no hype words (revolutionary, game-changer, ultimate, best, amazing, check out my), no exclamation marks in a row, no call to "upvote" or "follow".
7. Style for this reply: tone is ${TONES[o.tone]}; ${OPENERS[o.opener]}; ${LINKS[o.linkpos]}; format as ${SHAPES[o.shape]}.
${o.avoid.length ? `8. Do NOT start the reply with, or reuse the phrasing of, any of these earlier replies' openings: ${o.avoid.map(a => `"${a}"`).join("; ")}. Use different sentence structure and different wording for the disclosure than those.\n` : ""}
Reply with only JSON: {"reply":"..."}`;
}

async function callAI(provider, key, model, prompt) {
  let url, headers = { "content-type": "application/json" }, body, out;
  if (provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions"; headers.authorization = "Bearer " + key;
    body = { model, temperature: 1, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] };
    out = j => j.choices?.[0]?.message?.content;
  } else if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`; headers["x-goog-api-key"] = key;
    body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 1, responseMimeType: "application/json" } };
    out = j => (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  } else {
    url = "https://api.anthropic.com/v1/messages"; Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01" });
    body = { model, max_tokens: 600, temperature: 1, messages: [{ role: "user", content: prompt }] };
    out = j => (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  if (!res.ok) {
    console.error("AI error", res.status, JSON.stringify(j).slice(0, 400));
    if (res.status === 401 || res.status === 403) throw { status: 500, code: "server_key" };
    if (res.status === 429) throw { status: 429, code: "rate_limited" };
    throw { status: 502, code: "api", message: "The AI service said: " + (j.error?.message || `HTTP ${res.status}`) };
  }
  const t = String(out(j) || "");
  try { return JSON.parse(t).reply; } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)).reply; } catch {} }
  throw { status: 502, code: "invalid_json" };
}

const DISCLOSURE = /\b(i|I)\s*(built|made|created|put together|coded|developed)\b|\bmy (own )?(free )?(app|tool|site)\b|\b(tool|app|site) I (built|made|created)\b/;

export default async (req) => {
  const code = (process.env.REPLY_CODE || "").trim();
  const provider = (process.env.AI_PROVIDER || "anthropic").toLowerCase().trim();
  const key = (process.env.AI_API_KEY || "").trim();
  if (req.method === "GET") return json(200, { ok: !!(code && key) });
  if (req.method !== "POST") return json(405, { code: "api", message: "Method not allowed" });
  if (!code) return json(500, { code: "no_reply_code" });
  if (!key) return json(500, { code: "server_key" });
  if ((req.headers.get("x-reply-code") || "").trim() !== code) return json(401, { code: "bad_code" });

  let b; try { b = await req.json(); } catch { return json(400, { code: "api", message: "Bad request" }); }
  const link = clean(b.link, 200);
  if (!/^https?:\/\/[^\s"<>]+$/i.test(link)) return json(400, { code: "api", message: "The site link must start with https://" });
  const o = {
    result: trimResult(b.result),
    post: clean(b.post, 400),
    link,
    platform: pick(PLATFORMS, b.platform),
    tone: pick(TONES, b.tone), opener: pick(OPENERS, b.opener), linkpos: pick(LINKS, b.linkpos), shape: pick(SHAPES, b.shape),
    avoid: (Array.isArray(b.avoid) ? b.avoid : []).slice(0, 8).map(a => clean(a, 90)),
  };
  if (!o.result.parts.length && !o.result.vehicle) return json(400, { code: "api", message: "Scan the photo first. There's nothing to reply with yet." });
  try {
    let reply = String(await callAI(provider, key, process.env.AI_MODEL || DEFAULTS[provider] || DEFAULTS.anthropic, makePrompt(o)) || "").trim();
    // enforce the non-negotiables even if the model slipped
    if (!reply.includes(link)) reply += `\n\n${link}`;
    if (!DISCLOSURE.test(reply)) reply += `\n(Full disclosure: I built that tool.)`;
    return json(200, { reply, style: { tone: o.tone, opener: o.opener, linkpos: o.linkpos, shape: o.shape } });
  } catch (e) {
    return json(e.status || 502, { code: e.code || "api", message: e.message });
  }
};

export const config = { path: "/api/reply" };
