// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The two cards every version of the developers screen shows: what an agent
// can do through a mandate's MCP address, and the public demo to try first.

import { CopyButton, Tip } from './ui';

const TOOLS: readonly { name: string; text: string }[] = [
  { name: 'quote_payout', text: 'What would happen. Moves nothing.' },
  { name: 'request_payout', text: 'Pays a recipient for a task, once.' },
  { name: 'payout_status', text: 'Waiting, paid, rejected or blocked.' },
  { name: 'list_receipts', text: 'Every request, with its transaction.' },
];

export function Tools() {
  return (
    <section className="card" aria-labelledby="tools-title">
      <div className="card-head">
        <h2 id="tools-title" className="card-title">
          What an agent can do
        </h2>
        <Tip
          label="About the tools"
          text="Each mandate's MCP address offers these four tools, bound to that mandate and its rules. An agent cannot change the rules, move funds out, or approve."
        />
      </div>
      <dl className="tools">
        {TOOLS.map((t) => (
          <div key={t.name}>
            <dt className="mono">{t.name}</dt>
            <dd className="muted small">{t.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function DemoServer() {
  const url = `${location.origin}/mcp`;
  return (
    <section className="card" aria-labelledby="demo-mcp-title">
      <div className="card-head">
        <h2 id="demo-mcp-title" className="card-title">
          Public demo
        </h2>
        <Tip
          label="About the demo"
          text="Our shared demo mandate answers at this address, with the same four tools and test money only."
        />
      </div>
      <div className="copy-row">
        <label className="sr-only" htmlFor="demo-mcp-url">
          MCP address of the demo mandate
        </label>
        <input
          id="demo-mcp-url"
          className="mono"
          readOnly
          value={url}
          onFocus={(e) => {
            e.target.select();
          }}
        />
        <CopyButton text={url} label="Copy address" />
      </div>
    </section>
  );
}
