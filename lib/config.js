import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(root, "..", ".env") });

function trim(value, fallback = "") {
  const v = (value ?? "").trim();
  return v || fallback;
}

const openRouter = "https://openrouter.ai/api/v1";

export const llmConfig = {
  apiKey: trim(process.env.LLM_API_KEY),
  baseUrl: trim(process.env.LLM_BASE_URL, openRouter).replace(/\/$/, ""),
  model: trim(process.env.LLM_MODEL, "anthropic/claude-sonnet-4"),
  httpReferer: trim(process.env.LLM_HTTP_REFERER, "http://localhost:3847"),
  appName: trim(process.env.LLM_APP_NAME, "Stitch"),
};

// Whisper defaults to the same OpenRouter account as chat unless overridden
export const whisperConfig = {
  apiKey: trim(process.env.WHISPER_API_KEY) || llmConfig.apiKey,
  baseUrl: trim(process.env.WHISPER_BASE_URL, llmConfig.baseUrl || openRouter).replace(
    /\/$/,
    ""
  ),
  model: trim(process.env.WHISPER_MODEL, "openai/whisper-large-v3"),
  httpReferer: llmConfig.httpReferer,
  appName: llmConfig.appName,
};

export function llmEnabled() {
  return Boolean(llmConfig.apiKey);
}

export function whisperEnabled() {
  return Boolean(whisperConfig.apiKey);
}

export function isOpenRouter(url = whisperConfig.baseUrl) {
  return /openrouter\.ai/i.test(url);
}
