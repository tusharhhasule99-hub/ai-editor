import { basename } from "node:path";
import { chatJson } from "./llm.js";
import { llmEnabled, llmConfig, whisperEnabled } from "./config.js";
import { detectBeats } from "./beats.js";
import { transcribeAudio } from "./whisper.js";
import { FX_NAMES, FX_PACK } from "./fxPack.js";
import { planEdit as planEditHeuristic } from "./planEdit.js";

/**
 * AI director: beat recognition + Whisper window + safe named FFmpeg transitions.
 * No custom filter_complex / zoompan — those were producing black/corrupt frames.
 *
 * @param {object} args
 * @param {Array<{ path: string, duration: number, name?: string, width?: number, height?: number }>} args.clips
 * @param {string|null} args.musicPath
 * @param {number} [args.targetDuration=15]
 */
export async function directEdit({ clips, musicPath, targetDuration = 15 }) {
  if (!clips?.length) throw new Error("Need at least one clip");

  const energy = await detectBeats(musicPath, {
    targetDuration,
    minDuration: 10,
    maxDuration: 20,
    fallbackBpm: 120,
  });

  let whisper = null;
  if (musicPath && whisperEnabled()) {
    try {
      whisper = await transcribeAudio(musicPath);
    } catch (err) {
      console.warn("[director] Whisper failed:", err.message);
    }
  }

  if (!llmEnabled()) {
    const plan = planEditHeuristic(clips, energy);
    return {
      ...plan,
      planner: "heuristic",
      whisper: Boolean(whisper),
      fxSource: "rules",
    };
  }

  try {
    const ai = await askDirector({ clips, energy, whisper, targetDuration });
    const plan = materializePlan(clips, energy, ai, whisper);
    return {
      ...plan,
      planner: "ai",
      model: llmConfig.model,
      whisper: Boolean(whisper),
      fxSource: "fx-pack",
      modelNotes: ai.notes || "",
    };
  } catch (err) {
    console.warn("[director] AI failed, heuristic fallback:", err.message);
    const plan = planEditHeuristic(clips, energy);
    return {
      ...plan,
      planner: "heuristic",
      plannerError: err.message,
      whisper: Boolean(whisper),
      fxSource: "rules",
    };
  }
}

async function askDirector({ clips, energy, whisper, targetDuration }) {
  const clipCards = clips.map((c, i) => ({
    index: i,
    name: c.name || basename(c.path),
    durationSec: Number(c.duration.toFixed(2)),
  }));

  const onsetHints = (energy.beats || []).slice(0, 40).map((t, i) => ({
    t: Number(t.toFixed(3)),
    energy: Number((energy.energies?.[i] ?? 0.5).toFixed(2)),
  }));

  const packHelp = FX_NAMES.map((name) => ({
    fx: name,
    label: FX_PACK[name].label,
    defaultDuration: FX_PACK[name].duration,
  }));

  const system = `You are a music-video / car-reel editor.
Return JSON only.

You decide:
1) musicStart + musicDuration (10–20s) — pick the drop / best section
2) beat-synced cut list (clipIndex, inPoint, duration)
3) inbound transition fx for each segment AFTER the first — MUST be one of the fxPack names listed

Rules:
- First segment fx must be "cut"
- Prefer "cut" on most beats (keeps footage looking natural)
- On big hits only: flash_white, whip_left, whip_right, circle_punch
- Use ONLY fx names from fxPack. Never invent filters, grades, or dark looks
- Do NOT darken, crush contrast, or blur the footage
- Alternate clipIndex when possible
- Segment duration 0.28–1.15s; 8–28 segments for ~15s
- inPoint must fit inside the chosen clip`;

  const user = JSON.stringify(
    {
      goal: "beat-synced car reel with punchy named transitions",
      targetDurationSec: targetDuration,
      energyHint: {
        bpm: energy.bpm,
        suggestedStart: energy.musicStart,
        suggestedDuration: energy.musicDuration,
        dropAt: energy.dropAt,
        onsetsRelativeToSuggestedWindow: onsetHints,
        source: energy.source,
      },
      whisper: whisper
        ? {
            language: whisper.language,
            transcriptPreview: whisper.text.slice(0, 800),
            segments: whisper.segments.slice(0, 40).map((s) => ({
              start: s.start,
              end: s.end,
              text: s.text.slice(0, 80),
            })),
          }
        : null,
      clips: clipCards,
      fxPack: packHelp,
      respondWith: {
        notes: "editorial direction",
        musicStart: 18.5,
        musicDuration: 15,
        bpm: 128,
        segments: [
          { clipIndex: 0, inPoint: 1.2, duration: 0.55, fx: "cut", durationFx: 0 },
          {
            clipIndex: 2,
            inPoint: 0.4,
            duration: 0.48,
            fx: "flash_white",
            durationFx: 0.12,
          },
          {
            clipIndex: 1,
            inPoint: 2.0,
            duration: 0.5,
            fx: "whip_left",
            durationFx: 0.16,
          },
        ],
      },
    },
    null,
    2
  );

  return chatJson({ system, user, temperature: 0.75 });
}

function materializePlan(clips, energy, ai, whisper) {
  const musicStart = clamp(
    Number(ai.musicStart ?? energy.musicStart) || 0,
    0,
    3600
  );
  const musicDuration = clamp(
    Number(ai.musicDuration ?? energy.musicDuration) || 15,
    8,
    22
  );
  const rows = Array.isArray(ai.segments) ? ai.segments : [];
  if (rows.length < 2) throw new Error("AI returned fewer than 2 segments");

  const segments = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let clipIndex = Number(row.clipIndex);
    if (!Number.isInteger(clipIndex) || clipIndex < 0 || clipIndex >= clips.length) {
      clipIndex = i % clips.length;
    }
    const clip = clips[clipIndex];

    let duration = clamp(Number(row.duration) || 0.5, 0.28, 1.15);
    duration = Math.min(duration, Math.max(0.28, clip.duration - 0.05));
    let inPoint = Number(row.inPoint);
    if (!Number.isFinite(inPoint) || inPoint < 0) {
      inPoint = Math.random() * Math.max(0, clip.duration - duration);
    }
    inPoint = clamp(inPoint, 0, Math.max(0, clip.duration - duration));

    let fx = String(row.fx || "cut").toLowerCase();
    if (i === 0) fx = "cut";
    else if (!FX_PACK[fx]) fx = "cut";

    const pack = FX_PACK[fx];
    const durationFx =
      fx === "cut"
        ? 0
        : clamp(Number(row.durationFx) || pack.duration || 0.16, 0.08, 0.35);

    segments.push({
      clip: clip.path,
      in: Number(inPoint.toFixed(3)),
      out: Number((inPoint + duration).toFixed(3)),
      transition: fx === "cut" ? "cut" : "fadewhite",
      transitionDuration: durationFx,
      fx,
      durationFx,
      // Never pass AI-authored filter graphs — safe named packs only
      filterComplex: null,
      style: fx,
      energy: 0.7,
      ai: true,
    });
  }

  const beats = [0];
  let t = 0;
  for (const seg of segments) {
    t += seg.out - seg.in;
    beats.push(Number(t.toFixed(3)));
  }

  return {
    bpm: Number(ai.bpm) || energy.bpm,
    beats,
    energies: beats.map(() => 0.7),
    musicStart: Number(musicStart.toFixed(3)),
    musicDuration: Number(musicDuration.toFixed(3)),
    dropAt: musicStart,
    source: whisper ? "whisper+ai" : "ai",
    segments,
    titles: [],
    notes: typeof ai.notes === "string" ? ai.notes : "",
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** @deprecated use directEdit */
export async function planEditSmart(clips, beatInfo, opts = {}) {
  return directEdit({
    clips,
    musicPath: opts.musicPath || null,
    targetDuration: beatInfo?.musicDuration || opts.targetDuration || 15,
  });
}
