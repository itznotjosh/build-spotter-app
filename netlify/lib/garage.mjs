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

// Meshy's image prompts are kept under ~1000 characters; the list of parts is what gets shortened, never the instructions
const MAX = 1000;
const fit = (head, list, tail) => head + clip(list, Math.max(80, MAX - head.length - tail.length)) + tail;

export function firstDesign({ car, paint, photos, mods }) {
  const p = clip(paint, 80), has = lines(mods).join("; ");
  if (photos?.length) return { path: "i2i", body: { ai_model: IMAGE_MODEL(), reference_image_urls: photos.slice(0, 4), generate_multi_view: true,
    prompt: fit(`Studio reference views of the exact car in these photos, a ${carText(car)}. Keep everything as it really is: body shape and proportions, exact paint colour, tone and finish${p ? ` (${p})` : ""}, wheels, tyres, ride height, lights, grille, badges`,
      has ? ` and these parts: ${has}` : "", `. ${SMOOTH} ${LOOK}`) } };
  return { path: "t2i", body: { ai_model: IMAGE_MODEL(), generate_multi_view: true,
    prompt: fit(`Studio photographs of a real ${carText(car)}, exactly as the production car looks for that year and generation: correct body lines, proportions, headlights, tail lights, grille and badges. ${p ? `${p} paint` : "A common factory paint colour"}, `,
      has ? `with: ${has}` : "factory wheels and factory ride height", `. ${SMOOTH} ${LOOK}`) } };
}
// a new version: edit the previous version's views, keep everything else
export function nextDesign({ car, paint, refs, kept, added, removed }) {
  const change = [...lines(added), ...(removed || []).slice(0, 8).map(m => `remove ${clip(m.name, 100)} and put back the factory part`)].join("; ");
  const k = lines(kept).map(x => x.split(":")[0]).join("; ");
  return { path: "i2i", body: { ai_model: IMAGE_MODEL(), reference_image_urls: refs.slice(0, 5), generate_multi_view: true,
    prompt: fit(`These are studio views of one specific car, a ${carText(car)}. Make the same set of views of the SAME car with only these changes: `,
      change, `. Keep everything else exactly as in the references: body shape, paint colour, tone and finish${paint ? ` (${clip(paint, 80)})` : ""}, lights, badges, camera angles, background${k ? ` and the parts already on it (${clip(k, 240)})` : ""}. Parts must look properly installed. ${SMOOTH} ${LOOK}`) } };
}
export function modelBody({ designTask, car, paint, mods }) {
  return { input_task_id: designTask, ai_model: "latest", geometry_resolution: "2k", should_remesh: true, target_polycount: 150000,
    should_texture: true, texture_model: "meshy-7", enable_pbr: true, image_enhancement: true, remove_lighting: true, target_formats: ["glb"],
    texture_prompt: (`Match the colours in the reference views exactly. ${clip(paint, 80) || "The car's paint"}: one even colour and tone across every panel, smooth glossy clear coat with no blotches, noise or bumps. `
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
