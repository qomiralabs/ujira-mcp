// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId } from 'react';

import { formatUsdc } from '../lib/money';
import type { Mandate } from '../lib/schemas';
import { CopyButton, Tip } from './ui';

/** The mandate's own MCP address and the three steps to hand it to Claude. */
export function ConnectClaude({ m, title = 'Connect Claude' }: { m: Mandate; title?: string }) {
  const titleId = useId();
  const inputId = useId();
  const first = m.recipients[0]?.label ?? 'a recipient';
  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card-head">
        <h2 id={titleId} className="card-title">
          {title}
        </h2>
        <Tip
          label="What Claude can do"
          text={`Claude acts as the agent for this mandate: it can quote, request payouts, check their status and list receipts, and nothing more. Payouts at or above ${formatUsdc(m.rules.approvalThreshold)} wait for your approval here.`}
        />
      </div>
      <div className="copy-row">
        <label className="sr-only" htmlFor={inputId}>
          MCP address for this mandate
        </label>
        <input
          id={inputId}
          className="mono"
          readOnly
          value={m.mcpUrl}
          onFocus={(e) => {
            e.target.select();
          }}
        />
        <CopyButton text={m.mcpUrl} label="Copy address" />
      </div>
      <ol className="numbered">
        <li>In Claude, open Settings, then Connectors.</li>
        <li>Add a custom connector, paste the address, save.</li>
        <li>Ask: &ldquo;Quote 2 USDC to {first} for task demo-1, then pay it.&rdquo;</li>
      </ol>
    </section>
  );
}
