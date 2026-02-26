// Shared FAL API helpers used by both server.mjs (local dev) and api/ routes (Vercel)

export const NANO_BANANA_ENDPOINT = "fal-ai/nano-banana-2";
export const NANO_BANANA_EDIT_ENDPOINT = "fal-ai/nano-banana-pro/edit";
export const REMOVE_BG_ENDPOINT = "fal-ai/bria/background/remove";
export const REWRITE_ENDPOINT = "openrouter/router";
export const REWRITE_MODEL = "openai/gpt-4o-mini";

const NUM_WORDS = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateEndpointId(value) {
  return !!value && /^[A-Za-z0-9._/-]+$/.test(value);
}

export function validateRequestId(value) {
  return !!value && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function requestFalJson(apiKey, url, method, payload) {
  const response = await fetch(url, {
    method,
    headers: {
      "Authorization": `Key ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: payload ? JSON.stringify(payload) : undefined
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return { ok: response.ok, status: response.status, data };
}

export async function runDirectModel(apiKey, endpoint, input) {
  if (!validateEndpointId(endpoint)) {
    return { ok: false, status: 400, data: { error: `Invalid endpoint: ${endpoint}` } };
  }
  return requestFalJson(apiKey, `https://fal.run/${endpoint}`, "POST", input);
}

export async function runQueuedModel(apiKey, endpoint, input, timeoutMs = 240000) {
  if (!validateEndpointId(endpoint)) {
    return { ok: false, status: 400, stage: "submit", requestId: "", data: { error: `Invalid endpoint: ${endpoint}` } };
  }

  const submit = await requestFalJson(apiKey, `https://queue.fal.run/${endpoint}`, "POST", input);
  if (!submit.ok) {
    return { ok: false, status: submit.status, stage: "submit", requestId: "", data: submit.data };
  }

  const requestId = submit.data?.request_id;
  if (!validateRequestId(requestId)) {
    return { ok: false, status: 502, stage: "submit", requestId: "", data: { error: "No valid request_id", raw: submit.data } };
  }

  const statusUrl = `https://queue.fal.run/${endpoint}/requests/${requestId}/status`;
  const resultUrl = `https://queue.fal.run/${endpoint}/requests/${requestId}`;
  const timeoutAt = Date.now() + timeoutMs;

  while (Date.now() < timeoutAt) {
    const statusResult = await requestFalJson(apiKey, statusUrl, "GET");
    if (!statusResult.ok) {
      return { ok: false, status: statusResult.status, stage: "status", requestId, data: statusResult.data };
    }

    const state = statusResult.data?.status;
    if (state === "COMPLETED") break;
    if (state === "FAILED") {
      const failedResult = await requestFalJson(apiKey, resultUrl, "GET");
      return { ok: false, status: failedResult.status, stage: "result", requestId, data: failedResult.data };
    }

    await wait(1800);
  }

  if (Date.now() >= timeoutAt) {
    return { ok: false, status: 504, stage: "status", requestId, data: { error: "Timeout" } };
  }

  const result = await requestFalJson(apiKey, resultUrl, "GET");
  if (!result.ok) {
    return { ok: false, status: result.status, stage: "result", requestId, data: result.data };
  }

  let finalData = result.data;
  if (typeof result.data?.response_url === "string" && validateHttpUrl(result.data.response_url)) {
    const responseData = await requestFalJson(apiKey, result.data.response_url, "GET");
    if (responseData.ok) finalData = responseData.data;
  }

  return { ok: true, status: 200, stage: "result", requestId, data: finalData };
}

function normalizeMessageContent(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(p => (typeof p === "string" ? p : p?.text || p?.content || "")).filter(Boolean).join(" ").trim();
  }
  if (value && typeof value === "object") return (value.text || value.content || "").trim();
  return "";
}

function cleanPromptText(text) {
  return text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/g, "").trim();
}

export function extractRewrittenPrompt(payload) {
  const candidates = [];
  const push = (v) => { const n = normalizeMessageContent(v); if (n) candidates.push(n); };

  push(payload?.output);
  push(payload?.text);
  push(payload?.result?.output);
  push(payload?.result?.text);
  push(payload?.choices?.[0]?.message?.content);
  push(payload?.output?.choices?.[0]?.message?.content);
  push(payload?.result?.choices?.[0]?.message?.content);

  if (candidates.length > 0) return cleanPromptText(candidates[0]);

  const stack = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (Array.isArray(current)) { current.forEach(i => stack.push(i)); continue; }
    if (typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "string" && (key === "text" || key === "content" || key === "output")) {
        const cleaned = cleanPromptText(value);
        if (cleaned.length > 20) return cleaned;
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return "";
}

export function extractFirstImageUrl(payload) {
  const candidates = [];
  if (typeof payload?.image?.url === "string") candidates.push(payload.image.url);
  if (Array.isArray(payload?.images)) {
    for (const img of payload.images) {
      if (typeof img === "string") candidates.push(img);
      if (img && typeof img.url === "string") candidates.push(img.url);
    }
  }

  const stack = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (Array.isArray(current)) { current.forEach(i => stack.push(i)); continue; }
    if (typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "string" && value.startsWith("http")) {
        const looksLikeImage = /\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(value) || /(fal\.media|images|cdn)/i.test(value);
        const excluded = /(status|cancel|request|response)_?url/i.test(key);
        if (looksLikeImage && !excluded) candidates.push(value);
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return [...new Set(candidates)].filter(u => validateHttpUrl(u))[0] || "";
}

export function pickErrorMessage(data, fallback) {
  if (Array.isArray(data?.detail) && data.detail.length > 0) {
    const msg = data.detail.map(e => typeof e === "string" ? e : e?.msg || "").filter(Boolean).join(" | ");
    if (msg) return msg;
  }
  if (typeof data?.error === "string" && data.error.trim()) return data.error.trim();
  if (typeof data?.raw === "string" && data.raw.trim()) return data.raw.trim();
  return fallback;
}

export function buildSpritePrompt(basePrompt, gridSize = 4) {
  const w = NUM_WORDS[gridSize] || "four";
  return [
    "STRICT TECHNICAL REQUIREMENTS FOR THIS IMAGE:",
    "",
    `FORMAT: A single image containing a ${w}-by-${w} grid of equally sized cells.`,
    "Every cell must be the exact same dimensions, perfectly aligned, with no gaps or overlap.",
    "",
    "FORBIDDEN: Absolutely no text, no numbers, no letters, no digits, no labels,",
    "no watermarks, no signatures, no UI elements anywhere in the image. The image must",
    "contain ONLY the character illustrations in the grid cells and nothing else.",
    "",
    "CONSISTENCY: The exact same single character must appear in every cell.",
    "Same proportions, same art style, same level of detail, same camera angle throughout.",
    "Isometric three-quarter view. Full body visible head to toe in every cell.",
    "Strong clean silhouette against a plain solid flat-color background.",
    "",
    "ANIMATION FLOW: The cells read left-to-right, top-to-bottom, like reading a page.",
    "This is one continuous motion sequence. Each cell shows the next moment in the movement.",
    "The transition between the last cell of one row and the first cell of the next row",
    `must be just as smooth as transitions within a row — no jumps, no resets.`,
    `Each row contains ${w} phases of the motion. The very last cell loops back seamlessly`,
    "to the very first cell.",
    "",
    "MOTION QUALITY: Show real weight and physics. Bodies shift weight between feet.",
    "Arms counterbalance legs. Torsos rotate into actions. Follow-through on every movement.",
    "No stiff poses — every cell must feel like a freeze-frame of fluid motion.",
    "For locomotion (walk/run): strictly alternate left and right legs — one leg extends forward",
    "while the other pushes behind. Each frame must show a clearly different leg position.",
    "Never repeat the same pose twice in a row.",
    "",
    "CHARACTER AND ANIMATION DIRECTION:",
    basePrompt
  ].join("\n");
}

export function buildRewriteSystemPrompt(gridSize) {
  const w = NUM_WORDS[gridSize] || "four";
  return [
    "You are an animation director and character designer for a sprite sheet pipeline.",
    "Given a character concept, you MUST return exactly two sections, nothing else:",
    "",
    "CHARACTER: A vivid description of the character's appearance — body type, armor, weapons, colors, silhouette, art style. Be extremely specific and visual.",
    "",
    `CHOREOGRAPHY: A ${w}-beat continuous animation loop that showcases this specific character's personality and abilities. Each beat is one row of the sheet. The last beat must transition seamlessly back into the first.`,
    "For each beat, describe the body position, weight distribution, limb placement, and motion arc in one sentence.",
    "The choreography must feel natural and unique to THIS character — a mage animates differently than a knight, a dancer differently than a berserker.",
    "",
    "RULES:",
    "- Never use numbers or digits anywhere.",
    "- Never mention grids, pixels, frames, cells, or image generation.",
    "- Never mention sprite sheets or technical terms.",
    "- Write as if directing a real actor through a motion capture session.",
    `- The ${w} beats must form one fluid, looping performance.`,
    "- For locomotion (walk/run): strictly alternate left and right legs in each beat.",
    "  Describe exact limb positions — which leg is forward, which is pushing off,",
    "  which arm is swinging forward. Every beat must show a distinctly different leg configuration."
  ].join("\n");
}

export function makeDefaultPrompt() {
  const subjects = ["baby dragon", "crystal fox", "tiny samurai cat", "sparkle unicorn", "bamboo panda warrior"];
  const styles = ["clean pixel art", "chibi kawaii", "pastel dreamlike", "cozy storybook", "Studio Ghibli inspired"];
  const subject = subjects[Math.floor(Math.random() * subjects.length)];
  const style = styles[Math.floor(Math.random() * styles.length)];
  return `${subject}, ${style}, isometric action RPG`;
}

export async function uploadToFalStorage(apiKey, buffer, contentType, filename) {
  const initRes = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: { "Authorization": `Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: filename, content_type: contentType })
  });

  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(`Storage initiate failed (${initRes.status}): ${text}`);
  }

  const { upload_url, file_url } = await initRes.json();

  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer
  });

  if (!putRes.ok) throw new Error(`Storage PUT failed (${putRes.status})`);
  return file_url;
}
