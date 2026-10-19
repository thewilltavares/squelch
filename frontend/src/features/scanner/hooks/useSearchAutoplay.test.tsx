import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { configureStore } from "@reduxjs/toolkit";
import { Provider } from "react-redux";
import { api } from "@/app/api";
import { scannerSlice } from "../scannerSlice";
import { authSlice } from "@/features/auth";
import {
  callsApi,
  callsSlice,
  type CallSearchParams,
  type CallSearchResponse,
  type CallSearchResult,
} from "../callsSlice";
import { useSearchAutoplay } from "./useSearchAutoplay";

const player = vi.hoisted(() => ({ playNow: vi.fn() }));
vi.mock("@/shared/services/audio/player", () => ({ audioPlayer: player }));

type OnEnded = (failed: boolean) => void;

function makeStore() {
  return configureStore({
    reducer: {
      scanner: scannerSlice.reducer,
      auth: authSlice.reducer,
      calls: callsSlice.reducer,
      [api.reducerPath]: api.reducer,
    },
    middleware: (gDM) => gDM().concat(api.middleware),
  });
}
type TestStore = ReturnType<typeof makeStore>;

function result(id: number): CallSearchResult {
  return {
    id,
    audioName: `call-${id}.m4a`,
    audioType: "audio/mp4",
    dateTime: 1700000000 + id,
    frequency: 0,
    duration: 5,
    source: 0,
    systemId: 1,
    talkgroupId: 100,
    systemLabel: "Sys",
    talkgroupLabel: "TG",
    talkgroupName: "Talkgroup",
    talkgroupTag: "",
    talkgroupGroup: "",
    talkgroupLed: "",
    transcript: "",
    bookmarked: false,
  };
}

function params(sort: "asc" | "desc", page: number): CallSearchParams {
  return { page, limit: 2, sort };
}

function page(ids: number[], total: number): CallSearchResponse {
  return { calls: ids.map(result), total };
}

/** Put a page of results in the query cache, as if it had been fetched. */
async function seed(
  store: TestStore,
  args: CallSearchParams,
  data: CallSearchResponse,
) {
  await store.dispatch(
    callsApi.util.upsertQueryData("searchCalls", args, data),
  );
}

/**
 * Answer search requests from `pages`, keyed by page number. RTK Query
 * builds a Request from a relative URL, which Node cannot parse without a
 * base, so requests are resolved against a test origin.
 */
function serve(pages: Record<number, CallSearchResponse>) {
  const NativeRequest = globalThis.Request;
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === "string" ? new URL(input, "http://localhost") : input,
          init,
        );
      }
    },
  );
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const raw =
      input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const url = new URL(raw, "http://localhost");
    const n = Number(url.searchParams.get("page") ?? "1");
    return new Response(JSON.stringify(pages[n] ?? { calls: [], total: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

interface Props {
  isOpen: boolean;
  calls: CallSearchResult[];
  queryParams: CallSearchParams;
}

function setup(store: TestStore, initial: Props) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return renderHook((props: Props) => useSearchAutoplay(props), {
    initialProps: initial,
    wrapper,
  });
}

/** The ids passed to playNow, in order. */
function played(): number[] {
  return player.playNow.mock.calls.map(([call]) => (call as { id: number }).id);
}

/** End the most recent Call the hook started. */
function endLatest(failed = false) {
  const calls = player.playNow.mock.calls;
  const opts = calls[calls.length - 1][1] as { onEnded: OnEnded };
  act(() => opts.onEnded(failed));
}

describe("useSearchAutoplay", () => {
  let store: TestStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    serve({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes down the list, forward in time, for Oldest first", () => {
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([1, 2], 2).calls,
      queryParams: params("asc", 1),
    });
    act(() => hook.current.setEnabled(true));

    act(() => hook.current.play(result(1)));
    endLatest();

    expect(played()).toEqual([1, 2]);
  });

  it("goes up the list, forward in time, for Newest first", () => {
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([3, 2], 3).calls,
      queryParams: params("desc", 2),
    });
    act(() => hook.current.setEnabled(true));

    act(() => hook.current.play(result(2)));
    endLatest();

    expect(played()).toEqual([2, 3]);
  });

  it("plays one call and stops while autoplay is off", () => {
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([1, 2], 2).calls,
      queryParams: params("asc", 1),
    });

    act(() => hook.current.play(result(1)));
    endLatest();

    expect(played()).toEqual([1]);
  });

  it("can be switched on while a call is already playing", () => {
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([1, 2], 2).calls,
      queryParams: params("asc", 1),
    });

    act(() => hook.current.play(result(1)));
    act(() => hook.current.setEnabled(true));
    endLatest();

    expect(played()).toEqual([1, 2]);
  });

  it("stops once the panel is closed", () => {
    const initial = {
      isOpen: true,
      calls: page([1, 2], 2).calls,
      queryParams: params("asc", 1),
    };
    const { result: hook, rerender } = setup(store, initial);
    act(() => hook.current.setEnabled(true));
    act(() => hook.current.play(result(1)));

    rerender({ ...initial, isOpen: false });
    endLatest();

    expect(played()).toEqual([1]);
  });

  it("stops when the list changed under it", () => {
    // New filters or a page chosen by hand: the Call that ended is not in
    // the list any more, so there is no "next" to speak of.
    const initial = {
      isOpen: true,
      calls: page([1, 2], 2).calls,
      queryParams: params("asc", 1),
    };
    const { result: hook, rerender } = setup(store, initial);
    act(() => hook.current.setEnabled(true));
    act(() => hook.current.play(result(1)));

    rerender({ ...initial, calls: page([8, 9], 2).calls });
    endLatest();

    expect(played()).toEqual([1]);
  });

  it("stops at the newest call", async () => {
    await seed(store, params("desc", 1), page([2, 1], 2));
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([2, 1], 2).calls,
      queryParams: params("desc", 1),
    });
    act(() => hook.current.setEnabled(true));

    act(() => hook.current.play(result(2)));
    endLatest();

    expect(played()).toEqual([2]);
  });

  it("follows calls that arrived above the one playing", () => {
    // Newest first, top of page 1: a refresh shows calls that came in
    // since the page loaded, and those are what comes next.
    const initial = {
      isOpen: true,
      calls: page([3, 2], 3).calls,
      queryParams: params("desc", 1),
    };
    const { result: hook, rerender } = setup(store, initial);
    act(() => hook.current.setEnabled(true));
    act(() => hook.current.play(result(3)));

    rerender({ ...initial, calls: page([4, 3], 4).calls });
    endLatest();

    expect(played()).toEqual([3, 4]);
  });

  it("crosses to the next page for Oldest first", async () => {
    await seed(store, params("asc", 1), page([1, 2], 4));
    await seed(store, params("asc", 2), page([3, 4], 4));
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([1, 2], 4).calls,
      queryParams: params("asc", 1),
    });
    act(() => hook.current.setEnabled(true));

    act(() => hook.current.play(result(2)));
    endLatest();

    expect(played()).toEqual([2, 3]);
    expect(store.getState().calls.page).toBe(2);
  });

  it("crosses to the previous page for Newest first, to its oldest call", async () => {
    // Page 1 holds 4 and 3, page 2 holds 2 and 1. Forward in time from 2
    // is 3: the bottom of page 1.
    await seed(store, params("desc", 2), page([2, 1], 4));
    await seed(store, params("desc", 1), page([4, 3], 4));
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([2, 1], 4).calls,
      queryParams: params("desc", 2),
    });
    act(() => hook.current.setEnabled(true));

    act(() => hook.current.play(result(2)));
    endLatest();

    expect(played()).toEqual([2, 3]);
    expect(store.getState().calls.page).toBe(1);
  });

  it("warms the cache for a page crossing when an edge call starts", async () => {
    const fetchMock = serve({
      1: page([1, 2], 4),
      2: page([3, 4], 4),
    });
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([1, 2], 4).calls,
      queryParams: params("asc", 1),
    });
    act(() => hook.current.setEnabled(true));

    act(() => hook.current.play(result(2)));

    await waitFor(() =>
      expect(
        callsApi.endpoints.searchCalls.select(params("asc", 2))(store.getState())
          .data,
      ).toBeDefined(),
    );
    // This page refreshed, then the next one fetched.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches the next page when it was not ready in time", async () => {
    serve({ 2: page([3, 4], 4) });
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([1, 2], 4).calls,
      queryParams: params("asc", 1),
    });
    act(() => hook.current.play(result(2)));
    // Switched on mid-call, so nothing was prefetched when it started.
    act(() => hook.current.setEnabled(true));
    endLatest();

    await waitFor(() => expect(played()).toEqual([2, 3]));
    expect(store.getState().calls.page).toBe(2);
  });

  it("passes over a call that cannot be played", () => {
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([1, 2], 2).calls,
      queryParams: params("asc", 1),
    });
    act(() => hook.current.setEnabled(true));

    act(() => hook.current.play(result(1)));
    endLatest(true);

    expect(played()).toEqual([1, 2]);
  });

  it("gives up after several calls in a row cannot be played", () => {
    // The server is down: every Call fails at once, and carrying on would
    // race through the whole result set.
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: [1, 2, 3, 4, 5].map(result),
      queryParams: { page: 1, limit: 5, sort: "asc" },
    });
    act(() => hook.current.setEnabled(true));

    act(() => hook.current.play(result(1)));
    endLatest(true);
    endLatest(true);
    endLatest(true);

    expect(played()).toEqual([1, 2, 3]);
    expect(hook.current.enabled).toBe(false);
  });

  it("starts partway in when asked", () => {
    const { result: hook } = setup(store, {
      isOpen: true,
      calls: page([1, 2], 2).calls,
      queryParams: params("asc", 1),
    });

    act(() => hook.current.play(result(1), 3.5));

    expect(player.playNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ startAt: 3.5 }),
    );
  });
});
