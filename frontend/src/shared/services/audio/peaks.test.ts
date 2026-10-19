import { describe, it, expect, vi, afterEach } from "vitest";
import { computePeaks, decodePeaks, resamplePeaks } from "./peaks";

describe("computePeaks", () => {
  it("measures the loudness of each bucket, scaled to the loud end", () => {
    // Buckets of steady amplitude 0.5, 0.25 and 0.1: their RMS is the
    // amplitude whatever the sign.
    const samples = new Float32Array([0.5, -0.5, 0.25, -0.25, 0.1, -0.1]);
    expect(computePeaks(samples, 3)).toEqual([1, 0.5, 0.2]);
  });

  it("does not let one pop flatten the rest of the call", () => {
    // A squelch tail or click: one bucket far louder than the speech.
    const samples = new Float32Array(100).fill(0.2);
    samples[99] = 1;
    const peaks = computePeaks(samples, 100);
    expect(peaks[0]).toBe(1);
    expect(peaks[99]).toBe(1);
  });

  it("returns zeros for silence instead of dividing by zero", () => {
    expect(computePeaks(new Float32Array(10), 4)).toEqual([0, 0, 0, 0]);
  });

  it("returns zeros for empty audio", () => {
    expect(computePeaks(new Float32Array(0), 3)).toEqual([0, 0, 0]);
  });

  it("fills every bucket when there are fewer samples than buckets", () => {
    const peaks = computePeaks(new Float32Array([0.5, 1]), 4);
    expect(peaks).toHaveLength(4);
    expect(Math.max(...peaks)).toBe(1);
  });

  it("rounds to two decimal places", () => {
    const peaks = computePeaks(new Float32Array([1, 0.33333]), 2);
    expect(peaks).toEqual([1, 0.33]);
  });
});

describe("resamplePeaks", () => {
  it("keeps the loudest of each group of slices", () => {
    expect(resamplePeaks([0.1, 0.9, 0.2, 0.3, 0.5, 0.4], 3)).toEqual([
      0.9, 0.3, 0.5,
    ]);
  });

  it("returns the peaks unchanged when there are few enough", () => {
    const peaks = [0.1, 0.2];
    expect(resamplePeaks(peaks, 10)).toBe(peaks);
  });

  it("returns nothing for no bars", () => {
    expect(resamplePeaks([0.5], 0)).toEqual([]);
  });
});

describe("decodePeaks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubContext(rejectRates: number[] = []) {
    const created: number[] = [];
    class FakeOfflineAudioContext {
      constructor(_channels: number, _length: number, rate: number) {
        if (rejectRates.includes(rate)) throw new Error("unsupported rate");
        created.push(rate);
      }
      decodeAudioData() {
        return Promise.resolve({
          duration: 6.5,
          getChannelData: () => new Float32Array([0.4, -0.4, 0.4, -0.4]),
        });
      }
    }
    vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
    return created;
  }

  it("decodes at a low rate and returns peaks with the duration", async () => {
    const created = stubContext();
    const result = await decodePeaks(new ArrayBuffer(8), 2);
    expect(created).toEqual([8000]);
    expect(result).toEqual({ peaks: [1, 1], duration: 6.5 });
  });

  it("falls back to a standard rate when a low one is rejected", async () => {
    // Older WebKit refuses low OfflineAudioContext sample rates.
    const created = stubContext([8000]);
    await decodePeaks(new ArrayBuffer(8), 2);
    expect(created).toEqual([44100]);
  });

  it("fails clearly without an OfflineAudioContext", async () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    await expect(decodePeaks(new ArrayBuffer(8))).rejects.toThrow(
      /OfflineAudioContext/,
    );
  });
});
