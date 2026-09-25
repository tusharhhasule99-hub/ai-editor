/** Car-reel styles → safe named FX_PACK entries (no custom filter graphs). */
export const CAR_REEL = {
  punch: { fx: "cut", duration: 0 },
  flash: { fx: "flash_white", duration: 0.14 },
  slam: { fx: "flash_black", duration: 0.16 },
  whipLeft: { fx: "whip_left", duration: 0.2 },
  whipRight: { fx: "whip_right", duration: 0.2 },
  slide: { fx: "smooth_wipe", duration: 0.22 },
  zoom: { fx: "circle_punch", duration: 0.18 },
  radial: { fx: "radial_spin", duration: 0.18 },
};

const STRONG = ["punch", "flash", "whipLeft", "zoom"];
const MEDIUM = ["punch", "whipLeft", "whipRight", "slide"];
const WEAK = ["punch", "whipLeft", "slide"];

/**
 * Build a beat-synced edit plan from clip metas + beat analysis.
 *
 * @param {Array<{ path: string, duration: number, width?: number, height?: number }>} clips
 * @param {{ bpm: number, beats: number[], energies?: number[], musicStart: number, musicDuration: number, dropAt?: number, source?: string }} beatInfo
 * @param {object} [opts]
 * @param {number} [opts.maxSegment=1.2]
 * @param {number} [opts.minSegment=0.25]
 * @returns {{ bpm: number, beats: number[], musicStart: number, musicDuration: number, segments: Array<object>, titles: [] }}
 */
export function planEdit(clips, beatInfo, { maxSegment = 1.2, minSegment = 0.25 } = {}) {
  if (!clips?.length) throw new Error("Need at least one video clip");
  if (!beatInfo?.beats?.length) throw new Error("No beats to plan against");

  const beats = [...beatInfo.beats].sort((a, b) => a - b);
  const energies = beatInfo.energies || beats.map(() => 0.5);
  const musicDuration = beatInfo.musicDuration;

  // Build cut points: use consecutive beats, but skip if gap is tiny; cap long gaps
  const cutTimes = [0];
  for (let i = 1; i < beats.length; i++) {
    const gap = beats[i] - cutTimes[cutTimes.length - 1];
    if (gap < minSegment) continue;
    if (gap > maxSegment) {
      // Insert intermediate cuts so segments stay snappy
      let t = cutTimes[cutTimes.length - 1] + maxSegment;
      while (t < beats[i] - minSegment) {
        cutTimes.push(Number(t.toFixed(4)));
        t += maxSegment;
      }
    }
    cutTimes.push(Number(beats[i].toFixed(4)));
  }
  if (cutTimes[cutTimes.length - 1] < musicDuration - 0.05) {
    cutTimes.push(Number(musicDuration.toFixed(4)));
  }

  const order = shuffleAvoidRepeat(clips.map((_, i) => i), cutTimes.length - 1);
  const segments = [];

  for (let i = 0; i < cutTimes.length - 1; i++) {
    const start = cutTimes[i];
    const end = cutTimes[i + 1];
    let len = end - start;
    if (len < minSegment) continue;
    if (len > maxSegment) len = maxSegment;

    const clip = clips[order[i % order.length]];
    const usable = Math.max(0.1, clip.duration - 0.05);
    const take = Math.min(len, usable);
    const maxIn = Math.max(0, clip.duration - take);
    const inPoint = maxIn > 0 ? Math.random() * maxIn : 0;

    // Transition into this segment (ignored for first)
    const energy = energies[nearestBeatIndex(beats, start)] ?? 0.5;
    const style = pickStyle(energy, i);
    const pack = CAR_REEL[style];

    segments.push({
      clip: clip.path,
      in: Number(inPoint.toFixed(3)),
      out: Number((inPoint + take).toFixed(3)),
      transition: pack.fx === "cut" ? "cut" : "fadewhite",
      transitionDuration: pack.duration,
      fx: pack.fx,
      durationFx: pack.duration,
      filterComplex: null,
      style,
      energy: Number(energy.toFixed(3)),
    });
  }

  if (segments.length < 2) {
    throw new Error("Not enough beat segments — try a longer audio window or more beats");
  }

  // First segment has no inbound transition
  segments[0].transition = "cut";
  segments[0].transitionDuration = 0;
  segments[0].fx = "cut";
  segments[0].durationFx = 0;
  segments[0].style = "punch";

  return {
    bpm: beatInfo.bpm,
    beats,
    energies,
    musicStart: beatInfo.musicStart,
    musicDuration,
    dropAt: beatInfo.dropAt ?? beatInfo.musicStart,
    source: beatInfo.source || "audio",
    segments,
    titles: [],
  };
}

function nearestBeatIndex(beats, t) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const d = Math.abs(beats[i] - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function pickStyle(energy, index) {
  const pool = energy >= 0.75 ? STRONG : energy >= 0.45 ? MEDIUM : WEAK;
  return pool[index % pool.length];
}

function shuffleAvoidRepeat(indices, count) {
  if (!indices.length) return [];
  const out = [];
  let pool = [...indices];
  for (let i = 0; i < count; i++) {
    if (!pool.length) pool = [...indices];
    let pick = Math.floor(Math.random() * pool.length);
    if (out.length && pool.length > 1 && pool[pick] === out[out.length - 1]) {
      pick = (pick + 1) % pool.length;
    }
    out.push(pool[pick]);
    pool.splice(pick, 1);
  }
  return out;
}
