// Build Spotter server function: /api/analyze
// Holds the AI API key (set in Netlify's environment variables) so it is never sent to the browser.
// It builds the AI instructions itself, so the key can only be used to analyze car photos.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   AI_API_KEY   required  your API key
//   AI_PROVIDER  optional  anthropic (default) | openai | gemini
//   AI_MODEL     optional  model name; defaults below
//   ACCESS_CODE  optional  if set, people must enter this code once before they can scan
//   DONATE_URL   optional  https link shown in the opening notice (PayPal, Buy Me a Coffee, Ko-fi…)

const CATS = ["Wheels","Tires","Suspension","Brakes","Aero & Body","Lighting","Exhaust","Engine","Interior","Other"];
const DEFAULTS = { anthropic: "claude-sonnet-5-5", openai: "gpt-5.5", gemini: "gemini-3.6-flash" };

function makePrompt(o){
  return `You are an expert at identifying cars and car parts from photos (wheels, tires, suspension, brakes, aero, lighting, exhaust, engine, interior).
The attached image is a photo the user took. It is either:
- a CAR (whole or partial): identify the vehicle from the photo alone, then every visible part an enthusiast might want to buy (aftermarket parts, and notable factory parts such as "Factory 18in STI BBS wheels" when that's what's fitted). Set "subject" to "car".
- one or more PARTS on their own (a loose wheel, a coilover, an exhaust, a part on a shelf or in a box, or a close-up where the car itself can't be identified): identify each part. Set "subject" to "parts". If the photo shows what car the parts are on or for, fill "vehicle"; otherwise set "vehicle" to null.
- neither: set "subject" to "none" and say what you see in "summary".
${o.override?`
IMPORTANT: The user says the car is: "${o.override}" (the car in the photo, or the car these parts are on). Treat this as correct even if the photo made you think otherwise. Fill the vehicle fields to match it (split into year, make, model, trim). Re-check every part against this exact car: decide factory vs aftermarket using this model's real factory equipment, use its correct bolt pattern, hub bore and factory wheel/tire sizes, and prefer parts made for this platform.
`:""}
Rules:
- Only list parts you can actually see or that are strongly implied (ride height implies coilovers vs lowering springs). Never invent hidden parts.
- Be specific: brand and model when the design or branding is recognizable. Read any visible text, stamps, stickers or sidewall markings.
- Give the specifications in "detail", separated by " · ": for wheels diameter x width, offset, bolt pattern, finish, construction (forged/flow-formed/cast); for tires size, model, treadwear if readable; for suspension type and estimated drop; for brakes caliper brand and piston count; otherwise the size, material and finish. Say "est." for estimates.
- If unsure of the brand, describe the style and give 1-3 likely candidates in "alternatives".
- confidence is "high" (clear branding or unmistakable design), "medium" (strong visual match), or "low" (educated guess).
- "query" is the best shopping search string for that exact part (brand model size finish), without the car name.
- category must be one of: ${CATS.join(", ")}.
${o.notes?`\nThe user adds: ${o.notes}\n`:""}${o.focus.length?`\nThe user mainly wants: ${o.focus.join(", ")}. Cover those in the most depth, but still list other visible parts.\n`:""}
Reply with only JSON in this shape:
{"subject":"car|parts|none","vehicle":{"year":"2018-2021","make":"","model":"","trim":"","color":"","confidence":"high|medium|low"},"summary":"one sentence describing the build, or what the parts are","parts":[{"category":"Wheels","name":"","detail":"18x9.5 · +38 est. · 5x114.3 · bronze · forged","confidence":"medium","evidence":"what in the photo shows this","query":"","alternatives":[""]}],"photo_tips":"one sentence on what extra angle would improve identification, or empty"}`;
}

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function parseJSON(t) {
  t = String(t || "").trim();
  try { return JSON.parse(t); } catch {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw { status: 502, code: "invalid_json" };
}

async function callAI(provider, key, model, prompt, data) {
  let url, headers = { "content-type": "application/json" }, body, pick;
  if (provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions"; headers.authorization = "Bearer " + key;
    body = { model, response_format: { type: "json_object" }, messages: [{ role: "user", content: [
      { type: "text", text: prompt }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + data } }] }] };
    pick = j => j.choices?.[0]?.message?.content;
  } else if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`; headers["x-goog-api-key"] = key;
    body = { contents: [{ role: "user", parts: [{ inline_data: { mime_type: "image/jpeg", data } }, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" } };
    pick = j => (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  } else {
    url = "https://api.anthropic.com/v1/messages";
    Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01" });
    body = { model, max_tokens: 4096, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data } }, { type: "text", text: prompt }] }] };
    pick = j => (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  let j = {}; try { j = await res.json(); } catch {}
  if (!res.ok) {
    console.error("AI error", res.status, JSON.stringify(j).slice(0, 500));
    if (res.status === 401 || res.status === 403) throw { status: 500, code: "server_key" };
    if (res.status === 429) throw { status: 429, code: "rate_limited" };
    throw { status: 502, code: "api", message: "The AI service said: " + (j.error?.message || `HTTP ${res.status}`) };
  }
  return pick(j);
}

export default async (req) => {
  const provider = (process.env.AI_PROVIDER || "anthropic").toLowerCase().trim();
  const key = (process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
  const code = (process.env.ACCESS_CODE || "").trim();

  if (req.method === "GET") return json(200, { ok: !!key, needsCode: !!code, donateUrl: (process.env.DONATE_URL || "").trim() });
  if (req.method !== "POST") return json(405, { code: "api", message: "Method not allowed" });
  if (!key) return json(500, { code: "server_key" });
  if (code && (req.headers.get("x-access-code") || "").trim() !== code) return json(401, { code: "bad_code" });

  let b; try { b = await req.json(); } catch { return json(400, { code: "api", message: "Bad request" }); }
  const image = typeof b?.image === "string" ? b.image : "";
  if (!image || image.length > 4_500_000 || !/^[A-Za-z0-9+/]+=*$/.test(image)) return json(413, { code: "too_large" });

  const o = {
    override: String(b.override || "").slice(0, 120),
    notes: String(b.notes || "").slice(0, 600),
    focus: (Array.isArray(b.focus) ? b.focus : []).filter(c => CATS.includes(c)),
  };
  try {
    const text = await callAI(provider, key, process.env.AI_MODEL || DEFAULTS[provider] || DEFAULTS.anthropic, makePrompt(o), image);
    return json(200, { result: parseJSON(text) });
  } catch (e) {
    return json(e.status || 502, { code: e.code || "api", message: e.message });
  }
};

export const config = { path: "/api/analyze" };
