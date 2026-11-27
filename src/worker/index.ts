// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The worker role. It has no tasks yet: it starts, keeps the process alive
// and stops on request, so the image, the role switch and the shutdown order
// can run in production before the job runner replaces this body. It never
// listens on a port.

export interface Worker {
  /** Takes no new jobs, hands back the ones in flight, and resolves when done. */
  stop(): Promise<void>;
}

/** Long, since the timer only keeps the event loop alive; it does no work. */
const KEEP_ALIVE_MS = 60 * 60 * 1000;

export function startWorker(log: (line: string) => void): Worker {
  const alive = setInterval(() => undefined, KEEP_ALIVE_MS);
  log('ready, no tasks registered');
  let stopped = false;
  return {
    stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(alive);
      }
      return Promise.resolve();
    },
  };
}
