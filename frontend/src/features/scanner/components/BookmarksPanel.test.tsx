import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock RTK Query hooks before importing the component
const mockGetBookmarkCallsQuery = vi.fn();
const mockToggleBookmarkMutation = vi.fn();

vi.mock("@/app/api", () => ({
  useGetBookmarkCallsQuery: (...args: unknown[]) =>
    mockGetBookmarkCallsQuery(...args),
  useToggleBookmarkMutation: () => mockToggleBookmarkMutation(),
}));

vi.mock("@/shared/services/audio/player", () => ({
  audioPlayer: {
    play: vi.fn(),
  },
}));

vi.mock("@/features/auth", () => ({
  selectToken: () => "fake-token",
}));

const store = vi.hoisted(() => ({
  config: null as { time12hFormat?: boolean } | null,
}));

vi.mock("@/app/store", () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({ scanner: { config: store.config } }),
}));

vi.mock("../shareSlice", () => ({
  useShareCallMutation: () => [vi.fn(), {}],
}));

import BookmarksPanel from "../components/BookmarksPanel";

describe("BookmarksPanel", () => {
  function setup(overrides?: { calls?: unknown[]; isLoading?: boolean }) {
    const calls = overrides?.calls ?? [];
    const isLoading = overrides?.isLoading ?? false;

    mockGetBookmarkCallsQuery.mockReturnValue({
      data: { calls },
      isLoading,
    });
    mockToggleBookmarkMutation.mockReturnValue([vi.fn(), {}]);
  }

  it('shows "Bookmarks" heading when open', () => {
    setup();
    render(<BookmarksPanel isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("Bookmarks")).toBeInTheDocument();
  });

  it("does not show panel content visibly when closed", () => {
    setup();
    const { container } = render(
      <BookmarksPanel isOpen={false} onClose={vi.fn()} />,
    );
    // The panel should have translate-x-full (off-screen) when closed
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain("translate-x-full");
  });

  it("shows empty state when no bookmarks", () => {
    setup({ calls: [] });
    render(<BookmarksPanel isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText("No bookmarked calls")).toBeInTheDocument();
  });

  it("calls onClose when close button clicked", () => {
    setup();
    const onClose = vi.fn();
    render(<BookmarksPanel isOpen={true} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close bookmarks"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("BookmarksPanel clock format", () => {
  // 13:05 local: the 12- and 24-hour forms differ in every locale.
  const dateTime = new Date(2026, 9, 18, 13, 5).getTime() / 1000;
  const timeIn = (hour12: boolean) =>
    new Date(dateTime * 1000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12,
    });

  it.each([
    { time12hFormat: false, shown: false, hidden: true },
    { time12hFormat: true, shown: true, hidden: false },
  ])(
    "shows call times in the server's clock format (12-hour: $time12hFormat)",
    ({ time12hFormat, shown, hidden }) => {
      store.config = { time12hFormat };
      mockGetBookmarkCallsQuery.mockReturnValue({
        data: {
          calls: [
            {
              id: 1,
              audioName: "a.m4a",
              audioType: "audio/mp4",
              dateTime,
              systemId: 1,
              talkgroupId: 1,
              systemLabel: "Sys1",
              talkgroupLabel: "TG1",
              talkgroupName: "Talkgroup One",
              talkgroupLed: "",
            },
          ],
        },
        isLoading: false,
      });
      mockToggleBookmarkMutation.mockReturnValue([vi.fn(), {}]);

      const { container } = render(
        <BookmarksPanel isOpen={true} onClose={vi.fn()} />,
      );
      expect(container.textContent).toContain(timeIn(shown));
      expect(container.textContent).not.toContain(timeIn(hidden));
      store.config = null;
    },
  );
});
