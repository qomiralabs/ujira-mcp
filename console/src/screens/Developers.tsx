// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId, useState } from 'react';

import { useApp } from '../app/context';
import { loaded, usePortfolio } from '../app/portfolio';
import { ConnectPrompt } from '../components/Connect';
import { ConnectClaude } from '../components/ConnectClaude';
import { Link } from '../components/Link';
import { CopyButton, Empty, ErrorNotice, Skeleton, SoonRow, Tip } from '../components/ui';
import { shortAddress } from '../lib/strkey';

const TOOLS: readonly { name: string; text: string }[] = [
  { name: 'quote_payout', text: 'What would happen. Moves nothing.' },
  { name: 'request_payout', text: 'Pays a recipient for a task, once.' },
  { name: 'payout_status', text: 'Waiting, paid, rejected or blocked.' },
  { name: 'list_receipts', text: 'Every request, with its transaction.' },
];

function Tools() {
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

function DemoServer() {
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
      {wallet === null || portfolio === null ? (
        <ConnectPrompt what="the MCP address of each mandate" />
      ) : portfolio.loading ? (
        <Skeleton lines={3} label="Loading your mandates" />
      ) : portfolio.data === undefined ? (
        <ErrorNotice error={portfolio.error ?? 'Not loaded.'} onRetry={portfolio.reload} />
      ) : m === undefined ? (
        <section className="card">
          <Empty
            text="No mandate yet. Try the public demo below."
            action={
              <Link to="/mandates/new" className="btn btn-primary btn-small">
                Create a mandate
              </Link>
            }
          />
        </section>
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
      <SoonRow title="Build on UJIRA" items={['API keys', 'Webhooks', 'TypeScript SDK']} />
    </div>
  );
}
