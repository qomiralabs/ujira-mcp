// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId } from 'react';

import { formatUsdc } from '../lib/money';
import type { Mandate } from '../lib/schemas';
import { CopyButton } from './ui';

/** The mandate's own MCP address and the three steps to hand it to Claude. */
export function ConnectClaude({ m, title = 'Connect Claude' }: { m: Mandate; title?: string }) {
  const titleId = useId();
  const inputId = useId();
  const first = m.recipients[0]?.label ?? 'a recipient';
  return (
    <section className="card" aria-labelledby={titleId}>
      <h2 id={titleId} className="card-title">
        {title}
      </h2>
      <p className="muted">
        Let Claude act as the agent for this mandate. It can quote, request payouts, check their
        status and list receipts, and nothing more.
      </p>
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
        <li>
          Choose Add custom connector, paste the address above and save. No sign in is needed.
        </li>
        <li>
          Ask in a chat, for example: &ldquo;Quote 2 USDC to {first} for task demo-1, then pay
          it.&rdquo; Payouts at or above {formatUsdc(m.rules.approvalThreshold)} wait for your
          approval in this dashboard.
        </li>
      </ol>
    </section>
  );
}
