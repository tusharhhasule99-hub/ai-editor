import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { whisperConfig, whisperEnabled, isOpenRouter } from "./config.js";

/**
 * Transcribe audio with Whisper via OpenRouter (or any OpenAI-compatible STT).
 * @param {string} audioPath
 * @returns {Promise<{ text: string, segments: Array<{ start: number, end: number, text: string }>, language?: string }|null>}
 */
export async function transcribeAudio(audioPath) {
  if (!whisperEnabled() || !audioPath) return null;

  const buf = await readFile(audioPath);
  const name = basename(audioPath) || "track.mp3";
  const format = extname(name).replace(".", "").toLowerCase() || "mp3";

  const headers = {
    Authorization: `Bearer ${whisperConfig.apiKey}`,
  };
  if (isOpenRouter()) {
    headers["HTTP-Referer"] = whisperConfig.httpReferer;
    headers["X-Title"] = whisperConfig.appName;
  }

  // OpenRouter prefers JSON + base64; also supports multipart.
  // Use JSON path for OpenRouter; multipart elsewhere.
  let res;
  if (isOpenRouter()) {
    headers["Content-Type"] = "application/json";
    res = await fetch(`${whisperConfig.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: whisperConfig.model,
        input_audio: {
          data: buf.toString("base64"),
          format,
        },
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      }),
    });
  } else {
    const form = new FormData();
    form.append("file", new Blob([buf]), name);
    form.append("model", whisperConfig.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    res = await fetch(`${whisperConfig.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text)?.error?.message || detail;
    } catch {
      /* keep */
    }
    throw new Error(`Whisper ${res.status}: ${detail}`);
  }

  const data = JSON.parse(text);
  const segments = (data.segments || []).map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: String(s.text || "").trim(),
  }));

  return {
    text: String(data.text || "").trim(),
    language: data.language,
    segments,
  };
}
