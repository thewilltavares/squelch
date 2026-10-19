import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { configureStore } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import SearchPanel from "../components/SearchPanel";
import { scannerSlice } from "../scannerSlice";
import { authSlice } from "@/features/auth";
import { callsSlice } from "../callsSlice";
import { api } from "@/app/api";
import type { RootState } from "@/app/store";
import type { ScannerConfig } from "@/types";
import type { Call } from "../types";
import { trMqttReducer } from "@/app/store";

// --- Mocks ---

const mockSearchCallsQuery = vi.fn();
const mockGetCallPeaksQuery = vi.fn();

vi.mock("../callsSlice", async () => {
  const actual = await vi.importActual<
    typeof import("../callsSlice")
  >("../callsSlice");
  return {
    ...actual,
    useSearchCallsQuery: (...args: unknown[]) => mockSearchCallsQuery(...args),
    useGetCallPeaksQuery: (...args: unknown[]) =>
      mockGetCallPeaksQuery(...args),
  };
});

const player = vi.hoisted(() => ({
  playNow: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  seek: vi.fn(),
}));

vi.mock("@/shared/services/audio/player", () => ({ audioPlayer: player }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 44,
        size: 44,
        key: i,
      })),
    getTotalSize: () => count * 44,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

// --- Helpers ---

function makeStore(preloadedState?: Partial<RootState>) {
  return configureStore({
    reducer: {
      scanner: scannerSlice.reducer,
      trMqtt: trMqttReducer,
      auth: authSlice.reducer,
      calls: callsSlice.reducer,
      [api.reducerPath]: api.reducer,
    },
    middleware: (gDM) => gDM().concat(api.middleware),
    preloadedState: preloadedState as RootState,
  });
}

const testConfig: ScannerConfig = {
  systems: [
    {
      id: 1,
      systemId: 100,
      label: "System Alpha",
      ledColor: "",
      talkgroups: [
        {
          id: 10,
          talkgroupId: 200,
          label: "TG-A1",
          name: "Alpha One",
          tag: "Law",
          group: "Police",
          ledColor: "#00ff00",
        },
        {
          id: 11,
          talkgroupId: 201,
          label: "TG-A2",
          name: "Alpha Two",
          tag: "Fire",
          group: "Fire Dept",
          ledColor: "#ff0000",
        },
      ],
    },
    {
      id: 2,
      systemId: 101,
      label: "System Beta",
      ledColor: "",
      talkgroups: [
        {
          id: 20,
          talkgroupId: 300,
          label: "TG-B1",
          name: "Beta One",
          tag: "EMS",
          group: "Police",
          ledColor: "#0000ff",
        },
      ],
    },
  ],
  branding: "TEST",
  email: "",
  version: "1.0",
  time12hFormat: false,
  showListenersCount: false,
  keypadBeeps: "uniden",
  shareableLinks: false,
  transcriptionEnabled: false,
  liveTranscriptDisplay: false,
};

function scannerState(
  overrides: Partial<RootState["scanner"]> = {},
): RootState["scanner"] {
  return {
    isLive: true,
    isPaused: false,
    isAudioActive: false,
    backgroundAudio: false,
      streamState: "idle" as const,
    heldSystem: null,
    heldTG: null,
    avoidList: [],
    currentCall: null,
    history: [],
    listenerCount: 0,
    connectionStatus: "disconnected",
    config: testConfig,
    tgSelection: {},
    configReceived: true,
    tgSelectionReady: true,
    pendingTranscripts: {},
    ...overrides,
  };
}

function renderPanel(
  preloadedState?: Partial<RootState>,
  isOpen = true,
  onClose = vi.fn(),
) {
  const store = makeStore(preloadedState);
  const result = render(
    <Provider store={store}>
      <SearchPanel isOpen={isOpen} onClose={onClose} />
    </Provider>,
  );
  return { ...result, store, onClose };
}

// --- Tests ---

describe("SearchPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchCallsQuery.mockReturnValue({
      data: { calls: [], total: 0 },
      isFetching: false,
    });
    mockGetCallPeaksQuery.mockReturnValue({ data: undefined });
  });

  describe("panel visibility", () => {
    it("is visible when isOpen is true", () => {
      renderPanel({ scanner: scannerState() }, true);
      expect(screen.getByText("Search Calls")).toBeInTheDocument();
    });

    it("is not rendered when isOpen is false", () => {
      const { container } = renderPanel({ scanner: scannerState() }, false);
      expect(container).toBeEmptyDOMElement();
    });

    it("clicking close button calls onClose", () => {
      const onClose = vi.fn();
      renderPanel({ scanner: scannerState() }, true, onClose);
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("does not render a backdrop in full-screen mode", () => {
      renderPanel({ scanner: scannerState() }, true);
      const backdrop = document.querySelector(".bg-black\\/50");
      expect(backdrop).toBeNull();
    });
  });

  describe("filter controls", () => {
    it("system checkbox filters are populated from config", () => {
      renderPanel({ scanner: scannerState() });
      fireEvent.click(screen.getByRole("button", { name: /System/i }));
      expect(screen.getByText("System Alpha")).toBeInTheDocument();
      expect(screen.getByText("System Beta")).toBeInTheDocument();
    });

    it("sort dropdown has 'Newest first' and 'Oldest first' options", () => {
      renderPanel({ scanner: scannerState() });
      const sortSelect = screen.getByDisplayValue("Newest first");
      expect(sortSelect).toBeInTheDocument();
      const options = sortSelect.querySelectorAll("option");
      expect(options).toHaveLength(2);
      expect(options[0].textContent).toBe("Newest first");
      expect(options[1].textContent).toBe("Oldest first");
    });

    it("reset filters button clears all filters", () => {
      const { store } = renderPanel({ scanner: scannerState() });
      // First set a filter
      act(() => {
        store.dispatch(callsSlice.actions.setSort("asc"));
      });
      // Click reset
      fireEvent.click(screen.getByText("Reset filters"));
      const state = store.getState();
      expect(state.calls.sort).toBe("desc");
      expect(state.calls.systemIds).toEqual([]);
      expect(state.calls.page).toBe(1);
    });
  });

  describe("active filter count", () => {
    it("badge shows correct count of active filters", () => {
      renderPanel({
        scanner: scannerState(),
        calls: {
          systemIds: [1],
          talkgroupIds: [],
          groupFilters: [],
          tagFilters: [],
          sort: "desc",
          page: 1,
          limit: 25,
          bookmarkedOnly: true,
          downloadMode: false,
        },
      });
      // systemIds + bookmarkedOnly = 2 active filters
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  describe("pagination", () => {
    it("shows 'Page X of Y' text", () => {
      mockSearchCallsQuery.mockReturnValue({
        data: { calls: [], total: 50 },
        isFetching: false,
      });
      renderPanel({ scanner: scannerState() });
      expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    });

    it("Next and Prev buttons exist", () => {
      renderPanel({ scanner: scannerState() });
      expect(screen.getByText("Prev")).toBeInTheDocument();
      expect(screen.getByText("Next")).toBeInTheDocument();
    });

    it("clicking Next dispatches setPage", () => {
      mockSearchCallsQuery.mockReturnValue({
        data: { calls: [], total: 50 },
        isFetching: false,
      });
      const { store } = renderPanel({ scanner: scannerState() });
      fireEvent.click(screen.getByText("Next"));
      expect(store.getState().calls.page).toBe(2);
    });
  });

  describe("search results", () => {
    it("shows 'No results' when no calls returned", () => {
      mockSearchCallsQuery.mockReturnValue({
        data: { calls: [], total: 0 },
        isFetching: false,
      });
      renderPanel({ scanner: scannerState() });
      expect(screen.getByText("No results")).toBeInTheDocument();
    });

    it("renders call rows from query results", () => {
      mockSearchCallsQuery.mockReturnValue({
        data: {
          calls: [
            {
              id: 1,
              dateTime: 1700000000,
              frequency: 0,
              duration: 5000,
              source: 0,
              systemId: 100,
              talkgroupId: 200,
              systemLabel: "Sys1",
              talkgroupLabel: "TG1",
              talkgroupName: "Talkgroup One",
              talkgroupTag: "Law",
              talkgroupGroup: "Police",
              talkgroupLed: "#00ff00",
              transcript: "",
              bookmarked: false,
            },
          ],
          total: 1,
        },
        isFetching: false,
      });
      renderPanel({ scanner: scannerState() });
      expect(screen.getByText("TG1 - Talkgroup One")).toBeInTheDocument();
      expect(screen.getByText("Sys1")).toBeInTheDocument();
    });

    it.each([
      { time12hFormat: false, shown: false, hidden: true },
      { time12hFormat: true, shown: true, hidden: false },
    ])(
      "shows call times in the server's clock format (12-hour: $time12hFormat)",
      ({ time12hFormat, shown, hidden }) => {
        // 13:05 local: the 12- and 24-hour forms differ in every locale.
        const dateTime = new Date(2026, 9, 18, 13, 5).getTime() / 1000;
        const timeIn = (hour12: boolean) =>
          new Date(dateTime * 1000).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12,
          });
        mockSearchCallsQuery.mockReturnValue({
          data: {
            calls: [
              {
                id: 1,
                dateTime,
                systemId: 100,
                talkgroupId: 200,
                systemLabel: "Sys1",
                talkgroupLabel: "TG1",
                talkgroupName: "Talkgroup One",
                bookmarked: false,
              },
            ],
            total: 1,
          },
          isFetching: false,
        });
        renderPanel({
          scanner: scannerState({
            config: { ...testConfig, time12hFormat },
          }),
        });
        const row = screen.getByText("TG1 - Talkgroup One").closest(
          "[data-index]",
        ) as HTMLElement;
        expect(row.textContent).toContain(timeIn(shown));
        expect(row.textContent).not.toContain(timeIn(hidden));
      },
    );
  });

  describe("playback", () => {
    const result = {
      id: 7,
      audioName: "call-7.m4a",
      audioType: "audio/mp4",
      dateTime: 1700000000,
      frequency: 0,
      duration: 6,
      source: 0,
      systemId: 100,
      talkgroupId: 200,
      systemLabel: "Sys1",
      talkgroupLabel: "TG1",
      talkgroupName: "Talkgroup One",
      talkgroupTag: "Law",
      talkgroupGroup: "Police",
      talkgroupLed: "",
      transcript: "",
      bookmarked: false,
    };
    /** The same Call, as the player reports it while it plays. */
    const playing: Call = {
      id: 7,
      audioName: "call-7.m4a",
      audioType: "audio/mp4",
      dateTime: 1700000000,
      systemId: 100,
      system: 100,
      talkgroupId: 200,
      talkgroup: 200,
    };

    beforeEach(() => {
      mockSearchCallsQuery.mockReturnValue({
        data: { calls: [result], total: 1 },
        isFetching: false,
      });
    });

    it("has an Autoplay toggle, off to begin with", () => {
      renderPanel({ scanner: scannerState() });
      const toggle = screen.getByRole("checkbox", { name: /autoplay/i });
      expect(toggle).not.toBeChecked();
      fireEvent.click(toggle);
      expect(toggle).toBeChecked();
    });

    it("plays a call from its row", () => {
      renderPanel({ scanner: scannerState() });
      fireEvent.click(screen.getByRole("button", { name: "Play call" }));
      expect(player.playNow).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        expect.objectContaining({ onEnded: expect.any(Function) }),
      );
    });

    it("marks the playing call and lets its row pause it", () => {
      // The full-screen panel covers the scanner's own transport, so the
      // playing row carries the pause control.
      const { store } = renderPanel({
        scanner: scannerState({
          currentCall: playing,
          isAudioActive: true,
        }),
      });
      const button = screen.getByRole("button", { name: "Pause call" });
      expect(button.closest("[aria-current]")).not.toBeNull();

      fireEvent.click(button);
      expect(player.pause).toHaveBeenCalled();
      expect(store.getState().scanner.isPaused).toBe(true);
    });

    it("starts a call that is not playing from the point chosen on its waveform", () => {
      mockGetCallPeaksQuery.mockReturnValue({
        data: { peaks: [0.5, 1, 0.25], duration: 10 },
      });
      renderPanel({ scanner: scannerState() });

      fireEvent.change(screen.getByRole("slider", { name: /seek/i }), {
        target: { value: "4" },
      });

      expect(player.playNow).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        expect.objectContaining({ startAt: 4 }),
      );
      expect(player.seek).not.toHaveBeenCalled();
    });

    it("seeks within the call that is already playing", () => {
      mockGetCallPeaksQuery.mockReturnValue({
        data: { peaks: [0.5, 1, 0.25], duration: 10 },
      });
      renderPanel({
        scanner: scannerState({
          currentCall: playing,
          isAudioActive: true,
        }),
      });

      fireEvent.change(screen.getByRole("slider", { name: /seek/i }), {
        target: { value: "2.5" },
      });

      expect(player.seek).toHaveBeenCalledWith(2.5);
      expect(player.playNow).not.toHaveBeenCalled();
    });

    it("plays a finished call again from the point chosen", () => {
      // Regression: the display keeps the last Call as currentCall after it
      // ends. The row stayed "playing", took the click as a seek, and the
      // player — no longer holding the Call — ignored it, leaving the
      // waveform stuck at the end.
      mockGetCallPeaksQuery.mockReturnValue({
        data: { peaks: [0.5, 1, 0.25], duration: 10 },
      });
      renderPanel({
        scanner: scannerState({
          currentCall: playing,
          isAudioActive: false,
        }),
      });

      expect(screen.getByRole("button", { name: "Play call" })).toBeInTheDocument();
      fireEvent.change(screen.getByRole("slider", { name: /seek/i }), {
        target: { value: "6" },
      });

      expect(player.playNow).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        expect.objectContaining({ startAt: 6 }),
      );
      expect(player.seek).not.toHaveBeenCalled();
    });
  });
});
