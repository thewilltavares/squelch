import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import SearchPanel from "../components/SearchPanel";
import {
  callReceived,
  scannerSlice,
  setAudioActive,
  setCurrentCall,
} from "../scannerSlice";
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
  stop: vi.fn(),
}));

vi.mock("@/shared/services/audio/player", () => ({ audioPlayer: player }));

/** The row-height estimate from the panel's latest render. */
const virtualizer = vi.hoisted(() => ({
  estimateSize: (_index: number): number => 0,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: (index: number) => number;
  }) => {
    virtualizer.estimateSize = estimateSize;
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, i) => ({
          index: i,
          start: i * 44,
          size: 44,
          key: i,
        })),
      getTotalSize: () => count * 44,
      measurementsCache: Array.from({ length: count }, (_, i) => ({
        start: i * 44,
      })),
      measureElement: () => {},
      scrollToIndex: () => {},
    };
  },
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
    // A listener middleware, as the app's store has, for auto-refresh.
    middleware: (gDM) =>
      gDM()
        .prepend(createListenerMiddleware().middleware)
        .concat(api.middleware),
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
  live: { playingLive?: boolean; queuedLive?: number } = {},
) {
  const store = makeStore(preloadedState);
  const result = render(
    <Provider store={store}>
      <SearchPanel isOpen={isOpen} onClose={onClose} {...live} />
    </Provider>,
  );
  return { ...result, store, onClose };
}

/** Turn the Waveform switch on before rendering, as a returning user would. */
function showWaveforms() {
  localStorage.setItem("squelch-search-waveform", "true");
}

// --- Tests ---

describe("SearchPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Autoplay, Auto-refresh and Waveform are remembered between visits.
    localStorage.clear();
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

  describe("auto-refresh", () => {
    const refetch = vi.fn();
    const arrived: Call = {
      id: 50,
      audioName: "call-50.m4a",
      audioType: "audio/mp4",
      dateTime: 1700000000,
      systemId: 1,
      system: 1,
      talkgroupId: 10,
      talkgroup: 10,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      refetch.mockClear();
      mockSearchCallsQuery.mockReturnValue({
        data: { calls: [], total: 50 },
        currentData: { calls: [], total: 50 },
        isFetching: false,
        refetch,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const toggle = () =>
      screen.getByRole("checkbox", { name: /auto-refresh/i });

    it("is remembered in this browser", () => {
      const { unmount } = renderPanel({ scanner: scannerState() });
      fireEvent.click(toggle());
      unmount();

      renderPanel({ scanner: scannerState() });

      expect(toggle()).toBeChecked();
    });

    it("is off to begin with, and ignores new calls", () => {
      const { store } = renderPanel({ scanner: scannerState() });
      expect(toggle()).not.toBeChecked();

      act(() => {
        store.dispatch(callReceived(arrived));
        vi.runAllTimers();
      });

      expect(refetch).not.toHaveBeenCalled();
    });

    it("refreshes once for a burst of new calls", () => {
      const { store } = renderPanel({ scanner: scannerState() });
      fireEvent.click(toggle());

      act(() => {
        store.dispatch(callReceived(arrived));
        store.dispatch(callReceived({ ...arrived, id: 51 }));
        store.dispatch(callReceived({ ...arrived, id: 52 }));
      });
      expect(refetch).not.toHaveBeenCalled();
      act(() => vi.runAllTimers());

      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("waits past page 1 of Newest first, where rows would shift", () => {
      const { store } = renderPanel({ scanner: scannerState() });
      fireEvent.click(toggle());
      fireEvent.click(screen.getByText("Next"));

      act(() => {
        store.dispatch(callReceived(arrived));
        vi.runAllTimers();
      });

      expect(refetch).not.toHaveBeenCalled();
      expect(toggle().closest("label")).toHaveAttribute(
        "title",
        expect.stringMatching(/each new call would shift/i),
      );
    });

    it("fetches page 1 again on return when calls arrived while it waited", () => {
      // Regression: page 1 came back from the cache without the calls that
      // arrived meanwhile, so a live call playing from them was in no row.
      mockSearchCallsQuery.mockReturnValue({
        data: { calls: [], total: 50 },
        currentData: { calls: [], total: 50 },
        isFetching: false,
        refetch,
        fulfilledTimeStamp: 1,
      });
      const { store } = renderPanel({ scanner: scannerState() });
      fireEvent.click(toggle());
      expect(refetch).not.toHaveBeenCalled(); // nothing missed yet
      fireEvent.click(screen.getByText("Next"));
      act(() => {
        store.dispatch(callReceived(arrived));
        vi.runAllTimers();
      });
      expect(refetch).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Prev"));

      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("refreshes any page of Oldest first, which new calls only add to", () => {
      const { store } = renderPanel({ scanner: scannerState() });
      fireEvent.click(toggle());
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "asc" },
      });
      fireEvent.click(screen.getByText("Next"));

      act(() => {
        store.dispatch(callReceived(arrived));
        vi.runAllTimers();
      });

      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("holds the rows being read in place as new ones arrive above", () => {
      const row = (id: number) => ({
        id,
        audioName: `call-${id}.m4a`,
        audioType: "audio/mp4",
        dateTime: 1700000000 + id,
        frequency: 0,
        duration: 5,
        source: 0,
        systemId: 100,
        talkgroupId: 200,
        systemLabel: "Sys1",
        talkgroupLabel: "TG1",
        talkgroupName: "Talkgroup One",
        talkgroupTag: "",
        talkgroupGroup: "",
        talkgroupLed: "",
        transcript: "",
        bookmarked: false,
      });
      const pageOf = (ids: number[]) => ({
        data: { calls: ids.map(row), total: ids.length },
        currentData: { calls: ids.map(row), total: ids.length },
        isFetching: false,
        refetch,
      });
      mockSearchCallsQuery.mockReturnValue(pageOf([3, 2, 1]));
      const { store, container, rerender } = renderPanel({
        scanner: scannerState(),
      });
      const list = container.querySelector<HTMLElement>(
        ".relative.flex-1.overflow-y-auto",
      )!;
      list.scrollTop = 60;

      // Two calls came in: the rows mocked at 44px each move down 88.
      mockSearchCallsQuery.mockReturnValue(pageOf([5, 4, 3, 2, 1]));
      rerender(
        <Provider store={store}>
          <SearchPanel isOpen onClose={vi.fn()} />
        </Provider>,
      );

      expect(list.scrollTop).toBe(148);

      // Another sort is a different list, whatever rows it shares.
      mockSearchCallsQuery.mockReturnValue(pageOf([1, 2, 3, 4, 5]));
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "asc" },
      });

      expect(list.scrollTop).toBe(148);
    });

    it("keeps the list in view while refreshing it", () => {
      mockSearchCallsQuery.mockReturnValue({
        data: { calls: [], total: 0 },
        currentData: { calls: [], total: 0 },
        isFetching: true,
        refetch,
      });
      const { container } = renderPanel({ scanner: scannerState() });

      expect(container.querySelector(".loading-spinner")).toBeNull();
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

    describe("waveform", () => {
      const toggle = () => screen.getByRole("checkbox", { name: /waveform/i });

      it("is off to begin with, and fetches no waveforms", () => {
        renderPanel({ scanner: scannerState() });

        expect(toggle()).not.toBeChecked();
        expect(screen.queryByRole("slider", { name: /seek/i })).toBeNull();
        expect(mockGetCallPeaksQuery).not.toHaveBeenCalled();
      });

      it("shows each result's waveform once on, and is remembered", () => {
        const { unmount } = renderPanel({ scanner: scannerState() });
        fireEvent.click(toggle());
        expect(screen.getByRole("slider", { name: /seek/i })).toBeInTheDocument();
        unmount();

        renderPanel({ scanner: scannerState() });

        expect(toggle()).toBeChecked();
        expect(screen.getByRole("slider", { name: /seek/i })).toBeInTheDocument();
      });

      it("counts the waveform in a row's estimated height", () => {
        renderPanel({ scanner: scannerState() });
        expect(virtualizer.estimateSize(0)).toBe(62);

        fireEvent.click(toggle());

        expect(virtualizer.estimateSize(0)).toBe(108);
      });
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
      showWaveforms();
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
      showWaveforms();
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
      showWaveforms();
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

    describe("only this talkgroup", () => {
      const button = () =>
        screen.getByRole("button", { name: "Only this talkgroup" });

      it("narrows the search to the call's talkgroup, and back", () => {
        // The result names talkgroup 200 of system 100; the filter takes
        // that talkgroup's own ID, 10.
        const { store } = renderPanel({ scanner: scannerState() });
        expect(button()).toHaveAttribute("aria-pressed", "false");

        fireEvent.click(button());
        expect(store.getState().calls.talkgroupIds).toEqual([10]);
        expect(button()).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(button());
        expect(store.getState().calls.talkgroupIds).toEqual([]);
      });

      it("leaves the live scanner's talkgroup selection alone", () => {
        const { store } = renderPanel({
          scanner: scannerState({ tgSelection: { 200: true, 201: false } }),
        });

        fireEvent.click(button());

        expect(store.getState().scanner.tgSelection).toEqual({
          200: true,
          201: false,
        });
      });

      it("is not offered for a talkgroup the config does not know", () => {
        mockSearchCallsQuery.mockReturnValue({
          data: { calls: [{ ...result, talkgroupId: 999 }], total: 1 },
          isFetching: false,
        });
        renderPanel({ scanner: scannerState() });

        expect(
          screen.queryByRole("button", { name: "Only this talkgroup" }),
        ).toBeNull();
      });
    });

    describe("transport", () => {
      // Newest first: 8 is the newer call, at the top.
      const newer = { ...result, id: 8, dateTime: 1700000060 };

      beforeEach(() => {
        mockSearchCallsQuery.mockReturnValue({
          data: { calls: [newer, result], total: 2 },
          isFetching: false,
        });
      });

      it("plays the top of the list when nothing has been heard", () => {
        renderPanel({ scanner: scannerState() });
        expect(
          screen.getByRole("button", { name: "Previous call" }),
        ).toBeDisabled();
        expect(screen.getByRole("button", { name: "Next call" })).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: "Play" }));

        expect(player.playNow).toHaveBeenCalledWith(
          expect.objectContaining({ id: 8 }),
          expect.anything(),
        );
      });

      it("pauses the call that is playing", () => {
        const { store } = renderPanel({
          scanner: scannerState({ currentCall: playing, isAudioActive: true }),
        });

        fireEvent.click(screen.getByRole("button", { name: "Pause" }));

        expect(player.pause).toHaveBeenCalled();
        expect(store.getState().scanner.isPaused).toBe(true);
        expect(player.playNow).not.toHaveBeenCalled();
      });

      it("plays a finished call again", () => {
        renderPanel({
          scanner: scannerState({ currentCall: playing, isAudioActive: false }),
        });

        fireEvent.click(screen.getByRole("button", { name: "Play" }));

        expect(player.playNow).toHaveBeenCalledWith(
          expect.objectContaining({ id: 7 }),
          expect.anything(),
        );
      });

      it("offers Stop only while a result plays or is paused", () => {
        const stop = () => screen.getByRole("button", { name: "Stop" });
        const { unmount } = renderPanel({ scanner: scannerState() });
        expect(stop()).toBeDisabled();
        unmount();

        const paused = renderPanel({
          scanner: scannerState({
            currentCall: playing,
            isAudioActive: true,
            isPaused: true,
          }),
        });
        expect(stop()).toBeEnabled();
        paused.unmount();

        // A live call is the scanner's to stop, not search's.
        renderPanel(
          { scanner: scannerState({ currentCall: playing, isAudioActive: true }) },
          true,
          vi.fn(),
          { playingLive: true },
        );
        expect(stop()).toBeDisabled();
      });

      it("stops a result and forgets the place", () => {
        const { store } = renderPanel({
          scanner: scannerState({
            currentCall: playing,
            isAudioActive: true,
            isPaused: true,
          }),
        });

        fireEvent.click(screen.getByRole("button", { name: "Stop" }));

        expect(player.stop).toHaveBeenCalled();
        expect(store.getState().scanner.isPaused).toBe(false);
        // The player ends the call, with no live calls waiting. The display
        // still shows it, but neither the skips nor Play go on from it.
        act(() => {
          store.dispatch(setAudioActive(false));
        });
        expect(
          screen.getByRole("button", { name: "Previous call" }),
        ).toBeDisabled();
        expect(screen.getByRole("button", { name: "Next call" })).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: "Play" }));

        expect(player.playNow).toHaveBeenCalledWith(
          expect.objectContaining({ id: 8 }),
          expect.anything(),
        );
      });

      it("skips forward in time, up the list for Newest first", () => {
        renderPanel({
          scanner: scannerState({ currentCall: playing, isAudioActive: true }),
        });
        // 7 is the older of the two, on the only page.
        expect(
          screen.getByRole("button", { name: "Previous call" }),
        ).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: "Next call" }));

        expect(player.playNow).toHaveBeenCalledWith(
          expect.objectContaining({ id: 8 }),
          expect.anything(),
        );
      });

      it("pauses on Space, not skips again, after a skip", () => {
        // Regression: the click left focus on Next call, and Space pressed
        // it again, skipping over and over.
        const { store } = renderPanel({
          scanner: scannerState({ currentCall: playing, isAudioActive: true }),
        });
        const next = screen.getByRole("button", { name: "Next call" });

        const down = fireEvent.keyDown(next, { key: " " });
        const up = fireEvent.keyUp(next, { key: " " });

        expect(down).toBe(false); // default prevented
        expect(up).toBe(false);
        expect(store.getState().scanner.isPaused).toBe(true);
        expect(player.pause).toHaveBeenCalledTimes(1);
        expect(player.playNow).not.toHaveBeenCalled();
      });

      describe("keyboard", () => {
        it("pauses on Space with nothing focused", () => {
          // Regression: tab away and back, and focus is on the page, not
          // a transport button, so Space did nothing.
          const { store } = renderPanel({
            scanner: scannerState({ currentCall: playing, isAudioActive: true }),
          });

          expect(fireEvent.keyDown(document.body, { key: " " })).toBe(false);

          expect(store.getState().scanner.isPaused).toBe(true);
        });

        it("skips forward on Right and back on Left", () => {
          renderPanel({
            scanner: scannerState({ currentCall: playing, isAudioActive: true }),
          });

          fireEvent.keyDown(document.body, { key: "ArrowRight" });
          expect(player.playNow).toHaveBeenLastCalledWith(
            expect.objectContaining({ id: 8 }),
            expect.anything(),
          );

          fireEvent.keyDown(document.body, { key: "ArrowLeft" });
          expect(player.playNow).toHaveBeenLastCalledWith(
            expect.objectContaining({ id: 7 }),
            expect.anything(),
          );
        });

        it("skips with the arrows after a waveform click, not seeks", () => {
          showWaveforms();
          mockGetCallPeaksQuery.mockReturnValue({
            data: { peaks: [0.5, 1, 0.25], duration: 10 },
          });
          renderPanel({
            scanner: scannerState({ currentCall: playing, isAudioActive: true }),
          });
          const [slider] = screen.getAllByRole("slider", { name: /seek/i });

          expect(fireEvent.keyDown(slider, { key: "ArrowRight" })).toBe(false);

          expect(player.playNow).toHaveBeenCalledWith(
            expect.objectContaining({ id: 8 }),
            expect.anything(),
          );
        });

        it("leaves the keys alone in a text field", () => {
          const { store } = renderPanel({
            scanner: scannerState({ currentCall: playing, isAudioActive: true }),
          });
          const field = screen.getByPlaceholderText("Search transcripts...");

          expect(fireEvent.keyDown(field, { key: " " })).toBe(true);
          expect(fireEvent.keyDown(field, { key: "ArrowRight" })).toBe(true);

          expect(store.getState().scanner.isPaused).toBe(false);
          expect(player.playNow).not.toHaveBeenCalled();
        });

        it("leaves the keys alone with a modifier held", () => {
          // Alt+Left is the browser's Back.
          renderPanel({
            scanner: scannerState({ currentCall: playing, isAudioActive: true }),
          });

          expect(
            fireEvent.keyDown(document.body, { key: "ArrowRight", altKey: true }),
          ).toBe(true);
          expect(player.playNow).not.toHaveBeenCalled();
        });

        it("stops listening once the panel closes", () => {
          const { store, rerender } = renderPanel({
            scanner: scannerState({ currentCall: playing, isAudioActive: true }),
          });
          rerender(
            <Provider store={store}>
              <SearchPanel isOpen={false} onClose={vi.fn()} />
            </Provider>,
          );

          expect(fireEvent.keyDown(document.body, { key: " " })).toBe(true);
          expect(store.getState().scanner.isPaused).toBe(false);
        });
      });

      describe("live indicator", () => {
        const liveCall: Call = {
          ...playing,
          id: 99,
          talkgroupLabel: "FD1",
          talkgroupName: "Fire Ops",
        };

        it("says when a live call is playing, and which", () => {
          renderPanel(
            {
              scanner: scannerState({
                currentCall: liveCall,
                isAudioActive: true,
              }),
            },
            true,
            vi.fn(),
            { playingLive: true },
          );

          expect(screen.getByRole("status")).toHaveTextContent(
            "Live: FD1 - Fire Ops",
          );
        });

        it("says nothing about a search call playing", () => {
          renderPanel({
            scanner: scannerState({ currentCall: playing, isAudioActive: true }),
          });

          expect(screen.getByRole("status")).toBeEmptyDOMElement();
        });

        it("counts the live calls waiting", () => {
          renderPanel(
            {
              scanner: scannerState({
                currentCall: playing,
                isAudioActive: true,
              }),
            },
            true,
            vi.fn(),
            { queuedLive: 2 },
          );

          expect(screen.getByRole("status")).toHaveTextContent("2 live queued");
        });

        it("says when the live stream is playing in background mode", () => {
          renderPanel(
            {
              scanner: scannerState({
                backgroundAudio: true,
                streamState: "playing",
              }),
            },
            true,
            vi.fn(),
            // The local queue is not in use while the stream plays.
            { queuedLive: 3 },
          );

          const status = screen.getByRole("status");
          expect(status).toHaveTextContent("Live stream");
          expect(status).not.toHaveTextContent("queued");
        });

        it("keeps skipping from the last result while a live call plays", () => {
          const { store, rerender } = renderPanel({
            scanner: scannerState(),
          });
          fireEvent.click(screen.getAllByRole("button", { name: "Play call" })[1]);
          // Call 7 ended and a queued live call took over.
          act(() => {
            store.dispatch(setCurrentCall(liveCall));
            store.dispatch(setAudioActive(true));
          });
          rerender(
            <Provider store={store}>
              <SearchPanel isOpen onClose={vi.fn()} playingLive />
            </Provider>,
          );
          player.playNow.mockClear();

          fireEvent.click(screen.getByRole("button", { name: "Next call" }));

          expect(player.playNow).toHaveBeenCalledWith(
            expect.objectContaining({ id: 8 }),
            expect.anything(),
          );
        });
      });

      it("skips back from a call that has ended", () => {
        renderPanel({
          scanner: scannerState({
            currentCall: { ...playing, id: 8 },
            isAudioActive: false,
          }),
        });
        expect(screen.getByRole("button", { name: "Next call" })).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: "Previous call" }));

        expect(player.playNow).toHaveBeenCalledWith(
          expect.objectContaining({ id: 7 }),
          expect.anything(),
        );
      });
    });
  });
});
