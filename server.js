#!/usr/bin/env node
import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import Busboy from "busboy";
import { stitch, TRANSITIONS, probe, renderEditPlan } from "./stitch.js";
import { detectBeats } from "./lib/beats.js";
import { directEdit } from "./lib/aiDirector.js";
import { llmConfig, llmEnabled, whisperEnabled } from "./lib/config.js";

const PORT = Number(process.env.PORT) || 3847;
const MAX_FILES = 12;
const MAX_FILE_BYTES = 1024 ** 3;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;
const ASSET_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|mp3|wav|m4a|aac|flac|ogg|opus)$/i;

const htmlPath = new URL("./public/index.html", import.meta.url);
const assetsDir = join(fileURLToPath(new URL(".", import.meta.url)), "assets");
const MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
};

async function listDemos() {
  const names = await readdir(assetsDir).catch(() => []);
  const videos = names
    .filter((name) => VIDEO_EXT.test(name) && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const audio = names
    .filter((name) => AUDIO_EXT.test(name) && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { videos, audio };
}

async function sendFile(req, res, filePath) {
  const info = await stat(filePath);
  const mime = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": mime,
      "Content-Range": `bytes ${start}-${end}/${info.size}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    await pipeline(createReadStream(filePath, { start, end }), res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": info.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  await pipeline(createReadStream(filePath), res);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function friendly(err) {
  const msg = err?.message || "Stitch failed";
  const line =
    msg.split("\n").find((l) => /error|invalid|failed|too short|unknown/i.test(l)) ||
    msg.split("\n")[0];
  return line.replace(/^ffmpeg exited \d+\s*/, "").trim().slice(0, 400);
}

function safeName(name, index) {
  const base = basename(name || "clip.mp4")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
  return `${String(index).padStart(2, "0")}-${base || "clip.mp4"}`;
}

function readForm(req, jobDir) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { files: MAX_FILES + 2, fileSize: MAX_FILE_BYTES, fields: 12, fieldSize: 2048 },
      });
    } catch (err) {
      fail(err);
      return;
    }

    const fields = {};
    const files = [];
    let audio = null;
    const writes = [];

    bb.on("field", (name, val) => {
      fields[name] = val;
    });

    bb.on("file", (name, stream, info) => {
      if (name === "audio") {
        const dest = join(jobDir, `audio-${safeName(info.filename, 0)}`);
        audio = { dest, filename: info.filename || "track", mime: info.mimeType || "" };
        writes.push(pipeline(stream, createWriteStream(dest)));
        stream.on("limit", () => fail(new Error("Audio must be under 1 GB")));
        return;
      }
      if (name !== "files") {
        stream.resume();
        return;
      }
      const dest = join(jobDir, safeName(info.filename, files.length));
      files.push({
        dest,
        filename: info.filename || "clip",
        mime: info.mimeType || "",
      });
      writes.push(pipeline(stream, createWriteStream(dest)));
      stream.on("limit", () => fail(new Error("Each clip must be under 1 GB")));
    });

    bb.on("filesLimit", () => fail(new Error(`Upload ${MAX_FILES} clips or fewer`)));
    bb.on("error", fail);
    bb.on("finish", () => {
      Promise.all(writes).then(() => {
        if (settled) return;
        settled = true;
        resolve({ fields, files, audio });
      }, fail);
    });

    req.on("error", fail);
    req.pipe(bb);
  });
}

async function handleStitch(req, res) {
  const jobDir = join(tmpdir(), "stitch-ui", randomBytes(8).toString("hex"));
  await mkdir(jobDir, { recursive: true });

  try {
    const { fields, files } = await readForm(req, jobDir);
    if (files.length < 2) {
      sendJson(res, 400, { error: "Add at least two videos" });
      return;
    }

    for (const file of files) {
      const info = await stat(file.dest);
      const looksLikeVideo = file.mime.startsWith("video/") || VIDEO_EXT.test(file.filename);
      if (!looksLikeVideo) {
        sendJson(res, 400, { error: `${file.filename} is not a video` });
        return;
      }
      if (info.size === 0) {
        sendJson(res, 400, { error: `${file.filename} is empty` });
        return;
      }
    }

    const type = fields.transitionType || "cut";
    const duration = Number(fields.duration ?? 0.8);
    const outPath = join(jobDir, "stitch.mp4");

    if (type === "cut") {
      await stitch(files.map((f) => f.dest), outPath, { normalize: true });
    } else {
      if (!TRANSITIONS.includes(type)) {
        sendJson(res, 400, { error: `Unknown transition: ${type}` });
        return;
      }
      if (!Number.isFinite(duration) || duration < 0.2 || duration > 3) {
        sendJson(res, 400, { error: "Transition length must be between 0.2 and 3 seconds" });
        return;
      }
      await stitch(files.map((f) => f.dest), outPath, {
        transition: duration,
        transitionType: type,
      });
    }

    const size = (await stat(outPath)).size;
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": size,
      "Content-Disposition": 'inline; filename="stitch.mp4"',
    });
    await pipeline(createReadStream(outPath), res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: friendly(err) });
    else res.destroy();
    console.error(err);
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleAutoEdit(req, res) {
  const jobDir = join(tmpdir(), "auto-edit", randomBytes(8).toString("hex"));
  await mkdir(jobDir, { recursive: true });

  try {
    const { fields, files, audio } = await readForm(req, jobDir);
    if (files.length < 1) {
      sendJson(res, 400, { error: "Add at least one video clip" });
      return;
    }

    for (const file of files) {
      const info = await stat(file.dest);
      const looksLikeVideo = file.mime.startsWith("video/") || VIDEO_EXT.test(file.filename);
      if (!looksLikeVideo) {
        sendJson(res, 400, { error: `${file.filename} is not a video` });
        return;
      }
      if (info.size === 0) {
        sendJson(res, 400, { error: `${file.filename} is empty` });
        return;
      }
    }

    if (audio) {
      const info = await stat(audio.dest);
      const looksLikeAudio =
        audio.mime.startsWith("audio/") || AUDIO_EXT.test(audio.filename);
      if (!looksLikeAudio) {
        sendJson(res, 400, { error: `${audio.filename} is not audio` });
        return;
      }
      if (info.size === 0) {
        sendJson(res, 400, { error: "Audio file is empty" });
        return;
      }
    }

    const targetDuration = Number(fields.targetDuration ?? 15);
    const musicPath = audio?.dest || null;

    const clips = [];
    for (const file of files) {
      const meta = await probe(file.dest);
      clips.push({
        path: file.dest,
        name: file.filename,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
      });
    }

    let plan;
    if (llmEnabled()) {
      plan = await directEdit({
        clips,
        musicPath,
        targetDuration: Number.isFinite(targetDuration) ? targetDuration : 15,
      });
    } else {
      const beatInfo = await detectBeats(musicPath, {
        targetDuration: Number.isFinite(targetDuration) ? targetDuration : 15,
        minDuration: 10,
        maxDuration: 20,
        fallbackBpm: 120,
      });
      const { planEdit } = await import("./lib/planEdit.js");
      plan = { ...planEdit(clips, beatInfo), planner: "heuristic", fxSource: "rules" };
    }

    const outPath = join(jobDir, "auto.mp4");
    await renderEditPlan(plan, { output: outPath, musicPath });

    const size = (await stat(outPath)).size;
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": size,
      "Content-Disposition": 'inline; filename="auto-edit.mp4"',
      "X-Edit-Bpm": String(plan.bpm),
      "X-Edit-Beats": String(plan.beats.length),
      "X-Edit-Segments": String(plan.segments.length),
      "X-Edit-Music-Start": String(plan.musicStart),
      "X-Edit-Duration": String(plan.musicDuration),
      "X-Edit-Source": plan.source || "audio",
      "X-Edit-Planner": plan.planner || "heuristic",
      "X-Edit-Model": plan.planner === "ai" ? llmConfig.model : "rules",
      "X-Edit-Whisper": plan.whisper ? "1" : "0",
      "X-Edit-Fx": plan.fxSource || "rules",
    });
    await pipeline(createReadStream(outPath), res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: friendly(err) });
    else res.destroy();
    console.error(err);
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(htmlPath);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, {
        llm: llmEnabled(),
        whisper: whisperEnabled(),
        model: llmEnabled() ? llmConfig.model : null,
        baseUrl: llmEnabled() ? llmConfig.baseUrl : null,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/demos") {
      const { videos, audio } = await listDemos();
      sendJson(res, 200, {
        files: videos.map((name) => ({ name, url: `/assets/${encodeURIComponent(name)}`, kind: "video" })),
        audio: audio.map((name) => ({ name, url: `/assets/${encodeURIComponent(name)}`, kind: "audio" })),
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const name = decodeURIComponent(url.pathname.slice("/assets/".length));
      if (!ASSET_EXT.test(name) || name.includes("/") || name.includes("..")) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      try {
        await sendFile(req, res, join(assetsDir, name));
      } catch {
        if (!res.headersSent) sendJson(res, 404, { error: "Not found" });
        else res.destroy();
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stitch") {
      await handleStitch(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auto-edit") {
      await handleAutoEdit(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: friendly(err) });
    console.error(err);
  }
});

server.listen(PORT, () => {
  console.log(`Stitch UI  http://localhost:${PORT}`);
  console.log(
    llmEnabled()
      ? `AI director  on  (${llmConfig.model})${whisperEnabled() ? " + Whisper" : " (no Whisper)"}`
      : "AI director  off — set LLM_API_KEY in edit/.env"
  );
});
