import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { addListener } from "@reduxjs/toolkit";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  X,
  Play,
  Pause,
  Download,
  Star,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  RotateCcw,
  RefreshCw,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { useAppSelector, useAppDispatch } from "@/app/store";
import { ShareCallButton } from "../components/ShareCallButton";
import { CallWaveform } from "./CallWaveform";
import { useSearchAutoplay } from "../hooks/useSearchAutoplay";
import { callReceived, togglePause } from "../scannerSlice";
import {
  useSearchCallsQuery,
  type CallSearchParams,
  type CallSearchResult,
  toggleSystemFilter,
  toggleTalkgroupFilter,
  toggleGroupFilter,
  toggleTagFilter,
  setSystemFilters,
  setTalkgroupFilters,
  setGroupFilters,
  setTagFilters,
  setDateFrom,
  setDateTo,
  setSort,
  setPage,
  setBookmarkedOnly,
  setTranscript,
  resetFilters,
} from "../callsSlice";
import { useGetBookmarkIDsQuery, useToggleBookmarkMutation } from "@/app/api";
import { selectToken } from "@/features/auth";
import { audioPlayer } from "@/shared/services/audio/player";
import { sanitizeDownloadFilename } from "@/shared/services/download/filename";
import { readStored, writeStored } from "@/shared/utils/storage";

interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Whether the Call playing is a live one rather than a result. */
  playingLive?: boolean;
  /** Live Calls waiting in the player's queue. */
  queuedLive?: number;
}

/**
 * How long auto-refresh waits after a new Call before fetching, so a burst
 * of Calls ending together costs one request.
 */
const AUTO_REFRESH_DELAY_MS = 1000;

/** Remembers the Auto-refresh switch in this browser. */
const AUTO_REFRESH_STORAGE_KEY = "squelch-search-auto-refresh";

/** Remembers the Waveform switch in this browser. */
const WAVEFORM_STORAGE_KEY = "squelch-search-waveform";

/** Height a result's waveform adds to its row: h-10 plus mt-1. */
const WAVEFORM_ROW_HEIGHT = 46;

function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTalkgroupLabelName(
  label?: string,
  name?: string,
  talkgroupId?: number,
): string {
  const cleanLabel = (label ?? "").trim();
  const cleanName = (name ?? "").trim();
  if (cleanLabel && cleanName && cleanLabel !== cleanName) {
    return `${cleanLabel} - ${cleanName}`;
  }
  return (
    cleanLabel ||
    cleanName ||
    (talkgroupId != null ? `TGID: ${talkgroupId}` : "(Unnamed Talkgroup)")
  );
}

type Shortcut = "toggle" | "back" | "forward";

/**
 * The panel's shortcut for a key: Space plays and pauses, Left and Right
 * skip back and forward. None where the key belongs to the control it was
 * pressed in — a text field, a dropdown, a checkbox. Buttons give up Space
 * (Enter still presses them): a click leaves focus on the button, and
 * Space would press it again. The waveform's seek slider gives up the
 * arrows, which would otherwise stop skipping after every waveform click.
 */
function shortcutFor(e: KeyboardEvent): Shortcut | null {
  if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
    return null;
  }
  const action: Shortcut | null =
    e.key === " "
      ? "toggle"
      : e.key === "ArrowLeft"
        ? "back"
        : e.key === "ArrowRight"
          ? "forward"
          : null;
  if (!action) return null;
  const el = e.target;
  if (el instanceof HTMLElement && el.isContentEditable) return null;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return null;
  }
  if (el instanceof HTMLInputElement && el.type !== "range") return null;
  return action;
}

// ── Filter section ────────────────────────────────────────────────────────────

interface FilterSectionProps {
  sectionId: string;
  label: string;
  count: number;
  isOpen: boolean;
  onToggle: (sectionId: string) => void;
  onClear: () => void;
  children: React.ReactNode;
}

function FilterSection({
  sectionId,
  label,
  count,
  isOpen,
  onToggle,
  onClear,
  children,
}: FilterSectionProps) {
  return (
    <div className="rounded border border-base-300 bg-base-100">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => onToggle(sectionId)}
          className="flex flex-1 items-center gap-2 text-left"
          aria-expanded={isOpen}
        >
          <ChevronDown
            size={14}
            className={`shrink-0 text-base-content/60 transition-transform ${
              isOpen ? "rotate-0" : "-rotate-90"
            }`}
          />
          <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
            {label}
          </span>
          {count > 0 && (
            <span className="badge badge-xs badge-primary">{count}</span>
          )}
        </button>
        {count > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-base-content/40 hover:text-error transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      {isOpen && <div className="space-y-0.5 px-3 pb-3">{children}</div>}
    </div>
  );
}

function CheckItem({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  title?: string;
}) {
  return (
    <label className="flex items-center gap-2 py-1 px-1 -mx-1 cursor-pointer rounded hover:bg-base-200 group">
      <input
        type="checkbox"
        className="checkbox checkbox-sm checkbox-primary shrink-0"
        checked={checked}
        onChange={onChange}
      />
      <span
        className="text-sm truncate text-base-content/80 group-hover:text-base-content"
        title={title}
      >
        {label}
      </span>
    </label>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SearchPanel({
  isOpen,
  onClose,
  playingLive = false,
  queuedLive = 0,
}: SearchPanelProps) {
  const dispatch = useAppDispatch();
  const filters = useAppSelector((s) => s.calls);
  const config = useAppSelector((s) => s.scanner.config);
  const token = useAppSelector(selectToken);
  // currentCall outlives playback (the display keeps showing the last Call),
  // so a row only counts as playing while audio is active. Otherwise a
  // finished Call would still take seeks the player no longer holds.
  const currentCallId = useAppSelector((s) =>
    s.scanner.isAudioActive ? s.scanner.currentCall?.id : undefined,
  );
  const currentCall = useAppSelector((s) => s.scanner.currentCall);
  const lastCallId = currentCall?.id;
  const backgroundAudio = useAppSelector((s) => s.scanner.backgroundAudio);
  const streamState = useAppSelector((s) => s.scanner.streamState);
  const isPaused = useAppSelector((s) => s.scanner.isPaused);
  const isAuthenticated = !!token;
  const shareableLinks = config?.shareableLinks ?? false;

  const { data: bookmarkData } = useGetBookmarkIDsQuery(undefined, {
    skip: !isAuthenticated,
  });
  const [toggleBookmark] = useToggleBookmarkMutation();
  const bookmarkedCallIds = bookmarkData?.callIds ?? [];
  const parentRef = useRef<HTMLDivElement>(null);
  const [openFilterSection, setOpenFilterSection] = useState<string>("");
  const [systemFilterSearch, setSystemFilterSearch] = useState("");
  const [talkgroupFilterSearch, setTalkgroupFilterSearch] = useState("");
  const [groupFilterSearch, setGroupFilterSearch] = useState("");
  const [tagFilterSearch, setTagFilterSearch] = useState("");

  const systems = useMemo(() => config?.systems ?? [], [config]);

  const allTalkgroups = useMemo(() => {
    return systems.flatMap((sys) =>
      (sys.talkgroups ?? []).map((tg) => ({
        ...tg,
        systemId: sys.id,
        systemLabel: sys.label,
      })),
    );
  }, [systems]);

  // A result names its talkgroup by radio ID within its system; the filter
  // takes the talkgroup's own ID. Radio IDs can repeat across systems.
  const talkgroupIdOf = useMemo(() => {
    const ids = new Map<string, number>();
    for (const tg of allTalkgroups) {
      const sys = systems.find((s) => s.id === tg.systemId);
      if (sys) ids.set(`${sys.systemId}:${tg.talkgroupId}`, tg.id);
    }
    return (call: CallSearchResult) =>
      ids.get(`${call.systemId}:${call.talkgroupId}`);
  }, [allTalkgroups, systems]);

  const filterRows = useMemo(
    () =>
      allTalkgroups.map((tg) => ({
        systemId: tg.systemId,
        talkgroupId: tg.id,
        group: tg.group ?? "",
        tag: tg.tag ?? "",
      })),
    [allTalkgroups],
  );

  const selectedSystemIds = filters.systemIds;
  const selectedTalkgroupIds = filters.talkgroupIds;
  const selectedGroups = filters.groupFilters;
  const selectedTags = filters.tagFilters;

  const matchWith = useCallback(
    (
      row: {
        systemId: number;
        talkgroupId: number;
        group: string;
        tag: string;
      },
      opts: {
        systemIds?: number[];
        talkgroupIds?: number[];
        groups?: string[];
        tags?: string[];
      },
    ) => {
      if (opts.systemIds && opts.systemIds.length > 0) {
        if (!opts.systemIds.includes(row.systemId)) return false;
      }
      if (opts.talkgroupIds && opts.talkgroupIds.length > 0) {
        if (!opts.talkgroupIds.includes(row.talkgroupId)) return false;
      }
      if (opts.groups && opts.groups.length > 0) {
        if (!opts.groups.includes(row.group)) return false;
      }
      if (opts.tags && opts.tags.length > 0) {
        if (!opts.tags.includes(row.tag)) return false;
      }
      return true;
    },
    [],
  );

  const availableSystemIds = useMemo(() => {
    const out = new Set<number>();
    for (const row of filterRows) {
      if (
        matchWith(row, {
          talkgroupIds: selectedTalkgroupIds,
          groups: selectedGroups,
          tags: selectedTags,
        })
      ) {
        out.add(row.systemId);
      }
    }
    return out;
  }, [
    filterRows,
    matchWith,
    selectedTalkgroupIds,
    selectedGroups,
    selectedTags,
  ]);

  const availableTalkgroupIds = useMemo(() => {
    const out = new Set<number>();
    for (const row of filterRows) {
      if (
        matchWith(row, {
          systemIds: selectedSystemIds,
          groups: selectedGroups,
          tags: selectedTags,
        })
      ) {
        out.add(row.talkgroupId);
      }
    }
    return out;
  }, [filterRows, matchWith, selectedSystemIds, selectedGroups, selectedTags]);

  const availableGroups = useMemo(() => {
    const out = new Set<string>();
    for (const row of filterRows) {
      if (
        matchWith(row, {
          systemIds: selectedSystemIds,
          talkgroupIds: selectedTalkgroupIds,
          tags: selectedTags,
        })
      ) {
        if (row.group) out.add(row.group);
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }, [
    filterRows,
    matchWith,
    selectedSystemIds,
    selectedTalkgroupIds,
    selectedTags,
  ]);

  const availableTags = useMemo(() => {
    const out = new Set<string>();
    for (const row of filterRows) {
      if (
        matchWith(row, {
          systemIds: selectedSystemIds,
          talkgroupIds: selectedTalkgroupIds,
          groups: selectedGroups,
        })
      ) {
        if (row.tag) out.add(row.tag);
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }, [
    filterRows,
    matchWith,
    selectedSystemIds,
    selectedTalkgroupIds,
    selectedGroups,
  ]);

  const availableSystems = useMemo(
    () => systems.filter((sys) => availableSystemIds.has(sys.id)),
    [systems, availableSystemIds],
  );
  const availableTalkgroups = useMemo(
    () => allTalkgroups.filter((tg) => availableTalkgroupIds.has(tg.id)),
    [allTalkgroups, availableTalkgroupIds],
  );

  const filteredSystems = useMemo(() => {
    const q = systemFilterSearch.trim().toLowerCase();
    if (!q) return availableSystems;
    return availableSystems.filter((sys) =>
      sys.label.toLowerCase().includes(q),
    );
  }, [availableSystems, systemFilterSearch]);

  const filteredTalkgroups = useMemo(() => {
    const q = talkgroupFilterSearch.trim().toLowerCase();
    if (!q) return availableTalkgroups;
    return availableTalkgroups.filter((tg) => {
      const combined = formatTalkgroupLabelName(
        tg.label,
        tg.name,
        tg.talkgroupId,
      ).toLowerCase();
      return combined.includes(q);
    });
  }, [availableTalkgroups, talkgroupFilterSearch]);

  const filteredGroups = useMemo(() => {
    const q = groupFilterSearch.trim().toLowerCase();
    if (!q) return availableGroups;
    return availableGroups.filter((g) => g.toLowerCase().includes(q));
  }, [availableGroups, groupFilterSearch]);

  const filteredTags = useMemo(() => {
    const q = tagFilterSearch.trim().toLowerCase();
    if (!q) return availableTags;
    return availableTags.filter((t) => t.toLowerCase().includes(q));
  }, [availableTags, tagFilterSearch]);

  // Keep selected filters valid when options are narrowed by other selections.
  // Until the config has arrived there are no options at all, and filters set
  // before it (a deep link from the admin) must survive that first render.
  const optionsReady = filterRows.length > 0;
  useEffect(() => {
    if (!optionsReady) return;
    const cleaned = selectedSystemIds.filter((id) =>
      availableSystemIds.has(id),
    );
    if (cleaned.length !== selectedSystemIds.length) {
      dispatch(setSystemFilters(cleaned));
    }
  }, [dispatch, optionsReady, selectedSystemIds, availableSystemIds]);

  useEffect(() => {
    if (!optionsReady) return;
    const cleaned = selectedTalkgroupIds.filter((id) =>
      availableTalkgroupIds.has(id),
    );
    if (cleaned.length !== selectedTalkgroupIds.length) {
      dispatch(setTalkgroupFilters(cleaned));
    }
  }, [dispatch, optionsReady, selectedTalkgroupIds, availableTalkgroupIds]);

  useEffect(() => {
    if (!optionsReady) return;
    const cleaned = selectedGroups.filter((g) => availableGroups.includes(g));
    if (cleaned.length !== selectedGroups.length) {
      dispatch(setGroupFilters(cleaned));
    }
  }, [dispatch, optionsReady, selectedGroups, availableGroups]);

  useEffect(() => {
    if (!optionsReady) return;
    const cleaned = selectedTags.filter((t) => availableTags.includes(t));
    if (cleaned.length !== selectedTags.length) {
      dispatch(setTagFilters(cleaned));
    }
  }, [dispatch, optionsReady, selectedTags, availableTags]);

  // Build query params
  const queryParams = useMemo(() => {
    const params: CallSearchParams = {
      systemIds: filters.systemIds,
      talkgroupIds: filters.talkgroupIds,
      groupFilters: filters.groupFilters,
      tagFilters: filters.tagFilters,
      transcript: filters.transcript,
      page: filters.page,
      limit: filters.limit,
      sort: filters.sort,
    };
    if (filters.dateFrom) {
      params.dateFrom = Math.floor(new Date(filters.dateFrom).getTime() / 1000);
    }
    if (filters.dateTo) {
      // End of day
      params.dateTo = Math.floor(
        new Date(filters.dateTo + "T23:59:59").getTime() / 1000,
      );
    }
    if (filters.bookmarkedOnly) {
      params.bookmarkedOnly = true;
    }
    return params;
  }, [filters]);

  const { data, currentData, isFetching, refetch, fulfilledTimeStamp } =
    useSearchCallsQuery(queryParams, { skip: !isOpen });
  // The overlay is for a list still to come: new filters or a page not yet
  // loaded. A refresh of the list on screen (auto-refresh, autoplay warming
  // a page crossing, the Refresh button) keeps it in view and quiet.
  const isLoading = isFetching && !currentData;

  const calls = useMemo(() => data?.calls ?? [], [data]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / filters.limit));

  const [expandedTranscripts, setExpandedTranscripts] = useState(
    () => new Set<number>(),
  );

  // Off to begin with. Each waveform downloads and decodes its Call's
  // audio, so hiding them also skips that for every row on screen.
  const [showWaveform, setShowWaveformState] = useState(
    () => readStored(localStorage, WAVEFORM_STORAGE_KEY) === "true",
  );
  const setShowWaveform = (on: boolean) => {
    setShowWaveformState(on);
    writeStored(localStorage, WAVEFORM_STORAGE_KEY, String(on));
  };

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: calls.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const call = calls[index];
      const waveform = showWaveform ? WAVEFORM_ROW_HEIGHT : 0;
      if (!call?.transcript) return 62 + waveform;
      // The fold-down's toggle line, and the transcript when it is open.
      return (expandedTranscripts.has(call.id) ? 120 : 78) + waveform;
    },
    overscan: 5,
  });

  // Count active filters
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.systemIds.length > 0) count++;
    if (filters.talkgroupIds.length > 0) count++;
    if (filters.groupFilters.length > 0) count++;
    if (filters.tagFilters.length > 0) count++;
    if (filters.dateFrom) count++;
    if (filters.dateTo) count++;
    if (filters.bookmarkedOnly) count++;
    if (filters.transcript) count++;
    if (filters.sort !== "desc") count++;
    return count;
  }, [filters]);

  const autoplay = useSearchAutoplay({ isOpen, calls, queryParams });
  const { skip, play: autoplayPlay } = autoplay;

  // Whether the transport moved playback, so the list should follow it.
  // A row played by hand is under the pointer already.
  const followCurrent = useRef(false);
  const play = useCallback(
    (call: CallSearchResult, startAt?: number) => {
      followCurrent.current = false;
      autoplayPlay(call, startAt);
    },
    [autoplayPlay],
  );

  // The current row's Play button pauses and resumes, the same toggle as
  // the scanner's transport, which the full-screen panel covers.
  const handleTogglePause = useCallback(() => {
    dispatch(togglePause());
    if (isPaused) audioPlayer.resume();
    else audioPlayer.pause();
  }, [dispatch, isPaused]);

  const handleSeek = useCallback(
    (call: CallSearchResult, seconds: number) => {
      if (call.id === currentCallId) audioPlayer.seek(seconds);
      else play(call, seconds);
    },
    [currentCallId, play],
  );

  // ── Transport ──
  // Back and Forward step through time, as autoplay does: up the list for
  // Newest first, down it for Oldest first, across pages either way.
  // They skip from the last result played here, playing or not, so they
  // still work after it ends with autoplay off, or while a live Call that
  // queued behind it plays. Otherwise from the last Call heard at all,
  // unless Stop ended it: Stop forgets the place.
  const heardId = lastCallId === autoplay.stopped ? undefined : lastCallId;
  const anchorId = autoplay.lastPlayed ?? heardId;
  const lastIndex = calls.findIndex((c) => c.id === anchorId);
  const listStep = filters.sort === "asc" ? 1 : -1;
  const canSkip = (dir: 1 | -1) => {
    if (lastIndex < 0) return false;
    const step = dir * listStep;
    if (calls[lastIndex + step]) return true;
    const neighbour = filters.page + step;
    return neighbour >= 1 && neighbour <= totalPages;
  };
  const handleSkip = (dir: 1 | -1) => {
    if (anchorId == null) return;
    followCurrent.current = true;
    skip(anchorId, dir);
  };
  // Play pauses and resumes the Call playing; otherwise it plays the last
  // Call heard again, or the top of the list.
  const handleTransportPlay = () => {
    if (currentCallId != null) {
      handleTogglePause();
      return;
    }
    const call = calls[lastIndex] ?? calls[0];
    if (!call) return;
    play(call);
    followCurrent.current = true;
  };
  const transportPlaying = currentCallId != null && !isPaused;
  // Stop ends a result, playing or paused, and hands over to the live
  // Calls waiting behind it. A live Call is the scanner's to stop.
  const canStop = currentCallId != null && !playingLive;
  const handleStop = () => {
    followCurrent.current = false;
    autoplay.stop();
  };

  // A live Call is in no row, so without a word here it plays from
  // nowhere: one that queued behind a search Call, or the server stream
  // coming back after one. Live Calls waiting their turn are counted.
  const live = !backgroundAudio
    ? currentCallId != null && playingLive
      ? "call"
      : null
    : currentCallId == null && streamState === "playing"
      ? "stream"
      : null;
  const liveTalkgroup =
    live === "call" && currentCall
      ? formatTalkgroupLabelName(
          currentCall.talkgroupLabel,
          currentCall.talkgroupName,
          currentCall.talkgroupId,
        )
      : "";
  const queued = backgroundAudio ? 0 : queuedLive;

  // The shortcuts run long after the render that registered them, so they
  // read the latest transport from here.
  const transport = useRef({ handleTransportPlay, handleSkip, canSkip });
  useEffect(() => {
    transport.current = { handleTransportPlay, handleSkip, canSkip };
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      // Browsers press a focused button on Space's keyup, so that is
      // cancelled as well as the keydown.
      e.preventDefault();
      if (e.type !== "keydown" || e.repeat) return;
      const t = transport.current;
      if (action === "toggle") t.handleTransportPlay();
      else {
        const dir = action === "forward" ? 1 : -1;
        if (t.canSkip(dir)) t.handleSkip(dir);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [isOpen]);

  // Keep the Call autoplay or the transport moved on to in view, including
  // after it crosses to another page. A skip is followed once, so a later
  // refresh of the list doesn't pull the user back to it.
  useEffect(() => {
    if (currentCallId == null) return;
    if (!autoplay.enabled && !followCurrent.current) return;
    const index = calls.findIndex((c) => c.id === currentCallId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "auto" });
    followCurrent.current = false;
  }, [autoplay.enabled, currentCallId, calls, virtualizer]);

  // ── Auto-refresh ──
  // The server sends every Call this user may hear as it is ingested,
  // whatever LIVE and the selection say, which is the set search covers.
  // Newest first past page 1, each new Call shifts every row down one, so
  // those pages wait; elsewhere new Calls only add rows.
  const [autoRefresh, setAutoRefreshState] = useState(
    () => readStored(localStorage, AUTO_REFRESH_STORAGE_KEY) === "true",
  );
  const setAutoRefresh = (on: boolean) => {
    setAutoRefreshState(on);
    writeStored(localStorage, AUTO_REFRESH_STORAGE_KEY, String(on));
  };
  const refreshable = filters.sort === "asc" || filters.page === 1;
  useEffect(() => {
    if (!isOpen || !autoRefresh || !refreshable) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = dispatch(
      addListener({
        actionCreator: callReceived,
        effect: () => {
          if (timer) return; // a refresh is already due
          timer = setTimeout(() => {
            timer = undefined;
            void refetch();
          }, AUTO_REFRESH_DELAY_MS);
        },
      }),
    );
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [dispatch, isOpen, autoRefresh, refreshable, refetch]);

  // A page cached from earlier comes back into view without the Calls that
  // arrived while it was away: while a page past 1 of Newest first waited,
  // or with search closed. Fetch it again if any did. The arrivals are
  // noted whenever auto-refresh is on, whatever is on screen.
  const lastArrival = useRef(0);
  useEffect(() => {
    if (!autoRefresh) return;
    return dispatch(
      addListener({
        actionCreator: callReceived,
        effect: () => {
          lastArrival.current = Date.now();
        },
      }),
    );
  }, [dispatch, autoRefresh]);
  useEffect(() => {
    if (!isOpen || !autoRefresh || !refreshable) return;
    if (fulfilledTimeStamp == null) return;
    if (fulfilledTimeStamp < lastArrival.current) void refetch();
  }, [isOpen, autoRefresh, refreshable, fulfilledTimeStamp, refetch]);

  // Rows that arrive above the ones being read push them down. Unless the
  // list is at the top, where new rows are the point, scroll by as much so
  // what is under the pointer stays there. Only for the same query fetched
  // again: new filters or another sort are a different list, not new rows.
  const shown = useRef<{ query: string; first?: number }>(undefined);
  useLayoutEffect(() => {
    // `data` keeps the last query's results while the next one loads.
    if (!currentData) return;
    const query = JSON.stringify(queryParams);
    const previous = shown.current;
    shown.current = { query, first: calls[0]?.id };
    const el = parentRef.current;
    if (previous?.query !== query || previous.first == null) return;
    if (!el || el.scrollTop === 0) return;
    const shift = calls.findIndex((c) => c.id === previous.first);
    if (shift <= 0) return;
    el.scrollTop += virtualizer.measurementsCache[shift]?.start ?? 0;
  }, [calls, currentData, queryParams, virtualizer]);

  const [showFilters, setShowFilters] = useState(false);

  const handleToggleSection = useCallback((sectionId: string) => {
    setOpenFilterSection((prev) => (prev === sectionId ? "" : sectionId));
  }, []);

  const handleDownload = useCallback((call: CallSearchResult) => {
    const a = document.createElement("a");
    a.href = `/api/v1/calls/${call.id}/audio`;
    a.download = sanitizeDownloadFilename(
      call.audioName,
      `call-${call.id}.mp3`,
    );
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-base-100">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 border-b border-base-300 px-4 py-3 shrink-0">
        <h2 className="text-lg font-semibold">Search Calls</h2>
        {activeFilterCount > 0 && (
          <span className="badge badge-primary badge-sm">
            {activeFilterCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {/* Mobile: toggle filter panel */}
          <button
            className="btn btn-ghost btn-sm btn-circle md:hidden"
            onClick={() => setShowFilters((v) => !v)}
            aria-label="Toggle filters"
          >
            <SlidersHorizontal
              size={16}
              className={showFilters ? "text-primary" : ""}
            />
          </button>
          <button
            className="btn btn-ghost btn-sm btn-circle"
            onClick={() => refetch()}
            aria-label="Refresh"
            disabled={isFetching}
          >
            <RefreshCw size={16} className={isFetching ? "animate-spin" : ""} />
          </button>
          <button
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* ── Body: filters sidebar + results ── */}
      <div className="flex flex-1 min-h-0 flex-col md:flex-row">
        {/* ── Filters sidebar ── */}
        <div
          className={`${
            showFilters ? "flex" : "hidden"
          } md:flex flex-col w-full md:w-80 xl:w-136 2xl:w-xl shrink-0 border-b md:border-b-0 md:border-r border-base-300 overflow-y-auto`}
        >
          <div className="p-4 space-y-5">
            {/* Transcript */}
            <div className="rounded border border-base-300 bg-base-100 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
                  Transcript
                </span>
                {filters.transcript && (
                  <button
                    type="button"
                    onClick={() => dispatch(setTranscript(undefined))}
                    className="text-xs text-base-content/40 hover:text-error transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
              <input
                type="text"
                className="input input-sm w-full"
                placeholder="Search transcripts..."
                value={filters.transcript ?? ""}
                onChange={(e) =>
                  dispatch(setTranscript(e.target.value || undefined))
                }
              />
            </div>

            {/* System */}
            <FilterSection
              sectionId="system"
              label="System"
              count={filters.systemIds.length}
              isOpen={openFilterSection === "system"}
              onToggle={handleToggleSection}
              onClear={() => dispatch(setSystemFilters([]))}
            >
              <input
                type="text"
                className="input input-xs w-full mb-2"
                placeholder="Search systems..."
                value={systemFilterSearch}
                onChange={(e) => setSystemFilterSearch(e.target.value)}
              />
              <div className="max-h-44 overflow-y-auto pr-1 space-y-0.5">
                {filteredSystems.map((sys) => (
                  <CheckItem
                    key={sys.id}
                    checked={filters.systemIds.includes(sys.id)}
                    onChange={() => dispatch(toggleSystemFilter(sys.id))}
                    label={sys.label}
                  />
                ))}
              </div>
            </FilterSection>

            {/* Talkgroup */}
            <FilterSection
              sectionId="talkgroup"
              label="Talkgroup"
              count={filters.talkgroupIds.length}
              isOpen={openFilterSection === "talkgroup"}
              onToggle={handleToggleSection}
              onClear={() => dispatch(setTalkgroupFilters([]))}
            >
              <input
                type="text"
                className="input input-xs w-full mb-2"
                placeholder="Search talkgroups..."
                value={talkgroupFilterSearch}
                onChange={(e) => setTalkgroupFilterSearch(e.target.value)}
              />
              <div className="max-h-56 overflow-y-auto pr-1 space-y-0.5">
                {filteredTalkgroups.map((tg) => (
                  <CheckItem
                    key={tg.id}
                    checked={filters.talkgroupIds.includes(tg.id)}
                    onChange={() => dispatch(toggleTalkgroupFilter(tg.id))}
                    label={formatTalkgroupLabelName(
                      tg.label,
                      tg.name,
                      tg.talkgroupId,
                    )}
                    title={formatTalkgroupLabelName(
                      tg.label,
                      tg.name,
                      tg.talkgroupId,
                    )}
                  />
                ))}
              </div>
            </FilterSection>

            {/* Group */}
            <FilterSection
              sectionId="group"
              label="Group"
              count={filters.groupFilters.length}
              isOpen={openFilterSection === "group"}
              onToggle={handleToggleSection}
              onClear={() => dispatch(setGroupFilters([]))}
            >
              <input
                type="text"
                className="input input-xs w-full mb-2"
                placeholder="Search groups..."
                value={groupFilterSearch}
                onChange={(e) => setGroupFilterSearch(e.target.value)}
              />
              <div className="max-h-44 overflow-y-auto pr-1 space-y-0.5">
                {filteredGroups.map((g) => (
                  <CheckItem
                    key={g}
                    checked={filters.groupFilters.includes(g)}
                    onChange={() => dispatch(toggleGroupFilter(g))}
                    label={g}
                  />
                ))}
              </div>
            </FilterSection>

            {/* Tag */}
            <FilterSection
              sectionId="tag"
              label="Tag"
              count={filters.tagFilters.length}
              isOpen={openFilterSection === "tag"}
              onToggle={handleToggleSection}
              onClear={() => dispatch(setTagFilters([]))}
            >
              <input
                type="text"
                className="input input-xs w-full mb-2"
                placeholder="Search tags..."
                value={tagFilterSearch}
                onChange={(e) => setTagFilterSearch(e.target.value)}
              />
              <div className="max-h-44 overflow-y-auto pr-1 space-y-0.5">
                {filteredTags.map((t) => (
                  <CheckItem
                    key={t}
                    checked={filters.tagFilters.includes(t)}
                    onChange={() => dispatch(toggleTagFilter(t))}
                    label={t}
                  />
                ))}
              </div>
            </FilterSection>

            {/* Date range */}
            <div className="rounded border border-base-300 bg-base-100 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
                  Date range
                </span>
                {(filters.dateFrom || filters.dateTo) && (
                  <button
                    type="button"
                    onClick={() => {
                      dispatch(setDateFrom(undefined));
                      dispatch(setDateTo(undefined));
                    }}
                    className="text-xs text-base-content/40 hover:text-error transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <input
                  type="date"
                  className="input input-sm w-full"
                  value={filters.dateFrom ?? ""}
                  onChange={(e) =>
                    dispatch(setDateFrom(e.target.value || undefined))
                  }
                />
                <input
                  type="date"
                  className="input input-sm w-full"
                  value={filters.dateTo ?? ""}
                  onChange={(e) =>
                    dispatch(setDateTo(e.target.value || undefined))
                  }
                />
              </div>
            </div>

            {/* Sort */}
            <div className="rounded border border-base-300 bg-base-100 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
                  Sort
                </span>
                {filters.sort !== "desc" && (
                  <button
                    type="button"
                    onClick={() => dispatch(setSort("desc"))}
                    className="text-xs text-base-content/40 hover:text-error transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
              <select
                className="select select-sm w-full"
                value={filters.sort}
                onChange={(e) =>
                  dispatch(setSort(e.target.value as "asc" | "desc"))
                }
              >
                <option value="desc">Newest first</option>
                <option value="asc">Oldest first</option>
              </select>
            </div>

            {/* Bookmarked only */}
            {isAuthenticated && (
              <div className="rounded border border-base-300 bg-base-100 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
                    Bookmarks
                  </span>
                  {filters.bookmarkedOnly && (
                    <button
                      type="button"
                      onClick={() => dispatch(setBookmarkedOnly(false))}
                      className="text-xs text-base-content/40 hover:text-error transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="toggle toggle-sm toggle-primary"
                    checked={filters.bookmarkedOnly}
                    onChange={(e) =>
                      dispatch(setBookmarkedOnly(e.target.checked))
                    }
                  />
                  <span className="text-sm">Bookmarked only</span>
                </label>
              </div>
            )}

            {/* Reset */}
            <button
              className="btn btn-ghost btn-sm w-full justify-start gap-2"
              onClick={() => dispatch(resetFilters())}
            >
              <RotateCcw size={14} />
              Reset filters
            </button>

            {/* Mobile: back to results */}
            <button
              className="btn btn-primary btn-sm w-full md:hidden"
              onClick={() => setShowFilters(false)}
            >
              Show results
            </button>
          </div>
        </div>

        {/* ── Results ── */}
        <div
          className={`${
            !showFilters ? "flex" : "hidden"
          } md:flex flex-1 flex-col min-h-0`}
        >
          {/* Paginator, transport, switches. Laid out by the width of this
              column, which the sidebar beside it varies: the transport has
              the middle of the bar only where the switches and the live
              indicator fit beside it, and a row of its own otherwise. */}
          <div className="@container shrink-0 border-b border-base-300">
            <div className="grid grid-cols-2 items-center gap-x-3 gap-y-2 px-4 py-2 @6xl:grid-cols-[1fr_auto_1fr]">
              <div className="join justify-self-start">
                <button
                  className="join-item btn btn-sm"
                  disabled={filters.page <= 1}
                  onClick={() => dispatch(setPage(filters.page - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={14} />
                  <span className="hidden @md:inline">Prev</span>
                </button>
                <button className="join-item btn btn-sm btn-disabled pointer-events-none">
                  Page {filters.page} of {totalPages}
                </button>
                <button
                  className="join-item btn btn-sm"
                  disabled={filters.page >= totalPages}
                  onClick={() => dispatch(setPage(filters.page + 1))}
                  aria-label="Next page"
                >
                  <span className="hidden @md:inline">Next</span>
                  <ChevronRight size={14} />
                </button>
              </div>
              <div
                role="group"
                aria-label="Playback"
                className="relative col-span-2 row-start-2 flex items-center gap-1 justify-self-center @6xl:col-span-1 @6xl:col-start-2 @6xl:row-start-1"
              >
                <button
                  className="btn btn-ghost btn-sm btn-circle"
                  disabled={!canSkip(-1)}
                  onClick={() => handleSkip(-1)}
                  aria-label="Previous call"
                  aria-keyshortcuts="ArrowLeft"
                  title="The call before this one (←)"
                >
                  <SkipBack size={16} />
                </button>
                <button
                  className="btn btn-primary btn-sm btn-circle"
                  disabled={currentCallId == null && calls.length === 0}
                  onClick={handleTransportPlay}
                  aria-label={transportPlaying ? "Pause" : "Play"}
                  aria-keyshortcuts="Space"
                  title={`${transportPlaying ? "Pause" : "Play"} (Space)`}
                >
                  {transportPlaying ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <button
                  className="btn btn-ghost btn-sm btn-circle"
                  disabled={!canStop}
                  onClick={handleStop}
                  aria-label="Stop"
                  title="Stop, and go on to the live calls waiting"
                >
                  <Square size={14} />
                </button>
                <button
                  className="btn btn-ghost btn-sm btn-circle"
                  disabled={!canSkip(1)}
                  onClick={() => handleSkip(1)}
                  aria-label="Next call"
                  aria-keyshortcuts="ArrowRight"
                  title="The call after this one (→)"
                >
                  <SkipForward size={16} />
                </button>
                {/* Beside the transport without moving it: it stays put
                    under the pointer as the indicator comes and goes. */}
                <div
                  role="status"
                  className="absolute left-full top-1/2 ml-3 flex -translate-y-1/2 flex-col whitespace-nowrap text-[11px] font-medium leading-tight"
                >
                  {live && (
                    <span
                      className="flex max-w-32 items-center gap-1 text-error"
                      title={
                        live === "call"
                          ? `A live call is playing: ${liveTalkgroup}`
                          : "The live stream is playing"
                      }
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full bg-error ${
                          isPaused ? "" : "animate-pulse"
                        }`}
                        aria-hidden="true"
                      />
                      <span className="truncate">
                        {live === "call" ? `Live: ${liveTalkgroup}` : "Live stream"}
                      </span>
                    </span>
                  )}
                  {queued > 0 && (
                    <span
                      className="text-warning"
                      title="Live calls play once search playback stops"
                    >
                      {queued} live queued
                    </span>
                  )}
                </div>
              </div>
              <div className="col-start-2 row-start-1 flex items-center gap-3 justify-self-end @6xl:col-start-3">
                {total > 0 && (
                  <span className="hidden text-xs text-base-content/40 @xl:inline">
                    {total.toLocaleString()} calls
                  </span>
                )}
                {/* Stacked where the bar is narrow, side by side otherwise. */}
                <div className="flex flex-col items-end gap-1 @2xl:flex-row @2xl:items-center @2xl:gap-3">
                  <label
                    className="flex cursor-pointer items-center gap-2"
                    title="Show each call's waveform, to play it from any point"
                  >
                    <span className="text-xs text-base-content/60">Waveform</span>
                    <input
                      type="checkbox"
                      className="toggle toggle-sm toggle-primary"
                      checked={showWaveform}
                      onChange={(e) => setShowWaveform(e.target.checked)}
                    />
                  </label>
                  <label
                    className="flex cursor-pointer items-center gap-2"
                    title={
                      autoRefresh && !refreshable
                        ? "Waiting: past page 1 of Newest first, each new call would shift every row"
                        : "Fetch the results again as new calls are recorded"
                    }
                  >
                    <span
                      className={`text-xs ${
                        autoRefresh && !refreshable
                          ? "text-warning"
                          : "text-base-content/60"
                      }`}
                    >
                      Auto-refresh
                    </span>
                    <input
                      type="checkbox"
                      className="toggle toggle-sm toggle-primary"
                      checked={autoRefresh}
                      onChange={(e) => setAutoRefresh(e.target.checked)}
                    />
                  </label>
                  <label
                    className="flex cursor-pointer items-center gap-2"
                    title="When a call ends, play the next one forward in time"
                  >
                    <span className="text-xs text-base-content/60">Autoplay</span>
                    <input
                      type="checkbox"
                      className="toggle toggle-sm toggle-primary"
                      checked={autoplay.enabled}
                      onChange={(e) => autoplay.setEnabled(e.target.checked)}
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>

          {/* Results list */}
          <div ref={parentRef} className="relative flex-1 overflow-y-auto">
            {isLoading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-base-100/60">
                <span className="loading loading-spinner loading-md" />
              </div>
            )}

            {calls.length === 0 && !isFetching && (
              <div className="flex h-32 items-center justify-center text-base-content/50">
                No results
              </div>
            )}

            <div
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const call = calls[virtualRow.index];
                const isCurrent = call.id === currentCallId;
                const tgFilterId = talkgroupIdOf(call);
                const onlyThisTalkgroup =
                  tgFilterId != null &&
                  filters.talkgroupIds.length === 1 &&
                  filters.talkgroupIds[0] === tgFilterId;
                return (
                  <div
                    key={call.id}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    aria-current={isCurrent ? "true" : undefined}
                    className={`absolute left-0 flex w-full items-start gap-2 border-b border-l-2 border-b-base-300 px-3 py-2 hover:bg-base-200 overflow-hidden ${
                      isCurrent
                        ? "border-l-primary bg-base-200"
                        : "border-l-transparent"
                    }`}
                    style={{ top: virtualRow.start }}
                  >
                    {/* Call details */}
                    <div className="min-w-0 flex-1">
                      {/* Row 1: talkgroup name, and narrowing the search to
                          it. Only the search filters change: the live
                          scanner's talkgroup selection is its own. */}
                      <div className="flex min-w-0 items-center gap-1">
                        <span className="text-xs font-medium truncate">
                          {formatTalkgroupLabelName(
                            call.talkgroupLabel,
                            call.talkgroupName,
                            call.talkgroupId,
                          )}
                        </span>
                        {tgFilterId != null && (
                          <button
                            type="button"
                            onClick={() =>
                              dispatch(
                                setTalkgroupFilters(
                                  onlyThisTalkgroup ? [] : [tgFilterId],
                                ),
                              )
                            }
                            className={`btn btn-ghost btn-square h-4 min-h-0 w-4 shrink-0 p-0 ${
                              onlyThisTalkgroup
                                ? "text-primary"
                                : "text-base-content/40 hover:text-base-content"
                            }`}
                            aria-label="Only this talkgroup"
                            aria-pressed={onlyThisTalkgroup}
                            title={
                              onlyThisTalkgroup
                                ? "Show every talkgroup again"
                                : "Search only this talkgroup"
                            }
                          >
                            <ListFilter size={12} />
                          </button>
                        )}
                      </div>
                      {/* Row 2: system */}
                      <div className="text-[11px] text-base-content/60 truncate">
                        {call.systemLabel}
                      </div>
                      {/* Row 3: freq, UID, TGID */}
                      <div className="flex items-center gap-2 text-[11px] text-base-content/40">
                        {call.frequency > 0 && (
                          <span>{(call.frequency / 1e6).toFixed(4)} MHz</span>
                        )}
                        {call.source > 0 && <span>UID: {call.source}</span>}
                        {call.talkerAlias && <span>{call.talkerAlias}</span>}
                        {call.talkgroupId > 0 && (
                          <span>TGID: {call.talkgroupId}</span>
                        )}
                        {call.errorCount != null && call.errorCount > 0 && (
                          <span>E:{call.errorCount}</span>
                        )}
                        {call.spikeCount != null && call.spikeCount > 0 && (
                          <span>S:{call.spikeCount}</span>
                        )}
                      </div>
                      {/* Row 4: transcript fold-down */}
                      {call.transcript && (
                        <button
                          type="button"
                          className="flex items-center gap-1 text-[10px] text-base-content/50 hover:text-base-content/70 mt-0.5"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedTranscripts((prev) => {
                              const next = new Set(prev);
                              if (next.has(call.id)) next.delete(call.id);
                              else next.add(call.id);
                              return next;
                            });
                          }}
                        >
                          <ChevronDown
                            size={12}
                            className={`transition-transform ${
                              expandedTranscripts.has(call.id)
                                ? "rotate-180"
                                : ""
                            }`}
                          />
                          Transcription
                        </button>
                      )}
                      {call.transcript && expandedTranscripts.has(call.id) && (
                        <div className="text-[11px] italic text-base-content/60 whitespace-pre-wrap mt-0.5">
                          {call.transcript}
                        </div>
                      )}
                      {showWaveform && (
                        <CallWaveform
                          callId={call.id}
                          isCurrent={isCurrent}
                          onSeek={(seconds) => handleSeek(call, seconds)}
                        />
                      )}
                    </div>
                    {/* Date/time + action buttons */}
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      <span className="text-[11px] text-base-content/60">
                        {formatDate(call.dateTime)} {formatTime(call.dateTime)}
                      </span>
                      {call.duration > 0 && (
                        <span className="text-[11px] text-base-content/40">
                          {formatDuration(call.duration)}
                        </span>
                      )}
                      <div className="flex items-center gap-0.5">
                        {isCurrent ? (
                          <button
                            onClick={handleTogglePause}
                            className="btn btn-ghost btn-xs btn-square text-primary"
                            aria-label={isPaused ? "Resume call" : "Pause call"}
                          >
                            {isPaused ? (
                              <Play className="w-3 h-3" />
                            ) : (
                              <Pause className="w-3 h-3" />
                            )}
                          </button>
                        ) : (
                          <button
                            onClick={() => play(call)}
                            className="btn btn-ghost btn-xs btn-square"
                            aria-label="Play call"
                          >
                            <Play className="w-3 h-3" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDownload(call);
                          }}
                          className="btn btn-ghost btn-xs btn-square"
                          aria-label="Download call"
                        >
                          <Download className="w-3 h-3" />
                        </button>
                        {isAuthenticated && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void toggleBookmark(call.id);
                            }}
                            className={`btn btn-ghost btn-xs btn-square ${
                              bookmarkedCallIds.includes(call.id)
                                ? "text-warning"
                                : ""
                            }`}
                            aria-label="Toggle bookmark"
                          >
                            <Star
                              className={`w-3 h-3 ${
                                bookmarkedCallIds.includes(call.id)
                                  ? "fill-current"
                                  : ""
                              }`}
                            />
                          </button>
                        )}
                        {isAuthenticated && shareableLinks && (
                          <ShareCallButton callId={call.id} />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
