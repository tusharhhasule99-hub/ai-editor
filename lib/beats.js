import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import ffmpegPath from "ffmpeg-static";

const SAMPLE_RATE = 22050;

/**
 * Detect beats and pick a punchy 10–20s window (drop / high-energy section).
 *
 * @param {string|null} audioPath
 * @param {object} [opts]
 * @param {number} [opts.targetDuration=15]
 * @param {number} [opts.minDuration=10]
 * @param {number} [opts.maxDuration=20]
 * @param {number} [opts.fallbackBpm=120]
 * @returns {Promise<{
 *   bpm: number,
 *   beats: number[],
 *   energies: number[],
 *   musicStart: number,
 *   musicDuration: number,
 *   dropAt: number,
 *   source: "audio"|"fallback"
 * }>}
 */
export async function detectBeats(
  audioPath,
  {
    targetDuration = 15,
    minDuration = 10,
    maxDuration = 20,
    fallbackBpm = 120,
  } = {}
) {
  const duration = clamp(targetDuration, minDuration, maxDuration);

  if (!audioPath) {
    return synthesizeBeats(fallbackBpm, duration);
  }

  const wavPath = join(tmpdir(), `beats-${randomBytes(8).toString("hex")}.raw`);
  try {
    await decodeMonoF32(audioPath, wavPath);
    const samples = await readF32(wavPath);
    if (samples.length < SAMPLE_RATE) {
      return synthesizeBeats(fallbackBpm, duration);
    }

    const { onsets, envelope, hop } = findOnsets(samples);
    const bpm = estimateBpm(onsets) || fallbackBpm;
    const trackDur = samples.length / SAMPLE_RATE;
    const window = pickDropWindow({
      envelope,
      hop,
      sampleRate: SAMPLE_RATE,
      trackDur,
      targetDuration: duration,
      minDuration,
      maxDuration,
      onsets,
    });

    const localOnsets = onsets
      .filter((t) => t >= window.start && t < window.start + window.duration)
      .map((t) => t - window.start);

    // Ensure a beat grid covers the window even if onset density is low
    const beats = densifyBeats(localOnsets, bpm, window.duration);
    const energies = beats.map((t) => {
      const abs = t + window.start;
      const idx = Math.min(
        envelope.length - 1,
        Math.max(0, Math.floor((abs * SAMPLE_RATE) / hop))
      );
      return envelope[idx] ?? 0;
    });
    const maxE = Math.max(...energies, 1e-9);
    const normE = energies.map((e) => e / maxE);

    return {
      bpm,
      beats,
      energies: normE,
      musicStart: window.start,
      musicDuration: window.duration,
      dropAt: window.dropAt,
      source: "audio",
    };
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}

export function synthesizeBeats(bpm = 120, duration = 15) {
  const step = 60 / bpm;
  const beats = [];
  for (let t = 0; t < duration - 0.05; t += step) beats.push(Number(t.toFixed(4)));
  if (beats.length < 2) beats.push(0, Math.min(duration, step));
  const energies = beats.map((_, i) => (i % 4 === 0 ? 1 : i % 2 === 0 ? 0.7 : 0.45));
  return {
    bpm,
    beats,
    energies,
    musicStart: 0,
    musicDuration: duration,
    dropAt: 0,
    source: "fallback",
  };
}

function densifyBeats(onsets, bpm, duration) {
  if (onsets.length >= 4) {
    // Prefer real onsets; fill gaps larger than 1.6 beat intervals
    const step = 60 / bpm;
    const out = [...onsets];
    out.sort((a, b) => a - b);
    const filled = [out[0] ?? 0];
    for (let i = 1; i < out.length; i++) {
      let prev = filled[filled.length - 1];
      while (out[i] - prev > step * 1.6) {
        prev += step;
        if (prev >= out[i] - 0.05) break;
        filled.push(Number(prev.toFixed(4)));
      }
      filled.push(out[i]);
    }
    let last = filled[filled.length - 1];
    while (last + step < duration - 0.05) {
      last += step;
      filled.push(Number(last.toFixed(4)));
    }
    return filled;
  }
  return synthesizeBeats(bpm, duration).beats;
}

function pickDropWindow({
  envelope,
  hop,
  sampleRate,
  trackDur,
  targetDuration,
  minDuration,
  maxDuration,
  onsets,
}) {
  const duration = clamp(
    Math.min(targetDuration, trackDur),
    Math.min(minDuration, trackDur),
    Math.min(maxDuration, trackDur)
  );

  if (trackDur <= duration + 0.05) {
    return { start: 0, duration: trackDur, dropAt: onsets[0] || 0 };
  }

  const winSamples = Math.max(1, Math.floor((duration * sampleRate) / hop));
  let bestScore = -Infinity;
  let bestStartIdx = 0;

  // Prefix sums for fast window energy
  const prefix = new Float64Array(envelope.length + 1);
  for (let i = 0; i < envelope.length; i++) prefix[i + 1] = prefix[i] + envelope[i];

  const step = Math.max(1, Math.floor(winSamples / 8));
  for (let i = 0; i + winSamples <= envelope.length; i += step) {
    const energy = prefix[i + winSamples] - prefix[i];
    const startSec = (i * hop) / sampleRate;
    const endSec = startSec + duration;
    const onsetCount = onsets.filter((t) => t >= startSec && t < endSec).length;
    // Prefer high energy; slight preference for the first strong peak (typical drop)
    const lateBias = Math.min(1, startSec / Math.max(trackDur, 1));
    const score = energy * (1 + 0.08 * lateBias) + onsetCount * 0.2;
    if (score > bestScore) {
      bestScore = score;
      bestStartIdx = i;
    }
  }

  let start = (bestStartIdx * hop) / sampleRate;
  if (start + duration > trackDur) start = Math.max(0, trackDur - duration);
  const dropAt =
    onsets.find((t) => t >= start && t < start + duration) ?? start;
  return {
    start: Number(start.toFixed(3)),
    duration: Number(duration.toFixed(3)),
    dropAt: Number(dropAt.toFixed(3)),
  };
}

function findOnsets(samples) {
  const hop = 512;
  const frame = 1024;
  const envelope = [];
  for (let i = 0; i + frame < samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < frame; j++) {
      const v = samples[i + j];
      sum += v * v;
    }
    envelope.push(Math.sqrt(sum / frame));
  }

  // Spectral flux proxy: positive energy difference
  const flux = new Float64Array(envelope.length);
  for (let i = 1; i < envelope.length; i++) {
    flux[i] = Math.max(0, envelope[i] - envelope[i - 1]);
  }

  // Smooth
  const smooth = new Float64Array(flux.length);
  for (let i = 0; i < flux.length; i++) {
    const a = flux[i - 1] || 0;
    const b = flux[i];
    const c = flux[i + 1] || 0;
    smooth[i] = (a + b + c) / 3;
  }

  const mean = smooth.reduce((s, v) => s + v, 0) / (smooth.length || 1);
  const threshold = mean * 1.6;
  const minGap = Math.floor(0.18 * SAMPLE_RATE / hop); // ~180ms
  const onsets = [];
  let last = -minGap;
  for (let i = 1; i < smooth.length - 1; i++) {
    if (
      smooth[i] > threshold &&
      smooth[i] >= smooth[i - 1] &&
      smooth[i] >= smooth[i + 1] &&
      i - last >= minGap
    ) {
      onsets.push((i * hop) / SAMPLE_RATE);
      last = i;
    }
  }

  return { onsets, envelope, hop };
}

function estimateBpm(onsets) {
  if (onsets.length < 4) return null;
  const intervals = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d >= 0.25 && d <= 1.2) intervals.push(d);
  }
  if (!intervals.length) return null;
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  let bpm = 60 / median;
  // Fold into 70–160 range
  while (bpm < 70) bpm *= 2;
  while (bpm > 160) bpm /= 2;
  return Math.round(bpm);
}

function decodeMonoF32(input, rawPath) {
  return run(ffmpegPath, [
    "-y",
    "-i", input,
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "f32le",
    rawPath,
  ]);
}

async function readF32(path) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(path);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function run(bin, args) {
  if (!bin) return Promise.reject(new Error("Bundled ffmpeg missing — run npm install"));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-800)}`));
    });
  });
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
