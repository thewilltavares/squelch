import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CallWaveform } from "./CallWaveform";

const mockGetCallPeaksQuery = vi.fn();
const position = vi.hoisted(() => ({ seconds: 0 }));

vi.mock("../callsSlice", () => ({
  useGetCallPeaksQuery: (...args: unknown[]) => mockGetCallPeaksQuery(...args),
}));

vi.mock("../hooks/usePlaybackPosition", async () => {
  const actual = await vi.importActual<
    typeof import("../hooks/usePlaybackPosition")
  >("../hooks/usePlaybackPosition");
  return {
    ...actual,
    usePlaybackPosition: (active: boolean) => (active ? position.seconds : 0),
  };
});

/** Bars drawn in the played colour (not the playhead line). */
function playedBars(container: HTMLElement): number {
  return container.querySelectorAll("rect[data-bar].fill-primary").length;
}

describe("CallWaveform", () => {
  beforeEach(() => {
    position.seconds = 0;
    mockGetCallPeaksQuery.mockReturnValue({
      data: { peaks: [0.2, 1, 0.6, 0.4], duration: 10 },
    });
  });

  it("is a labelled slider over the call's length", () => {
    render(<CallWaveform callId={1} isCurrent={false} onSeek={vi.fn()} />);
    const slider = screen.getByRole("slider", { name: "Seek within call" });
    expect(slider).toHaveAttribute("max", "10");
    expect(slider).toHaveAttribute("aria-valuetext", "0:00 of 0:10");
    expect(mockGetCallPeaksQuery).toHaveBeenCalledWith(1);
  });

  it("cannot be used until the waveform has loaded", () => {
    mockGetCallPeaksQuery.mockReturnValue({ data: undefined });
    const { container } = render(
      <CallWaveform callId={1} isCurrent={false} onSeek={vi.fn()} />,
    );
    expect(screen.getByRole("slider")).toBeDisabled();
    // A flat placeholder still holds the row's shape.
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
  });

  it("shows progress only on the call that is playing", () => {
    position.seconds = 5;
    const { container, rerender } = render(
      <CallWaveform callId={1} isCurrent={true} onSeek={vi.fn()} />,
    );
    // Halfway through four bars: the first two are played.
    expect(playedBars(container)).toBe(2);

    rerender(<CallWaveform callId={1} isCurrent={false} onSeek={vi.fn()} />);
    expect(playedBars(container)).toBe(0);
  });

  it("previews while dragging and seeks once, on release", () => {
    const onSeek = vi.fn();
    const { container } = render(
      <CallWaveform callId={1} isCurrent={false} onSeek={onSeek} />,
    );
    const slider = screen.getByRole("slider");

    // Dragging: the browser fires `input` on every movement.
    fireEvent.input(slider, { target: { value: "7.5" } });
    expect(onSeek).not.toHaveBeenCalled();
    expect(playedBars(container)).toBe(3);

    // Release: one `change`.
    fireEvent.change(slider);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(7.5);
    // The preview gives way to the real position (none: not playing).
    expect(playedBars(container)).toBe(0);
  });

  it("shows the time under the pointer before a click", () => {
    const { container } = render(
      <CallWaveform callId={1} isCurrent={false} onSeek={vi.fn()} />,
    );
    const box = container.firstElementChild as HTMLElement;
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 200,
    } as DOMRect);

    // A quarter of the way along a ten-second call.
    fireEvent.pointerMove(box, { clientX: 50, pointerType: "mouse" });
    expect(screen.getByText("0:02")).toBeInTheDocument();

    fireEvent.pointerLeave(box);
    expect(screen.queryByText("0:02")).toBeNull();
  });
});
