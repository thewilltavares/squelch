import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "react-redux";
import { useAppDispatch, type RootState } from "@/app/store";
import { audioPlayer } from "@/shared/services/audio/player";
import { readStored, writeStored } from "@/shared/utils/storage";
import {
  callsApi,
  setPage,
  type CallSearchParams,
  type CallSearchResponse,
  type CallSearchResult,
} from "../callsSlice";
import { setPaused } from "../scannerSlice";
import type { Call } from "../types";

/** Consecutive unplayable Calls before autoplay gives up (server down). */
const MAX_FAILURES = 3;

/** Remembers the Autoplay switch in this browser. */
const STORAGE_KEY = "squelch-search-autoplay";

interface UseSearchAutoplayArgs {
  isOpen: boolean;
  /** The page of results on screen. */
  calls: CallSearchResult[];
  /** The query that produced `calls`, including page, limit and sort. */
  queryParams: CallSearchParams;
}

/** A search result in the shape the player takes. */
export function toPlayableCall(call: CallSearchResult): Call {
  return {
    id: call.id,
    audioName: call.audioName || `call-${call.id}`,
    audioType: call.audioType || "audio/mpeg",
    dateTime: call.dateTime,
    systemId: call.systemId,
    system: call.systemId,
    talkgroupId: call.talkgroupId,
    talkgroup: call.talkgroupId,
    frequency: call.frequency,
    duration: call.duration,
    source: call.source,
    site: call.site,
    channel: call.channel,
    decoder: call.decoder,
    errorCount: call.errorCount,
    spikeCount: call.spikeCount,
    talkerAlias: call.talkerAlias,
    systemLabel: call.systemLabel,
    talkgroupLabel: call.talkgroupLabel,
    talkgroupName: call.talkgroupName,
    talkgroupTag: call.talkgroupTag,
    talkgroupGroup: call.talkgroupGroup,
    transcript: call.transcript,
  };
}

/**
 * Plays search results, and with autoplay on keeps going: each Call that
 * ends starts the next one *forward in time*, across pages.
 *
 * Forward in time is up the list for Newest first and down it for Oldest
 * first, so the step through the results, and the neighbouring page, both
 * follow the sort. Autoplay stops at the newest matching Call, when it is
 * switched off, when the panel closes, when the list changes under it
 * (new filters, a page chosen by hand), or after a run of Calls that
 * cannot be played.
 *
 * Pages are offset-based, so Calls that arrive while listening shift every
 * page down. When an edge row starts, this page is refreshed and the
 * neighbouring page fetched, so crossing over is instant and nothing is
 * skipped. The continuation runs synchronously while the cache is warm,
 * which keeps live Calls waiting in the player's queue instead of slipping
 * in between two results.
 *
 * `skip` moves one Call forward or back in time by hand, crossing pages
 * the same way, with autoplay on or off.
 */
export function useSearchAutoplay({
  isOpen,
  calls,
  queryParams,
}: UseSearchAutoplayArgs) {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const [enabled, setEnabledState] = useState(
    () => readStored(localStorage, STORAGE_KEY) === "true",
  );
  // Remembered, including autoplay giving up after a run of failures: a
  // reload then starts with it off rather than racing a server still down.
  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    writeStored(localStorage, STORAGE_KEY, String(on));
  }, []);
  // The last result started here. A live Call that plays after it is not
  // in the list, so skipping goes on from this one.
  const [lastPlayed, setLastPlayed] = useState<number>();

  // The continuation runs long after the render that started the Call, so
  // it reads the latest list and settings from here.
  const latest = useRef({ enabled, isOpen, calls, queryParams });
  useEffect(() => {
    latest.current = { enabled, isOpen, calls, queryParams };
  });

  // Consecutive Calls that could not be played.
  const failures = useRef(0);

  const engine = useMemo(() => {
    const stepOf = (params: CallSearchParams) =>
      params.sort === "asc" ? 1 : -1;
    const pageOf = (params: CallSearchParams) => params.page ?? 1;
    const lastPage = (data: CallSearchResponse, params: CallSearchParams) =>
      Math.max(1, Math.ceil(data.total / (params.limit ?? 25)));
    const cached = (params: CallSearchParams) =>
      callsApi.endpoints.searchCalls.select(params)(store.getState()).data;
    const fetchPage = (params: CallSearchParams, forceRefetch = false) =>
      dispatch(
        callsApi.endpoints.searchCalls.initiate(params, {
          subscribe: false,
          forceRefetch,
        }),
      );
    // The Call on the neighbouring page that comes next in the step's
    // direction: its last row going up the list, its first going down.
    const entryOf = (data: CallSearchResponse, step: number) =>
      step < 0 ? data.calls[data.calls.length - 1] : data.calls[0];

    function start(result: CallSearchResult, startAt?: number) {
      audioPlayer.playNow(toPlayableCall(result), {
        startAt,
        onEnded: (failed) => continueFrom(result.id, failed),
      });
      setLastPlayed(result.id);
      // Playing a Call is the opposite of paused. playNow plays regardless,
      // so a pause left over from an earlier Call would otherwise stay on,
      // and every row would offer Resume for audio that is playing.
      if (store.getState().scanner.isPaused) {
        dispatch(setPaused(false));
        audioPlayer.resume();
      }
      prepareEdge(result.id);
    }

    /** Warm the cache for a page crossing, if this Call is at the edge. */
    function prepareEdge(id: number) {
      const { enabled, calls, queryParams } = latest.current;
      if (!enabled) return;
      const step = stepOf(queryParams);
      const index = calls.findIndex((c) => c.id === id);
      const atEdge = step < 0 ? index === 0 : index === calls.length - 1;
      if (index < 0 || !atEdge) return;

      // Refreshing this page also refreshes the list on screen: Calls that
      // arrived since it loaded show up, and may come before the next page.
      void fetchPage(queryParams, true).then(({ data }) => {
        if (!data) return;
        const neighbour = pageOf(queryParams) + step;
        if (neighbour < 1 || neighbour > lastPage(data, queryParams)) return;
        void fetchPage({ ...queryParams, page: neighbour });
      });
    }

    function continueFrom(id: number, failed: boolean) {
      const { enabled, isOpen } = latest.current;
      if (!enabled || !isOpen) {
        failures.current = 0;
        return;
      }
      failures.current = failed ? failures.current + 1 : 0;
      if (failures.current >= MAX_FAILURES) {
        failures.current = 0;
        setEnabled(false);
        return;
      }
      advance(id, 1, () => latest.current.enabled && latest.current.isOpen);
    }

    /**
     * Start the Call one step in time from `id`: `dir` 1 is forward, -1
     * back. `stillWanted` is asked again if a page has to be fetched first.
     */
    function advance(id: number, dir: 1 | -1, stillWanted: () => boolean) {
      const { calls, queryParams } = latest.current;
      // The step through the list, and to the neighbouring page.
      const step = dir * stepOf(queryParams);
      const index = calls.findIndex((c) => c.id === id);
      // Not on screen any more: the user changed the list. Stop there.
      if (index < 0) return;
      const next = calls[index + step];
      if (next) {
        start(next);
        return;
      }

      const page = pageOf(queryParams);
      const neighbour = page + step;
      const current = cached(queryParams);
      if (neighbour < 1) return; // the first page: nothing above it
      if (current && neighbour > lastPage(current, queryParams)) return;

      const params = { ...queryParams, page: neighbour };
      const warm = cached(params);
      if (warm) {
        const entry = entryOf(warm, step);
        if (!entry) return;
        dispatch(setPage(neighbour));
        start(entry);
        return;
      }

      // Not prefetched — a very short Call, a slow network, or a skip
      // back. Fetch and carry on, unless the user has moved on meanwhile.
      void fetchPage(params).then(({ data }) => {
        if (!stillWanted() || pageOf(latest.current.queryParams) !== page) {
          return;
        }
        const entry = data && entryOf(data, step);
        if (!entry) return;
        dispatch(setPage(neighbour));
        start(entry);
      });
    }

    return {
      /** Play a result the user chose; autoplay continues from it. */
      play(result: CallSearchResult, startAt?: number) {
        failures.current = 0;
        start(result, startAt);
      },
      /**
       * Skip from the Call `id` to the one after it in time (`dir` 1) or
       * before it (-1), whether or not autoplay is on.
       */
      skip(id: number, dir: 1 | -1) {
        failures.current = 0;
        advance(id, dir, () => latest.current.isOpen);
      },
    };
  }, [dispatch, store, setEnabled]);

  return {
    enabled,
    setEnabled,
    lastPlayed,
    play: engine.play,
    skip: engine.skip,
  };
}
