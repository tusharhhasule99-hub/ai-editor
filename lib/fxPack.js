/**
 * Named FFmpeg transition packs — plain xfade only.
 * Never grade inputs with eq/gblur: each join re-encodes the whole timeline,
 * so brightness/contrast filters compound into a dark, crushed look.
 *
 * Placeholders: {offset} = xfade offset (seconds), {duration} = transition seconds.
 */

function xfade(transition) {
  return (
    "[0:v]format=yuv420p,settb=AVTB[va];[1:v]format=yuv420p,settb=AVTB[vb];" +
    `[va][vb]xfade=transition=${transition}:duration={duration}:offset={offset}[v]`
  );
}

export const FX_PACK = {
  cut: {
    label: "Hard cut",
    duration: 0,
    mode: "concat",
  },
  flash_white: {
    label: "White flash",
    duration: 0.12,
    mode: "xfade",
    filter: xfade("fadewhite"),
  },
  flash_black: {
    label: "Black flash",
    duration: 0.12,
    mode: "xfade",
    filter: xfade("fadeblack"),
  },
  whip_left: {
    label: "Whip left",
    duration: 0.16,
    mode: "xfade",
    filter: xfade("slideleft"),
  },
  whip_right: {
    label: "Whip right",
    duration: 0.16,
    mode: "xfade",
    filter: xfade("slideright"),
  },
  circle_punch: {
    label: "Circle open",
    duration: 0.16,
    mode: "xfade",
    filter: xfade("circleopen"),
  },
  radial_spin: {
    label: "Radial",
    duration: 0.18,
    mode: "xfade",
    filter: xfade("radial"),
  },
  dissolve_soft: {
    label: "Dissolve",
    duration: 0.2,
    mode: "xfade",
    filter: xfade("dissolve"),
  },
  smooth_wipe: {
    label: "Smooth wipe",
    duration: 0.2,
    mode: "xfade",
    filter: xfade("smoothleft"),
  },
};

export const FX_NAMES = Object.keys(FX_PACK);

const FILTER_NAME =
  /^(xfade|fade|format|settb|setsar|scale|pad|fps)$/;

/**
 * Validate a filter_complex string before running ffmpeg.
 * @param {string} filter
 */
export function validateFilterComplex(filter) {
  if (!filter || typeof filter !== "string") throw new Error("Empty filter_complex");
  if (filter.length > 2000) throw new Error("filter_complex too long");
  if (/[`$]|\$\(|;\s*rm|\|\||&&|\n|\/etc\/|https?:|movie=|concat:|lavfi|eq=|gblur|zoompan|brightness|contrast/i.test(filter)) {
    throw new Error("filter_complex contains forbidden tokens");
  }
  const names = [...filter.matchAll(/(?:^|[;,\[\]])([a-zA-Z][a-zA-Z0-9_]*)=/g)].map((m) => m[1]);
  for (const name of names) {
    if (!FILTER_NAME.test(name)) {
      throw new Error(`Filter not allowed: ${name}`);
    }
  }
  if (!filter.includes("[v]")) {
    throw new Error("filter_complex must end with output label [v]");
  }
  return filter;
}

/**
 * Resolve a transition into runnable ffmpeg join instructions.
 * @param {{ fx?: string, duration?: number }} transition
 * @param {{ offset: number }} ctx
 */
export function resolveJoin(transition, ctx) {
  const offset = Math.max(0.05, Number(ctx.offset) || 0.05);
  const name = String(transition?.fx || "cut");
  const pack = FX_PACK[name] || FX_PACK.cut;
  if (pack.mode === "concat" || name === "cut") {
    return { mode: "concat", duration: 0 };
  }

  const duration = clamp(Number(transition?.duration) || pack.duration || 0.16, 0.08, 0.35);
  const fc = pack.filter
    .replaceAll("{offset}", offset.toFixed(3))
    .replaceAll("{duration}", duration.toFixed(3));
  validateFilterComplex(fc);
  return {
    mode: "filter",
    filterComplex: fc,
    duration,
    fx: name,
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
