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

/** Moves to a dashboard path such as "/mandates" without reloading the page. */
export function go(path: string): void {
  const href = hrefFor(path);
  if (`${location.pathname}${location.search}` !== href) history.pushState(null, '', href);
  window.dispatchEvent(new Event(NAVIGATED));
  window.scrollTo({ top: 0 });
}
