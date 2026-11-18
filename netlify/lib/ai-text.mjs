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
export async function chatJSON(provider, key, model, system, messages) {
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
    body = { model, max_tokens: 4096, system, messages };
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
  return parseJSON(pick(j));
}
