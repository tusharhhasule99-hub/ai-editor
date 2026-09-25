#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile, unlink, access } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";

/** xfade names the UI and CLI are allowed to pass into the filter graph. */
export const TRANSITIONS = [
  "fade",
  "dissolve",
  "fadeblack",
  "fadewhite",
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "slideleft",
  "slideright",
  "slideup",
  "slidedown",
  "circleopen",
  "circleclose",
  "pixelize",
  "radial",
  "smoothleft",
  "smoothright",
];

/**
 * Stitch N videos into one file.
 *
 * @param {string[]} inputs
 * @param {string}   output
 * @param {object}   [opts]
 * @param {boolean}  [opts.reencode=false]
 * @param {boolean}  [opts.normalize=false] - Scale mixed clips onto one canvas, then hard-cut
 * @param {number}   [opts.transition=0]  - Crossfade seconds (0 = hard cut)
 * @param {string}   [opts.transitionType="fade"] - xfade name: fade, dissolve, wipeleft, ...
 * @returns {Promise<string>}
 */
export async function stitch(
  inputs,
  output,
  { reencode = false, normalize = false, transition = 0, transitionType = "fade" } = {}
) {
  if (!inputs?.length) throw new Error("Provide at least one video path");

  const absInputs = inputs.map((p) => resolve(p));
  const absOutput = resolve(output);

  await Promise.all(
    absInputs.map((p) =>
      access(p).catch(() => {
        throw new Error(`File not found: ${p}`);
      })
    )
  );

  if (transition > 0) {
    await stitchWithTransitions(absInputs, absOutput, transition, transitionType);
  } else if (normalize) {
    await stitchNormalized(absInputs, absOutput);
  } else {
    await stitchConcat(absInputs, absOutput, reencode);
  }

  return absOutput;
}

async function stitchConcat(absInputs, absOutput, reencode) {
  const listPath = resolve(tmpdir(), `concat-${randomBytes(8).toString("hex")}.txt`);
  const listBody = absInputs
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");

  await writeFile(listPath, listBody);

  const args = reencode
    ? [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", absOutput,
      ]
    : [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy", "-movflags", "+faststart", absOutput,
      ];

  try {
    await run(ffmpegPath, args);
  } finally {
    await unlink(listPath).catch(() => {});
  }
}

function even(n) {
  return n % 2 === 0 ? n : n + 1;
}

function canvasOf(metas) {
  return {
    W: even(Math.max(...metas.map((m) => m.width))),
    H: even(Math.max(...metas.map((m) => m.height))),
    fps: 30,
  };
}

function videoNorm(i, W, H, fps) {
  return (
    `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},format=yuv420p,settb=AVTB[v${i}]`
  );
}

/** Fit each clip's audio to its video length. Silent bed if the file has no audio. */
function audioNorm(i, meta) {
  const d = meta.duration.toFixed(3);
  if (meta.hasAudio) {
    return (
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
      `atrim=0:${d},apad=whole_dur=${d},asetpts=PTS-STARTPTS[ap${i}]`
    );
  }
  return (
    `aevalsrc=0:d=${d}:s=44100:c=stereo,` +
    `aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[ap${i}]`
  );
}

function encodeArgs(absOutput) {
  return [
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    absOutput,
  ];
}

async function stitchNormalized(absInputs, absOutput) {
  const metas = await Promise.all(absInputs.map(probe));
  const n = absInputs.length;
  const { W, H, fps } = canvasOf(metas);
  const filters = [];

  for (let i = 0; i < n; i++) {
    filters.push(videoNorm(i, W, H, fps));
    filters.push(audioNorm(i, metas[i]));
  }

  const pairs = Array.from({ length: n }, (_, i) => `[v${i}][ap${i}]`).join("");
  filters.push(`${pairs}concat=n=${n}:v=1:a=1[vout][aout]`);

  const args = ["-y"];
  for (const p of absInputs) args.push("-i", p);
  args.push("-filter_complex", filters.join(";"), ...encodeArgs(absOutput));
  await run(ffmpegPath, args);
}

async function stitchWithTransitions(absInputs, absOutput, duration, type) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0 || d > 10) {
    throw new Error("Transition length must be between 0 and 10 seconds");
  }
  if (!TRANSITIONS.includes(type)) {
    throw new Error(`Unknown transition: ${type}`);
  }

  const metas = await Promise.all(absInputs.map(probe));
  const n = absInputs.length;
  if (n < 2) throw new Error("A transition needs at least two clips");

  for (let i = 0; i < n; i++) {
    if (metas[i].duration <= d * 2) {
      throw new Error(
        `Clip too short for ${d}s transition: ${basename(absInputs[i])} (${metas[i].duration.toFixed(2)}s)`
      );
    }
  }

  const { W, H, fps } = canvasOf(metas);
  const filters = [];
  for (let i = 0; i < n; i++) {
    filters.push(videoNorm(i, W, H, fps));
    filters.push(audioNorm(i, metas[i]));
  }

  const dur = d.toFixed(3);
  let offset = metas[0].duration - d;
  let last = "v0";
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? "vout" : `vx${i}`;
    filters.push(
      `[${last}][v${i}]xfade=transition=${type}:duration=${dur}:offset=${offset.toFixed(3)}[${out}]`
    );
    last = out;
    if (i < n - 1) offset += metas[i].duration - d;
  }

  let lastA = "ap0";
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? "aout" : `ax${i}`;
    filters.push(`[${lastA}][ap${i}]acrossfade=d=${dur}:c1=tri:c2=tri[${out}]`);
    lastA = out;
  }

  const args = ["-y"];
  for (const p of absInputs) args.push("-i", p);
  args.push("-filter_complex", filters.join(";"), ...encodeArgs(absOutput));
  await run(ffmpegPath, args);
}

function probe(file) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height:format=duration",
      "-of", "json",
      file,
    ];
    const p = spawn(ffprobe.path, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err || code}`));
      try {
        const j = JSON.parse(out);
        const streams = j.streams || [];
        const stream = streams.find((s) => s.codec_type === "video" && s.width);
        const duration = Number(j.format?.duration);
        if (!stream?.width || !duration) throw new Error("incomplete probe");
        resolvePromise({
          width: stream.width,
          height: stream.height,
          duration,
          hasAudio: streams.some((s) => s.codec_type === "audio"),
        });
      } catch (e) {
        reject(new Error(`ffprobe parse error for ${file}: ${e.message}`));
      }
    });
  });
}

function run(bin, args) {
  if (!bin) return Promise.reject(new Error("Bundled binary missing — run npm install"));

  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-1200)}`));
    });
  });
}

// ── CLI ────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const reencode = argv.includes("--reencode");
  let transition = 0;
  let transitionType = "fade";

  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reencode") continue;
    if (a === "--transition" || a === "-t") {
      transition = Number(argv[++i]);
      if (!Number.isFinite(transition) || transition <= 0) {
        throw new Error("--transition needs a positive number (seconds)");
      }
      continue;
    }
    if (a === "--transition-type") {
      transitionType = argv[++i];
      continue;
    }
    args.push(a);
  }

  if (args.length < 2) {
    console.log(`Usage: node stitch.js <v1> <v2> [...vN] <output.mp4> [options]

Options:
  --reencode              Re-encode hard cuts (mixed formats)
  -t, --transition <sec>  Smooth crossfade between clips (e.g. 0.8)
  --transition-type <name>  fade | dissolve | fadeblack | wipeleft | ...`);
    process.exit(1);
  }

  const output = args.at(-1);
  const inputs = args.slice(0, -1);

  const mode = transition > 0 ? `${transition}s ${transitionType}` : "hard cut";
  console.log(`Stitching ${inputs.length} videos (${mode}) → ${basename(output)}`);
  const out = await stitch(inputs, output, { reencode, transition, transitionType });
  console.log(`Done: ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
