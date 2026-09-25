import { llmConfig, llmEnabled } from "./config.js";

/**
 * Chat completion against an OpenAI-compatible /chat/completions endpoint.
 * @param {{ system?: string, user: string, temperature?: number, json?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function chat({ system, user, temperature = 0.7, json = true } = {}) {
  if (!llmEnabled()) {
    throw new Error("LLM_API_KEY is missing — add it to edit/.env");
  }

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const body = {
    model: llmConfig.model,
    messages,
    temperature,
  };
  if (json) {
    body.response_format = { type: "json_object" };
  }

  const headers = {
    Authorization: `Bearer ${llmConfig.apiKey}`,
    "Content-Type": "application/json",
  };
  if (llmConfig.baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = llmConfig.httpReferer;
    headers["X-Title"] = llmConfig.appName;
  }

  const res = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      detail = JSON.parse(text)?.error?.message || detail;
    } catch {
      /* keep raw */
    }
    throw new Error(`LLM ${res.status}: ${detail}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("LLM returned non-JSON response");
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("LLM returned empty content");
  }
  return content;
}

export async function chatJson(opts) {
  const raw = await chat({ ...opts, json: true });
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM JSON parse failed: ${cleaned.slice(0, 200)}`);
  }
}
