// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { errorMessage } from '../lib/api';

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: string | null;
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
  const [state, setState] = useState<{ key: string | null; data?: T; error: string | null }>({
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
        if (live) setState((s) => ({ ...s, key, error: errorMessage(error) }));
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

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
  };
}

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'new' }
  | { readonly name: 'mandate'; readonly id: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const m = /^\/m\/([A-Z0-9]{56})\/?$/.exec(path);
  if (m?.[1] !== undefined) return { name: 'mandate', id: m[1] };
  if (path === '/new') return { name: 'new' };
  return { name: 'home' };
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  return parseRoute(hash);
}

export function go(path: string): void {
  location.hash = path;
  window.scrollTo({ top: 0 });
}
