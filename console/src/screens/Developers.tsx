// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId, useState } from 'react';

import { useApp } from '../app/context';
import { loaded, usePortfolio } from '../app/portfolio';
import { ConnectPrompt } from '../components/Connect';
import { ConnectClaude } from '../components/ConnectClaude';
import { Link } from '../components/Link';
import { ComingSoon, CopyButton, ErrorNotice, Notice, Skeleton } from '../components/ui';
import { shortAddress } from '../lib/strkey';

const TOOLS: readonly { name: string; text: string }[] = [
  {
    name: 'quote_payout',
    text: 'Asks what would happen: allowed, needs approval, or blocked and why. Moves nothing.',
  },
  {
    name: 'request_payout',
    text: 'Asks the mandate to pay a recipient for a task. One task is paid at most once.',
  },
  { name: 'payout_status', text: 'Where a payout stands: waiting, paid, rejected or blocked.' },
  { name: 'list_receipts', text: 'Every request so far, with the Stellar transaction when paid.' },
];

function Tools() {
  return (
    <section className="card" aria-labelledby="tools-title">
      <h2 id="tools-title" className="card-title">
        What an agent can do
      </h2>
      <p className="muted">
        Each mandate&apos;s MCP address offers four tools, bound to that mandate and its rules.
        Nothing else: an agent cannot change the rules, move funds out, or approve.
      </p>
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

function DemoServer() {
  const url = `${location.origin}/mcp`;
  return (
    <section className="card" aria-labelledby="demo-mcp-title">
      <h2 id="demo-mcp-title" className="card-title">
        Try it without a mandate of your own
      </h2>
      <p className="muted">
        Our public demo mandate answers at this address, with the same four tools and test money
        only.
      </p>
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

export function DevelopersPage() {
  const { wallet } = useApp();
  const portfolio = usePortfolio();
  const chooserId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const mandates =
    portfolio?.data === undefined ? [] : loaded(portfolio.data).map((l) => l.mandate);
  const m = mandates.find((x) => x.id === chosen) ?? mandates[0];

  return (
    <div className="stack">
      <p className="lead">
        Every mandate has its own MCP address. Give it to Claude, or any MCP client, and the agent
        pays from that mandate inside its rules.
      </p>
      {wallet === null || portfolio === null ? (
        <ConnectPrompt what="the MCP address of each mandate" />
      ) : portfolio.loading ? (
        <Skeleton lines={3} label="Loading your mandates" />
      ) : portfolio.data === undefined ? (
        <ErrorNotice error={portfolio.error ?? 'Not loaded.'} onRetry={portfolio.reload} />
      ) : m === undefined ? (
        <Notice tone="info" title="No mandate yet">
          <p>
            <Link to="/mandates/new">Create a mandate</Link> to get its MCP address, or try the demo
            mandate below.
          </p>
        </Notice>
      ) : (
        <>
          {mandates.length > 1 ? (
            <div className="field chooser">
              <label htmlFor={chooserId}>Mandate to connect</label>
              <select
                id={chooserId}
                value={m.id}
                onChange={(e) => {
                  setChosen(e.target.value);
                }}
              >
                {mandates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {shortAddress(x.id, 6)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <ConnectClaude
            key={m.id}
            m={m}
            title={`Connect Claude to mandate ${shortAddress(m.id, 6)}`}
          />
        </>
      )}
      <div className="grid-2">
        <Tools />
        <DemoServer />
      </div>
      <ComingSoon
        title="Build on UJIRA"
        lede="Create payouts from your own systems, and hear back the moment one is paid."
        items={[
          { title: 'API keys', text: 'Scoped to one project, rotated without downtime.' },
          { title: 'Webhooks', text: 'Paid, blocked and approval events, signed.' },
          { title: 'TypeScript SDK', text: 'The same calls as the API, typed.' },
        ]}
      />
    </div>
  );
}
