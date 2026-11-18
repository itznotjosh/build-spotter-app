// Text-only chat call to the configured AI service (used by Creative mode).
export const DEFAULTS = { anthropic: "claude-sonnet-5-5", openai: "gpt-5.5", gemini: "gemini-3.6-flash" };

export function parseJSON(t) {
  t = String(t || "").trim();
  try { return JSON.parse(t); } catch {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw { status: 502, code: "invalid_json" };
}

// messages: [{role: "user" | "assistant", content: string}], starting with a user turn
export async function chatJSON(provider, key, model, system, messages, { timeoutMs = 55000 } = {}) {
  let url, headers = { "content-type": "application/json" }, body, pick;
  if (provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions"; headers.authorization = "Bearer " + key;
    body = { model, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, ...messages] };
    pick = j => j.choices?.[0]?.message?.content;
  } else if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`; headers["x-goog-api-key"] = key;
    body = { systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { responseMimeType: "application/json" } };
    pick = j => (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  } else {
    url = "https://api.anthropic.com/v1/messages";
    Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01" });
    body = { model, max_tokens: 8192, system, messages };
    pick = j => (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  }
  let res;
  try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw { status: 504, code: "timeout", message: "The guide took too long to answer. Try again, or ask for less at once." }; }
  let j = {}; try { j = await res.json(); } catch {}
  if (!res.ok) {
    console.error("AI error", res.status, JSON.stringify(j).slice(0, 500));
    if (res.status === 401 || res.status === 403) throw { status: 500, code: "server_key" };
    if (res.status === 429) throw { status: 429, code: "rate_limited" };
    throw { status: 502, code: "api", message: "The AI service said: " + (j.error?.message || `HTTP ${res.status}`) };
  }
  const text = pick(j);
  if (provider === "anthropic" && j.stop_reason === "max_tokens") console.warn("guide reply hit max_tokens");
  return parseJSON(text);
}

// Pulls the text of "reply" out of JSON that is still arriving, so the user can watch the answer being written.
export function partialReply(buf) {
  const m = buf.match(/"reply"\s*:\s*"/); if (!m) return "";
  let i = m.index + m[0].length, out = "";
  while (i < buf.length) {
    const c = buf[i];
    if (c === '"') break;
    if (c === "\\") {
      const n = buf[i + 1]; if (n === undefined) break;
      if (n === "u") { const h = buf.slice(i + 2, i + 6); if (h.length < 4) break; out += String.fromCharCode(parseInt(h, 16)); i += 6; continue; }
      out += ({ n: "\n", t: "\t", r: "", b: "", f: "" })[n] ?? n; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

// The build guide's call. Anthropic: streamed, and forced to answer through a tool whose input is the reply schema,
// so the result is always well-formed. onReply(text) gets the reply text as it is written.
// Other providers: their own JSON mode (no live text).
export async function guideJSON(provider, key, model, system, messages, { schema, onReply, timeoutMs = 55000 } = {}) {
  if (provider !== "anthropic" || !schema) return chatJSON(provider, key, model, system, messages, { timeoutMs });
  const body = { model, max_tokens: 8192, stream: true, system, messages,
    tools: [{ name: "guide_reply", description: "Send your reply to the user.", input_schema: schema }],
    tool_choice: { type: "tool", name: "guide_reply" } };
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  } catch { throw { status: 504, code: "timeout", message: "The guide took too long to answer. Try again, or ask for less at once." }; }
  if (!res.ok) {
    let j = {}; try { j = await res.json(); } catch {}
    console.error("AI error", res.status, JSON.stringify(j).slice(0, 500));
    if (res.status === 401 || res.status === 403) throw { status: 500, code: "server_key" };
    if (res.status === 429 || res.status === 529) throw { status: 429, code: "rate_limited" };
    throw { status: 502, code: "api", message: "The AI service said: " + (j.error?.message || `HTTP ${res.status}`) };
  }
  // read the server-sent events; the tool input arrives as pieces of JSON text
  const rd = res.body.getReader(), dec = new TextDecoder();
  let sse = "", json = "", text = "", stop = null, shown = "", last = 0;
  try {
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      sse += dec.decode(value, { stream: true });
      let k;
      while ((k = sse.indexOf("\n")) >= 0) {
        const line = sse.slice(0, k).trim(); sse = sse.slice(k + 1);
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") json += ev.delta.partial_json || "";
        else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") text += ev.delta.text || "";
        else if (ev.type === "message_delta" && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
        else if (ev.type === "error") throw { status: 502, code: ev.error?.type === "overloaded_error" ? "rate_limited" : "api", message: ev.error?.message ? "The AI service said: " + ev.error.message : undefined };
      }
      if (onReply && Date.now() - last > 250) { const r = partialReply(json); if (r !== shown) { shown = r; last = Date.now(); onReply(r); } }
    }
  } catch (e) {
    if (e?.code) throw e;
    throw { status: 504, code: "timeout", message: "The guide took too long to answer. Try again, or ask for less at once." };
  }
  if (stop === "max_tokens") console.warn("guide reply hit max_tokens");
  try { return JSON.parse(json); } catch {}
  if (text) return parseJSON(text);
  // cut off part-way: keep what was written so far rather than failing
  const r = partialReply(json);
  if (r) return { reply: r + (stop === "max_tokens" ? "\n\n(That answer was cut short. Ask me to continue.)" : "") };
  throw { status: 502, code: "invalid_json" };
}
