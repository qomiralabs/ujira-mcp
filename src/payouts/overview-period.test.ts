// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Where a period's edges fall, in zones that make it hard: whole hour and
// fractional offsets, a day either side of the date line, clocks that change
// mid week, and a zone that skips midnight itself.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PERIOD_DAYS,
  instantOfWall,
  isKnownTimeZone,
  MAX_PERIOD_DAYS,
  PeriodError,
  resolvePeriod,
  shiftLocalDays,
  startOfLocalDay,
  wallClock,
} from './overview-period.js';

const at = (iso: string) => new Date(iso);
const iso = (instant: number) => new Date(instant).toISOString();

function edges(timeZone: string, now: string) {
  const period = resolvePeriod({}, timeZone, at(now));
  return [period.from.toISOString(), period.to.toISOString(), period.timeZone];
}

describe('the default period', () => {
  it('is the last seven local days, today included', () => {
    expect(DEFAULT_PERIOD_DAYS).toBe(7);
    expect(edges('UTC', '2026-11-27T10:00:00.000Z')).toEqual([
      '2026-11-21T00:00:00.000Z',
      '2026-11-28T00:00:00.000Z',
      'UTC',
    ]);
  });

  it("places the edges at the principal's midnight", () => {
    expect(edges('Africa/Lagos', '2026-11-27T10:00:00.000Z')).toEqual([
      '2026-11-20T23:00:00.000Z',
      '2026-11-27T23:00:00.000Z',
      'Africa/Lagos',
    ]);
    expect(edges('Asia/Kathmandu', '2026-11-27T10:00:00.000Z')).toEqual([
      '2026-11-20T18:15:00.000Z',
      '2026-11-27T18:15:00.000Z',
      'Asia/Kathmandu',
    ]);
  });

  it('counts today by the local calendar, which may already be tomorrow in UTC', () => {
    // 10:00 UTC is already midnight of the 28th in Kiritimati, UTC+14.
    expect(edges('Pacific/Kiritimati', '2026-11-27T10:00:00.000Z').slice(0, 2)).toEqual([
      '2026-11-21T10:00:00.000Z',
      '2026-11-28T10:00:00.000Z',
    ]);
    // And still the 26th in Honolulu, UTC-10.
    expect(edges('Pacific/Honolulu', '2026-11-27T05:00:00.000Z').slice(0, 2)).toEqual([
      '2026-11-20T10:00:00.000Z',
      '2026-11-27T10:00:00.000Z',
    ]);
  });

  it('runs a week of 7 days and an hour across the clocks going back', () => {
    const period = resolvePeriod({}, 'America/New_York', at('2026-11-03T15:00:00.000Z'));
    expect(iso(period.from.getTime())).toBe('2026-10-28T04:00:00.000Z');
    expect(iso(period.to.getTime())).toBe('2026-11-04T05:00:00.000Z');
    expect(period.to.getTime() - period.from.getTime()).toBe((7 * 24 + 1) * 3_600_000);
  });

  it('runs a week of 7 days less an hour across the clocks going forward', () => {
    const period = resolvePeriod({}, 'America/New_York', at('2026-03-10T15:00:00.000Z'));
    expect(iso(period.from.getTime())).toBe('2026-03-04T05:00:00.000Z');
    expect(iso(period.to.getTime())).toBe('2026-03-11T04:00:00.000Z');
    expect(period.to.getTime() - period.from.getTime()).toBe((7 * 24 - 1) * 3_600_000);
  });

  it('is the same at the first and the last moment of a local day', () => {
    const first = edges('Africa/Lagos', '2026-11-26T23:00:00.000Z');
    const last = edges('Africa/Lagos', '2026-11-27T22:59:59.999Z');
    expect(first).toEqual(last);
  });
});

describe('a period the caller names', () => {
  it('is kept exactly when both edges are given', () => {
    const period = resolvePeriod(
      { from: at('2026-11-01T00:00:00.000Z'), to: at('2026-11-26T00:00:00.000Z') },
      'Africa/Lagos',
      at('2026-11-27T10:00:00.000Z'),
    );
    expect(period).toEqual({
      from: at('2026-11-01T00:00:00.000Z'),
      to: at('2026-11-26T00:00:00.000Z'),
      timeZone: 'Africa/Lagos',
    });
  });

  it('ends tonight when only the start is given', () => {
    const period = resolvePeriod(
      { from: at('2026-11-01T00:00:00.000Z') },
      'UTC',
      at('2026-11-25T12:00:00.000Z'),
    );
    expect(period.to.toISOString()).toBe('2026-11-26T00:00:00.000Z');
  });

  it('starts seven local days before the end when only the end is given', () => {
    const period = resolvePeriod(
      { to: at('2026-11-04T05:00:00.000Z') },
      'America/New_York',
      at('2026-12-25T00:00:00.000Z'),
    );
    expect(period.from.toISOString()).toBe('2026-10-28T04:00:00.000Z');
  });

  it('must start before it ends', () => {
    const same = at('2026-11-01T00:00:00.000Z');
    expect(() => resolvePeriod({ from: same, to: same }, 'UTC', same)).toThrow(PeriodError);
    try {
      resolvePeriod({ from: at('2026-11-02T00:00:00.000Z'), to: same }, 'UTC', same);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PeriodError);
      expect((error as PeriodError).problem).toBe('from_not_before_to');
    }
  });

  it(`covers at most ${String(MAX_PERIOD_DAYS)} days`, () => {
    const to = at('2026-11-27T00:00:00.000Z');
    const longest = new Date(to.getTime() - MAX_PERIOD_DAYS * 86_400_000);
    expect(resolvePeriod({ from: longest, to }, 'UTC', to).from).toEqual(longest);
    try {
      resolvePeriod({ from: new Date(longest.getTime() - 1), to }, 'UTC', to);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PeriodError);
      expect((error as PeriodError).problem).toBe('longer_than_max');
    }
  });
});

describe('local days', () => {
  it('reads the wall clock of a zone, to the millisecond', () => {
    expect(iso(wallClock('Africa/Lagos', Date.parse('2026-11-27T10:00:00.250Z')))).toBe(
      '2026-11-27T11:00:00.250Z',
    );
    expect(iso(wallClock('UTC', Date.parse('1969-12-31T23:59:59.750Z')))).toBe(
      '1969-12-31T23:59:59.750Z',
    );
  });

  it('starts a day whose midnight the clocks skip at the first moment that exists', () => {
    // Chile moved its clocks from 00:00 to 01:00 on 6 September 2026.
    const start = startOfLocalDay('America/Santiago', Date.parse('2026-09-06T12:00:00.000Z'));
    expect(iso(start)).toBe('2026-09-06T04:00:00.000Z');
    expect(iso(wallClock('America/Santiago', start))).toBe('2026-09-06T01:00:00.000Z');
    expect(iso(wallClock('America/Santiago', start - 1))).toBe('2026-09-05T23:59:59.999Z');
  });

  it('starts a day the clocks reach twice at the first time', () => {
    // On 5 April 2026 Chile's clocks went from 00:00 back to 23:00 the day before.
    const start = startOfLocalDay('America/Santiago', Date.parse('2026-04-05T12:00:00.000Z'));
    expect(iso(start)).toBe('2026-04-05T04:00:00.000Z');
    expect(iso(startOfLocalDay('America/Santiago', Date.parse('2026-04-04T12:00:00.000Z')))).toBe(
      '2026-04-04T03:00:00.000Z',
    );
    // An hour that happens twice is placed at its first time.
    expect(iso(instantOfWall('America/New_York', Date.parse('2026-11-01T01:30:00.000Z')))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('moves a wall time by whole local days', () => {
    expect(
      iso(shiftLocalDays('America/New_York', Date.parse('2026-11-02T14:00:00.000Z'), -2)),
    ).toBe('2026-10-31T13:00:00.000Z');
  });

  it('knows which zones it can place times in', () => {
    expect(isKnownTimeZone('Africa/Nairobi')).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false);
  });
});

// A runtime whose time zone data misbehaves must fail loudly, never place an
// edge somewhere made up.
describe('a time zone formatter that misbehaves', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets an error that is not about the zone name through', () => {
    // A function, not an arrow, so it can be called with new as the real one is.
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(function () {
      throw new TypeError('the runtime has no time zone data');
    });
    expect(() => isKnownTimeZone('Europe/Tallinn')).toThrow(TypeError);
  });

  it('refuses a reading with a field missing', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([
      { type: 'month', value: '11' },
    ]);
    expect(() => wallClock('UTC', 0)).toThrow('the time zone formatter gave no year');
  });

  it('refuses a wall time no instant reads', () => {
    // A clock stuck in 1970 never reaches a wall time in 2026.
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue(
      (['year', 'month', 'day', 'hour', 'minute', 'second'] as const).map((type) => ({
        type,
        value: type === 'year' ? '1970' : '01',
      })),
    );
    expect(() => instantOfWall('UTC', Date.parse('2026-11-27T00:00:00.000Z'))).toThrow(
      'no instant reads the wall time in this zone',
    );
  });
});
