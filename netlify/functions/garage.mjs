// Build Spotter server function: /api/garage  (Creative mode 3D garage, made with Meshy)
// Needs MESHY_API_KEY. With accounts on, also the 3D garage block of supabase/schema.sql (table garage_jobs, bucket garage).
//
// POST {action: "start", car, paint, photos: ["data:image/jpeg;base64,..."] (0-3), mods: [{category, name, detail}]}
//      Turns the garage on for a build: makes version 1 of the user's car. Costs GARAGE_START_COST scans (default 5).
// POST {action: "update", prev: "<job of the version to build on>", car, paint, mods (everything on the car now),
//       added: [...], removed: [...]}
//      A new version with the changes. Costs GARAGE_UPDATE_COST scans (default 4).
//   -> {job, cost, credits}
// GET  ?job=<job>  -> {status: "working", step: "design"|"model", progress, views?, job?} | {status: "done", url, views}
//                   | {status: "failed", message, refunded}
// GET  ?file=<job> (only without accounts) streams the model from Meshy, which keeps it for 3 days.
// A version that fails gives its scans back.

import { accountsOn, getUser, spend, refund, shape, balance } from "../lib/accounts.mjs";
import { garageOn, COST, PATH, clip, getTask, firstDesign, nextDesign, startDesign, startModel,
  jobInsert, jobGet, jobMove, keepFile, packJob, unpackJob } from "../lib/garage.mjs";

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const CAR_KEYS = { year: 20, make: 40, model: 60, generation: 80, trim: 80 };
const UUID = /^[0-9a-f-]{36}$/i;
// progress: the views are the first quarter, the 3D model the rest
const pct = (step, p) => step === "design" ? Math.round((p || 0) * .25) : 25 + Math.round((p || 0) * .72);
const modsIn = (a, n = 16) => (Array.isArray(a) ? a : []).slice(0, n)
  .map(m => ({ category: clip(m?.category, 30), name: clip(m?.name, 120), detail: clip(m?.detail, 120) })).filter(m => m.name);

async function charge(uid, n) {                 // takes n scans, or none
  const got = []; let last = null;
  for (let i = 0; i < n; i++) {
    const r = await spend(uid);
    if (!r?.ok) { for (const s of got) await refund(uid, s).catch(() => {}); return { ok: false, credits: shape(r) }; }
    got.push(r.source); last = r;
  }
  return { ok: true, sources: got, credits: shape(last || await balance(uid)) };
}
async function giveBack(uid, sources) { let c = null; for (const s of sources || []) { try { c = await refund(uid, s); } catch {} } return shape(c); }

export default async (req) => {
  if (!garageOn()) return json(503, { code: "garage_off", message: "The 3D garage isn't set up on this server (MESHY_API_KEY)." });
  const accounts = accountsOn();
  const code = (process.env.ACCESS_CODE || "").trim();
  const replyCode = (process.env.REPLY_CODE || "").trim();
  const isOwner = replyCode && (req.headers.get("x-reply-code") || "").trim() === replyCode;
  if (!accounts && code && !isOwner && (req.headers.get("x-access-code") || "").trim() !== code) return json(401, { code: "bad_code" });
  const url = new URL(req.url);

  // without accounts: the finished model straight from Meshy
  if (req.method === "GET" && url.searchParams.get("file")) {
    if (accounts) return json(404, { code: "api" });
    const t = unpackJob(url.searchParams.get("file"));
    if (!t?.m) return json(400, { code: "api" });
    try {
      const glb = (await getTask(PATH.model, t.m)).model_urls?.glb;
      const r = glb && await fetch(glb);
      if (!r?.ok) return json(410, { code: "garage_gone", message: "This model has expired (Meshy keeps files for 3 days)." });
      return new Response(r.body, { headers: { "content-type": "model/gltf-binary", "cache-control": "private, max-age=86400" } });
    } catch (e) { return json(e?.status || 500, { code: e?.code || "api", message: e?.message }); }
  }

  let user = null;
  if (accounts && !isOwner) { user = await getUser(req); if (!user) return json(401, { code: "signin" }); }
  const uid = user?.id, tracked = accounts && !!uid;

  try {
    if (req.method === "POST") {
      let b; try { b = await req.json(); } catch { return json(400, { code: "api", message: "Bad request" }); }
      const car = {}; for (const [k, n] of Object.entries(CAR_KEYS)) if (b?.car?.[k]) car[k] = clip(b.car[k], n);
      if (!car.make && !car.model) return json(400, { code: "api", message: "Add the car's make and model first." });
      const paint = clip(b?.paint, 80), mods = modsIn(b?.mods);
      let design, prev = null, root = null;

      if (b?.action === "start") {
        const photos = (Array.isArray(b?.photos) ? b.photos : []).slice(0, 3);
        if (photos.some(p => !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(p)) || String(p).length > 2.5e6))
          return json(400, { code: "api", message: "Send up to 3 JPG, PNG or WebP photos, each under 2 MB." });
        design = firstDesign({ car, paint, photos, mods });
      } else if (b?.action === "update") {
        const added = modsIn(b?.added, 8), removed = modsIn(b?.removed, 8);
        if (!added.length && !removed.length) return json(400, { code: "api", message: "Add or remove a part first." });
        const kept = mods.filter(m => !added.some(a => a.name === m.name));
        let refs;
        if (tracked) {
          prev = UUID.test(String(b?.prev)) ? await jobGet(b.prev, uid) : null;
          if (!prev || prev.stage !== "done" || !prev.views?.length) return json(400, { code: "api", message: "Wait for the current 3D car to finish first." });
          root = prev.root_id ? await jobGet(prev.root_id, uid) : null;
          // the previous version's views, plus the first version's front view so the car never drifts from the original
          refs = [...prev.views.slice(0, 4), ...(root?.views?.[0] && !prev.views.includes(root.views[0]) ? [root.views[0]] : [])];
        } else {
          const t = unpackJob(b?.prev);
          if (!t?.d) return json(400, { code: "api", message: "Wait for the current 3D car to finish first." });
          refs = (await getTask(PATH[t.p], t.d)).image_urls || [];
          if (!refs.length) return json(410, { code: "garage_gone", message: "The earlier version has expired. Turn the garage on again." });
        }
        design = nextDesign({ car, paint, refs, kept, added, removed });
      } else return json(400, { code: "api", message: "Unknown 3D job" });

      const cost = tracked ? (b.action === "start" ? COST.start() : COST.update()) : 0;
      let paid = { sources: [], credits: null };
      if (cost) { paid = await charge(uid, cost); if (!paid.ok) return json(402, { code: "no_credits", credits: paid.credits, cost }); }
      let designId;
      try { designId = await startDesign(design); }
      catch (e) { const credits = await giveBack(uid, paid.sources); return json(e.status || 502, { code: e.code || "garage_down", message: e.message, credits }); }

      if (!tracked) return json(200, { job: packJob({ s: "design", p: design.path, d: designId, i: { car, paint, mods } }), cost: 0 });
      const row = await jobInsert({ user_id: uid, kind: b.action, stage: "design", design_path: design.path, design_id: designId,
        prev_id: prev?.id || null, root_id: prev ? (prev.root_id || prev.id) : null, input: { car, paint, mods }, cost, sources: paid.sources });
      return json(200, { job: row.id, cost, credits: paid.credits });
    }

    if (req.method === "GET") {
      const arg = url.searchParams.get("job") || "";
      if (!tracked) {                                     // the browser holds the job
        const t = unpackJob(arg);
        if (!t || !["design", "model"].includes(t.s)) return json(400, { code: "api" });
        if (t.s === "design") {
          const task = await getTask(PATH[t.p], t.d);
          if (task.status === "FAILED" || task.status === "CANCELED") return json(200, { status: "failed", message: task.task_error?.message || "Meshy couldn't draw the car." });
          if (task.status !== "SUCCEEDED") return json(200, { status: "working", step: "design", progress: pct("design", task.progress), queued: task.preceding_tasks || null });
          const m = await startModel({ designTask: t.d, ...t.i });
          return json(200, { status: "working", step: "model", progress: 25, views: task.image_urls || [], job: packJob({ ...t, s: "model", m }) });
        }
        const task = await getTask(PATH.model, t.m);
        if (task.status === "FAILED" || task.status === "CANCELED") return json(200, { status: "failed", message: task.task_error?.message || "Meshy couldn't make the 3D model." });
        if (task.status !== "SUCCEEDED") return json(200, { status: "working", step: "model", progress: pct("model", task.progress), queued: task.preceding_tasks || null });
        return json(200, { status: "done", url: `/api/garage?file=${packJob({ m: t.m })}` });
      }

      if (!UUID.test(arg)) return json(400, { code: "api" });
      let row = await jobGet(arg, uid);
      if (!row) return json(404, { code: "api", message: "That 3D job wasn't found." });
      if (row.stage === "done") return json(200, { status: "done", url: row.file_url, views: row.views });
      if (row.stage === "failed") return json(200, { status: "failed", message: row.error || "Meshy couldn't make this version.", refunded: true });
      const fail = async (from, msg) => {
        const moved = await jobMove(row.id, from, { stage: "failed", error: clip(msg || "Meshy couldn't make this version.", 300) });
        return json(200, { status: "failed", message: moved?.error || msg, credits: moved ? await giveBack(uid, row.sources) : null, refunded: true });
      };
      // a step that was interrupted (the function stopped mid-way) runs again after a minute
      if (["design_saving", "saving"].includes(row.stage)) {
        if (Date.now() - Date.parse(row.updated_at) < 60000) return json(200, { status: "working", step: row.stage === "saving" ? "model" : "design", progress: row.stage === "saving" ? 98 : 25, views: row.views || [] });
        row = await jobMove(row.id, row.stage, { stage: row.stage === "saving" ? "model" : "design" }) || row;
      }

      if (row.stage === "design") {
        const task = await getTask(PATH[row.design_path], row.design_id);
        if (task.status === "FAILED" || task.status === "CANCELED") return fail("design", task.task_error?.message || "Meshy couldn't draw the car.");
        if (task.status !== "SUCCEEDED") return json(200, { status: "working", step: "design", progress: pct("design", task.progress), queued: task.preceding_tasks || null });
        if (!await jobMove(row.id, "design", { stage: "design_saving" })) return json(200, { status: "working", step: "design", progress: 25 });
        let views = [];
        try {
          // keep the views: the next version is drawn from them
          views = await Promise.all((task.image_urls || []).slice(0, 4).map((u, i) => keepFile(uid, `${row.id}/view${i}.png`, u)));
        } catch (e) { await jobMove(row.id, "design_saving", { stage: "design", updated_at: new Date(0).toISOString() }); throw e; }
        let modelId;
        try { modelId = await startModel({ designTask: row.design_id, ...row.input }); }
        catch (e) { if (e.code === "rate_limited" || e.status >= 500 && e.code === "garage_down") { await jobMove(row.id, "design_saving", { stage: "design", updated_at: new Date(0).toISOString() }); throw e; }
          return fail("design_saving", e.message); }
        await jobMove(row.id, "design_saving", { stage: "model", model_id: modelId, views });
        return json(200, { status: "working", step: "model", progress: 25, views });
      }
      if (row.stage === "model") {
        const task = await getTask(PATH.model, row.model_id);
        if (task.status === "FAILED" || task.status === "CANCELED") return fail("model", task.task_error?.message || "Meshy couldn't make the 3D model.");
        if (task.status !== "SUCCEEDED") return json(200, { status: "working", step: "model", progress: pct("model", task.progress), queued: task.preceding_tasks || null, views: row.views || [] });
        if (!await jobMove(row.id, "model", { stage: "saving" })) return json(200, { status: "working", step: "model", progress: 98, views: row.views || [] });
        try {
          const fileUrl = await keepFile(uid, `${row.id}/car.glb`, task.model_urls?.glb, "model/gltf-binary");
          await jobMove(row.id, "saving", { stage: "done", file_url: fileUrl });
          return json(200, { status: "done", url: fileUrl, views: row.views || [] });
        } catch (e) { await jobMove(row.id, "saving", { stage: "model", updated_at: new Date(0).toISOString() }); throw e; }
      }
      return json(200, { status: "working", step: "design", progress: 0 });
    }
    return json(405, { code: "api" });
  } catch (e) {
    if (e?.code === "garage_setup") return json(500, { code: "garage_setup", message: "The 3D garage isn't set up in Supabase yet: run the latest supabase/schema.sql." });
    return json(e?.status || 500, { code: e?.code || "api", message: e?.message });
  }
};

export const config = { path: "/api/garage" };
