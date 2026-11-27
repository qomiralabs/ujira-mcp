// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The period an overview covers, in the principal's reporting time zone.
//
// A person reads "the last 7 days" as seven whole days on their own calendar,
// today included, so the default runs from local midnight six days ago to
// local midnight tonight. Days are not always 24 hours long: a zone that
// changes its clocks has 23 or 25 hour days, and a few zones skip midnight
// itself. So a local midnight is found by asking the zone, never by adding
// hours to UTC.
//
// The bounds leave as instants. The database compares instants, so the zone
// only decides where the edges fall.

export const DEFAULT_PERIOD_DAYS = 7;

/** Long enough for a year on any calendar, short enough to bound one scan. */
export const MAX_PERIOD_DAYS = 400;

const DAY_MS = 86_400_000;

export interface Period {
  /** Inclusive. */
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
  /** The IANA zone the edges were placed in. */
  readonly timeZone: string;
}

export interface PeriodRequest {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export type PeriodProblem = 'from_not_before_to' | 'longer_than_max';

export class PeriodError extends Error {
  override readonly name = 'PeriodError';

  constructor(
    readonly problem: PeriodProblem,
    message: string,
  ) {
    super(message);
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** True when this runtime can place times in the zone. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * The wall clock reading in the zone at an instant, written as if it were a
 * UTC time: 09:30 local reads as 09:30Z. Seconds only, as zones move by whole
 * minutes.
 */
export function wallClock(timeZone: string, instant: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) throw new Error(`the time zone formatter gave no ${type}`);
    return Number.parseInt(part.value, 10);
  };
  const millis = ((instant % 1000) + 1000) % 1000;
  return (
    Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      field('hour'),
      field('minute'),
      field('second'),
    ) + millis
  );
}

/**
 * The first instant whose wall clock in the zone reads `wall` or later.
 *
 * The zone's offset is taken a day either side of the target, which brackets
 * any clock change near it. Each offset gives a candidate; where the clocks go
 * back, both read the target and the earlier is the first time it happens;
 * where they jump forward over it, only one lands at or after the target, at
 * the first moment that exists.
 */
export function instantOfWall(timeZone: string, wall: number): number {
  const offsets = [wall - DAY_MS, wall + DAY_MS].map((at) => wallClock(timeZone, at) - at);
  const candidates = offsets
    .map((offset) => wall - offset)
    .map((instant) => ({ instant, reads: wallClock(timeZone, instant) }))
    .filter((c) => c.reads >= wall)
    .sort((a, b) => a.reads - b.reads || a.instant - b.instant);
  const first = candidates[0];
  if (first === undefined) throw new Error('no instant reads the wall time in this zone');
  return first.instant;
}

/** Local midnight at the start of the day `days` after the local day holding `instant`. */
export function startOfLocalDay(timeZone: string, instant: number, days = 0): number {
  const wall = wallClock(timeZone, instant);
  const midnight = wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS);
  return instantOfWall(timeZone, midnight + days * DAY_MS);
}

/** The same wall time `days` local days earlier or later. */
export function shiftLocalDays(timeZone: string, instant: number, days: number): number {
  return instantOfWall(timeZone, wallClock(timeZone, instant) + days * DAY_MS);
}

/**
 * The period a request names, with the gaps filled: `to` defaults to the end
 * of today, and `from` to seven local days before `to`.
 */
export function resolvePeriod(request: PeriodRequest, timeZone: string, now: Date): Period {
  const to = request.to?.getTime() ?? startOfLocalDay(timeZone, now.getTime(), 1);
  const from = request.from?.getTime() ?? shiftLocalDays(timeZone, to, -DEFAULT_PERIOD_DAYS);
  if (from >= to) {
    throw new PeriodError('from_not_before_to', 'the period must start before it ends');
  }
  if (to - from > MAX_PERIOD_DAYS * DAY_MS) {
    throw new PeriodError(
      'longer_than_max',
      `the period is at most ${String(MAX_PERIOD_DAYS)} days`,
    );
  }
  return { from: new Date(from), to: new Date(to), timeZone };
}
