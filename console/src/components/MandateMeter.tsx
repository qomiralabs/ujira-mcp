// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { meterOf } from '../lib/mandateV1';
import { formatToken } from '../lib/money';
import type { V1Mandate } from '../lib/v1Schemas';
import { Amount, Tip } from './ui';

/** The total budget as one bar: used, committed to waiting payouts, and what remains. */
export function MandateMeter({ m, compact = false }: { m: V1Mandate; compact?: boolean }) {
  const meter = meterOf(m);
  const label = `${formatToken(meter.used)} used, ${formatToken(meter.committed)} committed, ${formatToken(meter.remaining)} remaining of ${formatToken(meter.budget)}`;
  const bar = (
    <span className="meter meter-split" role="img" aria-label={label}>
      <span className="meter-used" style={{ width: `${String(meter.usedPercent)}%` }} />
      <span className="meter-committed" style={{ width: `${String(meter.committedPercent)}%` }} />
    </span>
  );
  if (compact) {
    return (
      <span className="mandate-meter">
        {bar}
        <span className="muted small">
          {formatToken(meter.remaining)} of {formatToken(meter.budget)} left
        </span>
      </span>
    );
  }
  return (
    <div className="meter-block">
      {bar}
      <dl className="meter-legend">
        <div>
          <dt>
            <span className="meter-key meter-key-used" aria-hidden="true" />
            Used
          </dt>
          <dd>
            <Amount token={meter.used} />
          </dd>
        </div>
        <div>
          <dt>
            <span className="meter-key meter-key-committed" aria-hidden="true" />
            Committed
            <Tip label="About committed" text="Set aside for payouts that wait for approval." />
          </dt>
          <dd>
            <Amount token={meter.committed} />
          </dd>
        </div>
        <div>
          <dt>
            <span className="meter-key" aria-hidden="true" />
            Remaining
          </dt>
          <dd>
            <Amount token={meter.remaining} />
          </dd>
        </div>
      </dl>
      <p className="muted small">Budget {formatToken(meter.budget)}</p>
    </div>
  );
}
