// 3D garage (Creative mode): a 3D model of the user's car that gets a new version each time they add parts.
// Made with Meshy (meshy.ai). Every version has two steps:
//   1. design  Meshy makes a set of matching studio views of the car (several angles).
//              First version: from the user's photos (Image to Image) or from the car's details (Text to Image).
//              Later versions: Meshy edits the PREVIOUS version's views, so the car stays the same car (same paint,
//              tone, body, angles, earlier parts) and only the new parts change. This is how each version remembers the last.
//   2. model   Meshy turns those views into a textured 3D model (Multi-Image to 3D), with fine geometry and the
//              lighting taken out of the paint so it reads as clean, smooth paint.
// Views and models are copied to Supabase Storage (bucket "garage"): Meshy deletes its files after 3 days, and later
// versions need the earlier views as references.
import { SB_URL } from "./accounts.mjs";
import { chatJSON, DEFAULTS } from "./ai-text.mjs";

const env = k => (process.env[k] || "").trim();
export const garageOn = () => !!env("MESHY_API_KEY");
const num = (k, d) => { const n = parseInt(env(k), 10); return Number.isFinite(n) && n >= 0 ? n : d; };
export const COST = { start: () => num("GARAGE_START_COST", 5), update: () => num("GARAGE_UPDATE_COST", 4) };
const IMAGE_MODEL = () => env("MESHY_IMAGE_MODEL") || "nano-banana-2";
const SB_SERVICE = () => env("SUPABASE_SERVICE_ROLE_KEY");

const MESHY = "https://api.meshy.ai/openapi";
export const PATH = { t2i: "/v1/text-to-image", i2i: "/v1/image-to-image", model: "/v1/multi-image-to-3d" };

export async function meshy(method, path, body) {
  let r;
  try {
    r = await fetch(MESHY + path, { method, signal: AbortSignal.timeout(20000),
      headers: { authorization: "Bearer " + env("MESHY_API_KEY"), "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined });
  } catch { throw { status: 502, code: "garage_down", message: "Couldn't reach Meshy. Try again in a minute." }; }
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch {}
  if (!r.ok) {
    console.error("meshy", method, path, r.status, t.slice(0, 400));
    if (r.status === 401) throw { status: 500, code: "garage_key", message: "The 3D service key (MESHY_API_KEY) is missing or wrong." };
    if (r.status === 402) throw { status: 500, code: "garage_credits", message: "The 3D service is out of credits, or this Meshy plan can't use that model. Check the Meshy account." };
    if (r.status === 429) throw { status: 429, code: "rate_limited" };
    throw { status: 502, code: "garage_down", message: "Meshy said: " + (j.message || `HTTP ${r.status}`) };
  }
  return j;
}
export const getTask = (path, id) => meshy("GET", `${path}/${encodeURIComponent(id)}`);
async function create(path, body) {
  const j = await meshy("POST", path, body);
  if (!j.result) throw { status: 502, code: "garage_down", message: "Meshy didn't start the job." };
  return j.result;
}

/* ---------- what Meshy is asked for ---------- */
export const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
export function carText(car = {}) {
  const name = [car.year, car.make, car.model].map(x => clip(x, 60)).filter(Boolean).join(" ");
  const gen = clip(car.generation, 60), trim = clip(car.trim, 80);
  return [name, gen && `(${gen})`, trim].filter(Boolean).join(" ") || "car";
}
// how each kind of part should show up, so it looks installed rather than pasted on
function modLine(m) {
  const n = clip(m.name, 100), d = clip(m.detail, 100), x = d ? `${n} (${d})` : n;
  switch (m.category) {
    case "Suspension": return `${x}: the car sits lower, with a small, even gap between the tyres and the arches all round; wheels stay centred in the arches`;
    case "Wheels": return `${x}: replace all four wheels with these, the same design on every corner, correct size for the arches`;
    case "Tires": return `${x}: these tyres on all four wheels, correct sidewall height`;
    case "Aero & Body": return /wide|flare|overfender|fender/i.test(n + d)
      ? `${x}: wider fenders and arches front and rear, fitted to the body and painted to match unless the part says otherwise, wheels filling the wider arches`
      : `${x}: fitted to the body, following its lines`;
    case "Lighting": return `${x}: fitted in place of the factory lights`;
    case "Exhaust": return `${x}: visible exhaust tips at the back`;
    case "Paint": return `paint changed to ${n}${d ? " (" + d + ")" : ""} over the whole body`;
    default: return x;
  }
}
const lines = list => (list || []).slice(0, 12).map(modLine);
const LOOK = "Plain light grey studio background, soft even lighting from above, no harsh reflections, no people, no other cars, no text, no number plates. The whole car in frame and sharp in every view, realistic photograph.";
const SMOOTH = "Body panels smooth and clean, with no dents, ripples, bumps or warping; crisp panel gaps; glass clean and dark; tyres black rubber.";

/* ---------- shared memory with the build guide ----------
   Before Meshy draws a version, the same AI that runs the build guide reads the same conversation (what the user asked
   for, the parts it recommended with their sizes and finishes, the car facts it learned) plus what's on the 3D car,
   and writes exact visual instructions for this version. If that call fails, the built-in wording below is used. */
const BRIEF_SYSTEM = `You write instructions for an AI image editor that draws one specific car, the user's own, in a 3D-model pipeline. The user is planning modifications with Build Spotter's build guide; you get their conversation, the car's details, what is already on their 3D car, and the change to show in this version.
Use the conversation to know the exact car (generation, body style, trim, colour) and exactly which part, size, finish and look the user chose or the guide recommended (for example how low, how flush, what wheel design). Describe only what can be seen from outside the car, precisely and literally: shapes, spoke count and style, sizes relative to the arches, finish and colour, ride height and fender gap, how parts sit on the body. Never ask for printed text, logos or brand names to appear; describe the design instead. Don't invent parts that weren't chosen.
Reply with only JSON: {"car": "the car exactly as it is before this change: body style, generation details, paint colour and finish, wheels, ride height and parts already fitted (max 60 words)", "change": "exactly what changes in this version and how it looks fitted to this car (max 70 words; empty for the first version unless parts are listed)", "paint": "paint colour and finish, short", "materials": "paint, wheel finish, trim and lens materials for texturing (max 30 words)"}`;
export async function briefFor({ car, paint, memo, mods, added, removed, first, demo }) {
  const key = env("AI_API_KEY") || env("ANTHROPIC_API_KEY"); if (!key) return null;
  const provider = (env("AI_PROVIDER") || "anthropic").toLowerCase();
  const model = env("GUIDE_MODEL") || env("AI_MODEL") || DEFAULTS[provider] || DEFAULTS.anthropic;
  const list = a => (a || []).map(m => `- ${m.category}: ${m.name}${m.detail ? ` (${m.detail})` : ""}`).join("\n") || "- none";
  const user = `Car: ${carText(car)}${paint ? `\nPaint the user gave: ${paint}` : ""}
On the 3D car before this version:\n${list(mods?.filter(m => !(added || []).some(a => a.name === m.name)))}
${first ? "This is the first version: draw the car as it is." : `Change for this version${demo ? " (a demo of one part, to preview it)" : ""}:\nAdd:\n${list(added)}\nRemove (put back factory):\n${list(removed)}`}

The conversation with the build guide (most recent last):
${String(memo || "").slice(-7000) || "(no conversation yet)"}`;
  try {
    const j = await chatJSON(provider, key, model, BRIEF_SYSTEM, [{ role: "user", content: user }], { timeoutMs: 25000 });
    const out = { car: clip(j?.car, 420), change: clip(j?.change, 480), paint: clip(j?.paint, 80), materials: clip(j?.materials, 220) };
    return out.car ? out : null;
  } catch (e) { console.error("garage brief", e?.code || e); return null; }
}

/* ---------- the garage assistant: "try this on my car" ---------- */
export const ONE_OF = ["Wheels", "Tires", "Suspension", "Paint"];        // one at a time: a new one replaces the old
const VISIBLE = ["Wheels", "Tires", "Suspension", "Aero & Body", "Lighting", "Exhaust", "Paint"];
const TRY_SYSTEM = `You are the assistant in Build Spotter's 3D garage. The user types something they want to try on their own car in 3D: a specific part (even one nobody recommended), a style, a colour or a change. Turn it into ONE specific visible part or change for their exact car, using the car's details and their build conversation for context.
Reply with only JSON: {"visible": true or false, "category": one of ${VISIBLE.join(", ")}, "name": "a short specific name, a real product when they named one or one fits (e.g. 'Rotiform BLQ 19x9.5 gold')", "detail": "size, finish and how it sits on this car (max 20 words)", "note": "one or two short sentences to the user: what they'll see, and any real fitment catch for this car (offset, rubbing, needs a different part); honest, no hype"}
Set visible to false only if it can't be seen from outside the car (engine, tune, interior), and say so in note.`;
export async function interpretTry({ car, paint, text, memo, mods }) {
  const fallback = { visible: true, part: { category: "Aero & Body", name: clip(text, 120), detail: "" }, note: "" };
  const key = env("AI_API_KEY") || env("ANTHROPIC_API_KEY"); if (!key) return fallback;
  const provider = (env("AI_PROVIDER") || "anthropic").toLowerCase();
  const model = env("GUIDE_MODEL") || env("AI_MODEL") || DEFAULTS[provider] || DEFAULTS.anthropic;
  const user = `Car: ${carText(car)}${paint ? `, paint: ${paint}` : ""}
On the 3D car now: ${(mods || []).map(m => m.name).join(", ") || "stock"}
They want to try: ${clip(text, 300)}

Build conversation (most recent last):
${String(memo || "").slice(-4000) || "(none)"}`;
  try {
    const j = await chatJSON(provider, key, model, TRY_SYSTEM, [{ role: "user", content: user }], { timeoutMs: 20000 });
    const category = VISIBLE.includes(j?.category) ? j.category : "Aero & Body";
    return { visible: j?.visible !== false, note: clip(j?.note, 300),
      part: { category, name: clip(j?.name, 120) || clip(text, 120), detail: clip(j?.detail, 160) } };
  } catch (e) { console.error("garage try", e?.code || e); return fallback; }
}

// Meshy image prompts are kept under ~1600 characters; the list of parts is what gets shortened, never the instructions
const MAX = 1600;
const fit = (head, list, tail) => head + clip(list, Math.max(80, MAX - head.length - tail.length)) + tail;

export function firstDesign({ car, paint, photos, mods, brief }) {
  const p = clip(brief?.paint || paint, 80), has = brief ? [brief.car, brief.change].filter(Boolean).join(" ") : lines(mods).join("; ");
  if (photos?.length) return { path: "i2i", body: { ai_model: IMAGE_MODEL(), reference_image_urls: photos.slice(0, 4), generate_multi_view: true,
    prompt: fit(`Studio reference views of the exact car in these photos, a ${carText(car)}. Keep everything as it really is: body shape and proportions, exact paint colour, tone and finish${p ? ` (${p})` : ""}, wheels, tyres, ride height, lights, grille, badges`,
      has ? (brief ? `. What the car is: ${has}` : ` and these parts: ${has}`) : "", `. ${SMOOTH} ${LOOK}`) } };
  return { path: "t2i", body: { ai_model: IMAGE_MODEL(), generate_multi_view: true,
    prompt: fit(`Studio photographs of a real ${carText(car)}, exactly as the production car looks for that year and generation: correct body lines, proportions, headlights, tail lights, grille and badges. ${p ? `${p} paint` : "A common factory paint colour"}, `,
      has ? (brief ? has : `with: ${has}`) : "factory wheels and factory ride height", `. ${SMOOTH} ${LOOK}`) } };
}
// a new version: edit the previous version's views, keep everything else
export function nextDesign({ car, paint, refs, kept, added, removed, brief }) {
  const change = brief?.change || [...lines(added), ...(removed || []).slice(0, 8).map(m => `remove ${clip(m.name, 100)} and put back the factory part`)].join("; ");
  const k = brief?.car ? clip(brief.car, 420) : lines(kept).map(x => x.split(":")[0]).join("; ");
  paint = brief?.paint || paint;
  return { path: "i2i", body: { ai_model: IMAGE_MODEL(), reference_image_urls: refs.slice(0, 5), generate_multi_view: true,
    prompt: fit(`These are studio views of one specific car, a ${carText(car)}. Make the same set of views of the SAME car with only these changes: `,
      change, `. Keep everything else exactly as in the references: body shape, paint colour, tone and finish${paint ? ` (${clip(paint, 80)})` : ""}, lights, badges, camera angles, background${k ? (brief?.car ? `. The car as it is now: ${k}` : ` and the parts already on it (${clip(k, 240)})`) : ""}. Parts must look properly installed. ${SMOOTH} ${LOOK}`) } };
}
export function modelBody({ designTask, car, paint, mods, brief }) {
  paint = brief?.paint || paint;
  return { input_task_id: designTask, ai_model: "latest", geometry_resolution: "2k", should_remesh: true, target_polycount: 150000,
    should_texture: true, texture_model: "meshy-7", enable_pbr: true, image_enhancement: true, remove_lighting: true, target_formats: ["glb"],
    texture_prompt: (`Match the colours in the reference views exactly. ${clip(paint, 80) || "The car's paint"}: one even colour and tone across every panel, smooth glossy clear coat with no blotches, noise or bumps. `
      + (brief?.materials ? `${brief.materials} ` : "")
      + `Dark tinted glass, black rubber tyres, metal wheels${(mods || []).some(m => m.category === "Wheels") ? " as in the references" : ""}, chrome and black trim as in the references, clear light lenses.`).slice(0, 790) };
}
export const startDesign = d => create(PATH[d.path], d.body);
export const startModel = o => create(PATH.model, modelBody(o));

/* ---------- Supabase: job rows (table garage_jobs) and files (bucket garage) ---------- */
async function sb(method, path, body, headers = {}) {
  const r = await fetch(`${SB_URL()}${path}`, { method,
    headers: { apikey: SB_SERVICE(), authorization: `Bearer ${SB_SERVICE()}`, "content-type": "application/json", ...headers },
    body: body == null ? undefined : (body instanceof Uint8Array ? body : JSON.stringify(body)) });
  const t = await r.text();
  if (!r.ok) { console.error("supabase", method, path, r.status, t.slice(0, 300)); throw { status: 500, code: /relation|does not exist|column|PGRST20[45]|Bucket not found/i.test(t) ? "garage_setup" : "accounts_down", http: r.status, body: t }; }
  return t ? JSON.parse(t) : null;
}
export const jobInsert = row => sb("POST", "/rest/v1/garage_jobs", row, { prefer: "return=representation" }).then(r => r[0]);
export const jobGet = (id, uid) => sb("GET", `/rest/v1/garage_jobs?id=eq.${id}&user_id=eq.${uid}&select=*`).then(r => r[0] || null);
// changes a job only if it is still at stage `from`, so two polls never both start the next step
export const jobMove = (id, from, patch) => sb("PATCH", `/rest/v1/garage_jobs?id=eq.${id}&stage=eq.${from}`, { updated_at: new Date().toISOString(), ...patch }, { prefer: "return=representation" }).then(r => r[0] || null);
export async function keepFile(uid, name, url, type) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw { status: 502, code: "garage_down", message: "Couldn't download a file from Meshy." };
  const bytes = new Uint8Array(await r.arrayBuffer());
  const ct = type || r.headers.get("content-type") || "application/octet-stream";
  await sb("POST", `/storage/v1/object/garage/${uid}/${name}`, bytes, { "content-type": ct, "x-upsert": "true", "cache-control": "31536000" });
  return `${SB_URL()}/storage/v1/object/public/garage/${uid}/${name}`;
}

/* ---------- without accounts: the job lives in a token the browser keeps ---------- */
export const packJob = o => Buffer.from(JSON.stringify(o)).toString("base64url");
export function unpackJob(s) { try { const o = JSON.parse(Buffer.from(String(s), "base64url").toString()); return o && typeof o === "object" ? o : null; } catch { return null; } }
