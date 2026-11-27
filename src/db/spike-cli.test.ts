// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The arithmetic and the argument handling of the database spike. No
// database is reached here; spike-run.test.ts runs it against one.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SAMPLES,
  formatSummary,
  main,
  parseSamples,
  percentile,
  summarise,
} from './spike-cli.js';

describe('percentile', () => {
  it('takes the nearest rank, never an interpolated value', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile(sorted, 10)).toBe(1);
  });

  it('handles one sample', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
  });

  it('refuses an empty list or a rank outside (0, 100]', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe('summarise', () => {
  it('sorts a copy and leaves the samples as they were', () => {
    const samples = [9, 1, 5, 3, 7];
    expect(summarise(samples)).toEqual({ n: 5, p50: 5, p95: 9, max: 9 });
    expect(samples).toEqual([9, 1, 5, 3, 7]);
  });

  it('prints milliseconds to two places', () => {
    expect(formatSummary({ n: 3, p50: 1.234, p95: 2, max: 10.5 })).toBe(
      'p50=1.23ms p95=2.00ms max=10.50ms n=3',
    );
  });
});

describe('parseSamples', () => {
  it('defaults when no flag is given', () => {
    expect(parseSamples([])).toBe(DEFAULT_SAMPLES);
  });

  it('reads --samples N', () => {
    expect(parseSamples(['--samples', '50'])).toBe(50);
  });

  it.each([
    [['--samples']],
    [['--samples', '0']],
    [['--samples', '1.5']],
    [['--samples', '-3']],
    [['--samples', '100000']],
    [['--count', '5']],
    [['--samples', '5', 'extra']],
  ])('refuses %j', (argv) => {
    expect(typeof parseSamples(argv)).toBe('string');
  });
});

describe('main', () => {
  it('refuses bad arguments before reading any configuration', async () => {
    const errors: string[] = [];
    const code = await main(
      ['--samples', 'many'],
      {},
      { out: () => undefined, err: (line) => errors.push(line) },
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('sample count');
  });

  it('reports a configuration error by variable, never by value', async () => {
    const errors: string[] = [];
    const code = await main(
      [],
      {
        UJIRA_DB_APP_URL: 'postgresql://ujira_app:hunter2@db.example:6432/ujira',
        UJIRA_DB_WORKER_URL: 'postgresql://ujira_worker:hunter2@db.example:6432/ujira',
        UJIRA_DB_MIGRATOR_URL: 'postgresql://ujira_migrator:hunter2@db.example:5432/ujira',
      },
      { out: () => undefined, err: (line) => errors.push(line) },
    );
    expect(code).toBe(1);
    const printed = errors.join('\n');
    expect(printed).toContain('UJIRA_DB_WORKER_URL must not use the transaction pooler port 6432');
    expect(printed).not.toContain('hunter2');
    expect(printed).not.toContain('db.example');
  });
});
