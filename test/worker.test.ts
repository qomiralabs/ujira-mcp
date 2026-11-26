// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startWorker } from '../src/worker/index.js';

describe('startWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the process alive until it is stopped, and stops more than once safely', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const worker = startWorker((line) => lines.push(line));
    expect(lines).toEqual(['ready, no tasks registered']);
    expect(vi.getTimerCount()).toBe(1);

    await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
    await expect(worker.stop()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
