/**
 * Waveform peaks for drawing a Call's shape.
 *
 * Decoded in the browser from the same audio the player streams, so the
 * server needs no waveform endpoint or stored data. Decoding runs on an
 * OfflineAudioContext: it needs no user gesture and never touches the
 * player's context, which iOS is particular about (see player.ts).
 */

export interface CallPeaks {
  /** Loudness per slice of the Call, 0–1 (see computePeaks). */
  peaks: number[];
  /** Length of the decoded audio in seconds. */
  duration: number;
}

/**
 * Slices decoded per Call. More than any row draws: the waveform picks its
 * bar count from its width and merges slices down to fit (resamplePeaks).
 */
export const PEAK_BUCKETS = 400;

/**
 * The loudness that reads as full height, as a percentile of the slices.
 * Not the maximum: one click or squelch-tail pop would flatten the rest.
 */
const REFERENCE_PERCENTILE = 0.95;

/**
 * Low decode rate: the shape is all that is needed, and decoding resamples
 * to the context's rate. Some older WebKit builds reject rates this low,
 * so a standard rate is the fallback.
 */
const DECODE_RATES = [8000, 44100];

declare global {
  interface Window {
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  }
}

/**
 * The loudness (RMS) of each of `buckets` equal slices of `samples`,
 * scaled so the REFERENCE_PERCENTILE slice reads 1, capped at 1, and
 * rounded to two places. RMS follows speech energy where the peak sample
 * follows clicks. Silence comes back as all zeros.
 */
export function computePeaks(samples: Float32Array, buckets: number): number[] {
  const out = new Array<number>(Math.max(0, buckets)).fill(0);
  if (samples.length === 0 || buckets <= 0) return out;

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * samples.length) / buckets);
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.floor(((b + 1) * samples.length) / buckets)),
    );
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    out[b] = Math.sqrt(sum / (end - start));
  }

  const sorted = [...out].sort((a, b) => a - b);
  const reference =
    sorted[Math.round(REFERENCE_PERCENTILE * (sorted.length - 1))] ||
    sorted[sorted.length - 1];
  if (!reference) return out;
  return out.map((v) => Math.round(Math.min(1, v / reference) * 100) / 100);
}

/**
 * Merge `peaks` down to `count` bars, each the loudest of the slices it
 * covers, so a short burst survives the narrowing. Returns `peaks` as-is
 * when there are already no more than `count`.
 */
export function resamplePeaks(peaks: number[], count: number): number[] {
  if (count <= 0) return [];
  if (peaks.length <= count) return peaks;
  const out = new Array<number>(count);
  for (let b = 0; b < count; b++) {
    const start = Math.floor((b * peaks.length) / count);
    const end = Math.floor(((b + 1) * peaks.length) / count);
    let max = 0;
    for (let i = start; i < end; i++) if (peaks[i] > max) max = peaks[i];
    out[b] = max;
  }
  return out;
}

function offlineContext(): OfflineAudioContext {
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) throw new Error("OfflineAudioContext is not available");
  let lastErr: unknown = null;
  for (const rate of DECODE_RATES) {
    try {
      return new Ctor(1, 1, rate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("no decode rate");
}

/** Decode a Call's audio file and reduce it to peaks. */
export async function decodePeaks(
  audio: ArrayBuffer,
  buckets: number = PEAK_BUCKETS,
): Promise<CallPeaks> {
  const buffer = await offlineContext().decodeAudioData(audio);
  // Radio audio is mono; the first channel is the whole signal.
  return {
    peaks: computePeaks(buffer.getChannelData(0), buckets),
    duration: buffer.duration,
  };
}
