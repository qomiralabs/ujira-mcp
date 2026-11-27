// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId, type ReactNode } from 'react';

import { formatUsdc } from '../lib/money';
import type { Mandate } from '../lib/schemas';
import { CopyButton, Tip } from './ui';

/** A mandate's MCP address and the three steps to hand it to Claude. */
export function McpConnect({
  url,
  title,
  approvalFrom,
  recipient,
  children,
}: {
  url: string;
  title: string;
  /** The approval threshold in words, such as "250.00 USDC"; null when nothing waits. */
  approvalFrom: string | null;
  /** A recipient to name in the first request; "a recipient" when there is none. */
  recipient?: string | undefined;
  /** Sits under the title, such as a mandate chooser. */
  children?: ReactNode;
}) {
  const titleId = useId();
  const inputId = useId();
  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card-head">
        <h2 id={titleId} className="card-title">
          {title}
        </h2>
        <Tip
          label="What Claude can do"
          text={`Claude acts as the agent for this mandate: it can quote, request payouts, check their status and list receipts, and nothing more.${approvalFrom === null ? '' : ` Payouts at or above ${approvalFrom} wait for your approval here.`}`}
        />
      </div>
      {children}
      <div className="copy-row">
        <label className="sr-only" htmlFor={inputId}>
          MCP address for this mandate
        </label>
        <input
          id={inputId}
          className="mono"
          readOnly
          value={url}
          onFocus={(e) => {
            e.target.select();
          }}
        />
        <CopyButton text={url} label="Copy address" />
      </div>
      <ol className="numbered">
        <li>In Claude, open Settings, then Connectors.</li>
        <li>Add a custom connector, paste the address, save.</li>
        <li>
          Ask: &ldquo;Quote 2 USDC to {recipient ?? 'a recipient'} for task demo-1, then pay
          it.&rdquo;
        </li>
      </ol>
    </section>
  );
}

/** The /api mandate's own MCP address and the steps to connect it. */
export function ConnectClaude({ m, title = 'Connect Claude' }: { m: Mandate; title?: string }) {
  return (
    <McpConnect
      url={m.mcpUrl}
      title={title}
      approvalFrom={formatUsdc(m.rules.approvalThreshold)}
      recipient={m.recipients[0]?.label ?? 'a recipient'}
    />
  );
}
