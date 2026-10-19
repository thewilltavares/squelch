import { useEffect, useMemo, useRef, useState } from "react";
import { useGetCallPeaksQuery } from "../callsSlice";
import {
  formatElapsed,
  usePlaybackPosition,
} from "../hooks/usePlaybackPosition";
import { resamplePeaks } from "@/shared/services/audio/peaks";

interface CallWaveformProps {
  callId: number;
  /** True while this Call is the one playing; only then does it track. */
  isCurrent: boolean;
  /** Called on release with the chosen position in seconds. */
  onSeek: (seconds: number) => void;
}

/** Drawing height in px; matches the container's h-10. */
const HEIGHT = 40;
/** Horizontal px per bar, gap included. */
const BAR_PITCH = 3;
const BAR_WIDTH = 2;
/** Shortest bar, so silence still reads as a line to click on. */
const MIN_BAR = 2;
/** Width assumed until the first measurement (and in jsdom). */
const FALLBACK_WIDTH = 600;

/** Track the rendered width of an element. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * A Call's waveform that doubles as its seek bar.
 *
 * Bars are drawn one per few pixels of the real width, in pixel units, so
 * they stay crisp and rounded at any row width. Hovering shows where a
 * click would land — a line, the time, and the stretch between the
 * playhead and the pointer shaded.
 *
 * Seeking is a native range input laid over the bars, invisible, so
 * click, drag, touch and keyboard all work and screen readers get a real
 * slider. It seeks on release rather than on every movement: on a row
 * that is not playing, the first seek starts the Call, and starting it
 * again on every pixel of a drag would restart it each time.
 */
export function CallWaveform({ callId, isCurrent, onSeek }: CallWaveformProps) {
  const { data } = useGetCallPeaksQuery(callId);
  const position = usePlaybackPosition(isCurrent);
  const [dragging, setDragging] = useState<number | null>(null);
  /** Pointer position over the waveform, 0–1, while hovering. */
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, measured] = useWidth<HTMLDivElement>();
  const width = measured || FALLBACK_WIDTH;

  const duration = data?.duration ?? 0;
  const shown = dragging ?? (isCurrent ? position : 0);
  const progress = duration > 0 ? Math.min(1, shown / duration) : 0;

  const bars = useMemo(() => {
    const count = Math.max(1, Math.floor(width / BAR_PITCH));
    const values = data
      ? resamplePeaks(data.peaks, count)
      : new Array<number>(count).fill(0);
    const pitch = width / values.length;
    return values.map((v, i) => {
      const h = Math.max(MIN_BAR, v * HEIGHT);
      return {
        x: i * pitch + (pitch - Math.min(BAR_WIDTH, pitch)) / 2,
        y: (HEIGHT - h) / 2,
        h,
        at: (i + 0.5) / values.length,
      };
    });
  }, [data, width]);
  const barWidth = Math.min(BAR_WIDTH, width / bars.length);

  // React's onChange is the browser's `input` event, which fires on every
  // movement. The native `change` event fires once, on release (or per
  // keyboard step) — wherever the pointer ends up — so seeking listens
  // for that directly.
  //
  // A press that leaves the value where it was fires no `change`: a click
  // on the invisible thumb, or one that rounds to the current value. On a
  // row that is not playing the value is 0, so a click at the very start
  // did nothing. The `click` that follows seeks instead, unless the press
  // moved the value or produced a `change`, whichever order the browser
  // fires them in.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    let pressedAt: string | null = null;
    let committed = false;
    const seek = () => {
      setDragging(null);
      const seconds = Number(el.value);
      if (Number.isFinite(seconds)) onSeek(seconds);
    };
    const press = () => {
      pressedAt = el.value;
      committed = false;
    };
    const commit = () => {
      committed = true;
      seek();
    };
    const click = () => {
      if (pressedAt !== null && !committed && el.value === pressedAt) seek();
      pressedAt = null;
    };
    el.addEventListener("pointerdown", press);
    el.addEventListener("change", commit);
    el.addEventListener("click", click);
    return () => {
      el.removeEventListener("pointerdown", press);
      el.removeEventListener("change", commit);
      el.removeEventListener("click", click);
    };
  }, [onSeek]);

  const barClass = (at: number) => {
    const played = at <= progress;
    if (hover == null) {
      return played ? "fill-primary" : "fill-base-content/25";
    }
    // Shade what a click at the pointer would skip: ahead of the playhead
    // lightened, behind it dimmed.
    if (played) return at <= hover ? "fill-primary" : "fill-primary/50";
    return at <= hover ? "fill-base-content/50" : "fill-base-content/25";
  };

  const hoverSeconds = hover != null ? hover * duration : 0;

  return (
    <div
      ref={boxRef}
      className="relative mt-1 h-10 w-full rounded has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-primary"
      onPointerMove={(e) => {
        if (!data || e.pointerType === "touch") return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        setHover(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        {bars.map((bar, i) => (
          <rect
            key={i}
            data-bar=""
            x={bar.x}
            y={bar.y}
            width={barWidth}
            height={bar.h}
            rx={barWidth / 2}
            className={barClass(bar.at)}
          />
        ))}
        {/* Playhead, on the Call playing or while dragging. */}
        {(isCurrent || dragging != null) && duration > 0 && (
          <rect
            x={Math.min(width - 1.5, progress * width)}
            y={0}
            width={1.5}
            height={HEIGHT}
            className="fill-primary"
          />
        )}
        {/* Hover cursor. */}
        {hover != null && (
          <rect
            x={Math.min(width - 1, hover * width)}
            y={0}
            width={1}
            height={HEIGHT}
            className="fill-base-content/70"
          />
        )}
      </svg>
      {hover != null && duration > 0 && (
        <span
          className="pointer-events-none absolute -top-4 rounded bg-base-300 px-1 text-[10px] leading-4 text-base-content"
          style={{
            left: `${hover * 100}%`,
            transform: `translateX(${hover > 0.9 ? "-100%" : hover < 0.1 ? "0" : "-50%"})`,
          }}
        >
          {formatElapsed(hoverSeconds)}
        </span>
      )}
      <input
        ref={inputRef}
        type="range"
        min={0}
        max={duration > 0 ? duration : 1}
        step={0.1}
        value={shown}
        disabled={!data}
        aria-label="Seek within call"
        aria-valuetext={`${formatElapsed(shown)} of ${formatElapsed(duration)}`}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
        onChange={(e) => {
          // React also routes the native `change` here; that one is the
          // release, already handled above, and must not re-open a preview.
          if (e.nativeEvent.type !== "input") return;
          setDragging(Number(e.currentTarget.value));
        }}
      />
    </div>
  );
}
