// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { errorMessage, errorRequestId } from '../lib/api';
import { hrefFor, parsePath, type Route } from './routes';

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: string | null;
  /** The server's id for the failed request, when it gave one. */
  readonly errorRequestId: string | null;
  readonly loading: boolean;
  /** Fetches again; the last good data stays on screen meanwhile. */
  reload: () => void;
}

/**
 * Loads data for a view and keeps it fresh. `key` names what is loaded; when
 * it changes the old data is dropped. With `pollMs` the view refreshes on a
 * timer while the tab is visible.
 */
export function useResource<T>(
  key: string | null,
  load: () => Promise<T>,
  pollMs?: number,
): Resource<T> {
  const [state, setState] = useState<{
    key: string | null;
    data?: T;
    error: string | null;
    errorRequestId?: string | null;
  }>({
    key,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  if (state.key !== key) setState({ key, error: null });

  useEffect(() => {
    if (key === null) return;
    let live = true;
    loadRef.current().then(
      (data) => {
        if (live) setState({ key, data, error: null });
      },
      (error: unknown) => {
        if (live) {
          setState((s) => ({
            ...s,
            key,
            error: errorMessage(error),
            errorRequestId: errorRequestId(error),
          }));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [key, tick]);

  useEffect(() => {
    if (key === null || pollMs === undefined) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, pollMs);
    return () => {
      clearInterval(id);
    };
  }, [key, pollMs]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : null,
    errorRequestId: current && state.error !== null ? (state.errorRequestId ?? null) : null,
    loading: key !== null && (!current || (state.data === undefined && state.error === null)),
    reload,
  };
}

export interface AllPages<T> {
  /** Every row read so far; grows page by page on the first load. */
  readonly items: readonly T[] | undefined;
  /** True once the last page is in. */
  readonly complete: boolean;
  /** True when the list stopped at the cap with more on the server. */
  readonly truncated: boolean;
  readonly error: string | null;
  readonly errorRequestId: string | null;
  readonly loading: boolean;
  reload: () => void;
}

interface AllPagesState<T> {
  readonly key: string | null;
  readonly items?: readonly T[];
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly errorRequestId: string | null;
}

/**
 * Reads a cursor paged list to the end, up to `cap` rows, for views that sort
 * or export the whole set. The first load shows rows as each page lands; a
 * refresh keeps the old rows on screen until the new set is complete. With
 * `pollMs` it refreshes while the tab is visible, unless the set is larger
 * than `pollUpTo` rows.
 */
export function useAllPages<T extends { readonly id: string }>(
  key: string | null,
  loadPage: (cursor: string | undefined) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor: string | null;
  }>,
  { cap, pollMs, pollUpTo = Infinity }: { cap: number; pollMs?: number; pollUpTo?: number },
): AllPages<T> {
  const empty = (k: string | null): AllPagesState<T> => ({
    key: k,
    complete: false,
    truncated: false,
    error: null,
    errorRequestId: null,
  });
  const [state, setState] = useState<AllPagesState<T>>(() => empty(key));
  const [tick, setTick] = useState(0);
  const loadRef = useRef(loadPage);
  useEffect(() => {
    loadRef.current = loadPage;
  });

  if (state.key !== key) setState(empty(key));

  useEffect(() => {
    if (key === null) return;
    let live = true;
    const run = async () => {
      const seen = new Set<string>();
      let rows: T[] = [];
      let cursor: string | undefined;
      let truncated = false;
      for (;;) {
        const page = await loadRef.current(cursor);
        if (!live) return;
        for (const item of page.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          rows.push(item);
        }
        cursor = page.nextCursor ?? undefined;
        if (rows.length >= cap) {
          truncated = rows.length > cap || cursor !== undefined;
          rows = rows.slice(0, cap);
          break;
        }
        if (cursor === undefined) break;
        // Only the first load grows on screen; a refresh swaps in at the end.
        const shown = [...rows];
        setState((s) =>
          s.key === key && !s.complete
            ? { ...s, items: shown, error: null, errorRequestId: null }
            : s,
        );
      }
      setState({ key, items: rows, complete: true, truncated, error: null, errorRequestId: null });
    };
    run().catch((error: unknown) => {
      if (live) {
        setState((s) => ({
          ...s,
          key,
          error: errorMessage(error),
          errorRequestId: errorRequestId(error),
        }));
      }
    });
    return () => {
      live = false;
    };
  }, [key, tick]);

  const current = state.key === key;
  const size = current ? (state.items?.length ?? 0) : 0;
  const polls = pollMs !== undefined && current && state.complete && size <= pollUpTo;
  useEffect(() => {
    if (key === null || !polls) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, pollMs);
    return () => {
      clearInterval(id);
    };
  }, [key, polls, pollMs]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  return {
    items: current ? state.items : undefined,
    complete: current && state.complete,
    truncated: current && state.truncated,
    error: current ? state.error : null,
    errorRequestId: current ? state.errorRequestId : null,
    loading: key !== null && (!current || (state.items === undefined && state.error === null)),
    reload,
  };
}

export interface Action<A extends unknown[]> {
  readonly busy: boolean;
  readonly error: string | null;
  run: (...args: A) => Promise<void>;
  clear: () => void;
}

/** Runs one async action at a time and keeps its error as a sentence. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<void>): Action<A> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const busyRef = useRef(false);
  const run = useCallback(async (...args: A) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await fnRef.current(...args);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);
  const clear = useCallback(() => {
    setError(null);
  }, []);
  return { busy, error, run, clear };
}

const NAVIGATED = 'ujira:navigated';

function subscribeLocation(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATED, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATED, onChange);
  };
}

/** The current page, read from the address bar and kept in step with it. */
export function useRoute(): Route {
  const path = useSyncExternalStore(subscribeLocation, () => location.pathname);
  return useMemo(() => parsePath(path), [path]);
}

/** The query string of the address bar, kept in step with it. */
export function useSearch(): string {
  return useSyncExternalStore(subscribeLocation, () => location.search);
}

/**
 * Swaps the query string in place, for state a page keeps in its URL such as
 * filters. It adds no history entry and leaves the scroll where it is.
 */
export function replaceSearch(search: string): void {
  if (search === location.search || (search === '' && location.search === '?')) return;
  history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`);
  window.dispatchEvent(new Event(NAVIGATED));
}

/** Moves to a dashboard path such as "/mandates" without reloading the page. */
export function go(path: string): void {
  const href = hrefFor(path);
  if (`${location.pathname}${location.search}` !== href) history.pushState(null, '', href);
  window.dispatchEvent(new Event(NAVIGATED));
  window.scrollTo({ top: 0 });
}
