// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId, useState } from 'react';

import { useApp } from '../app/context';
import { loaded, usePortfolio } from '../app/portfolio';
import { useSession } from '../app/session';
import { useV1 } from '../app/switch';
import { ConnectPrompt } from '../components/Connect';
import { ConnectClaude } from '../components/ConnectClaude';
import { Link } from '../components/Link';
import { DemoServer, Tools } from '../components/McpTools';
import { Empty, ErrorNotice, Skeleton, SoonRow } from '../components/ui';
import { shortAddress } from '../lib/strkey';
import { DevelopersV1 } from './DevelopersV1';

export function DevelopersPage() {
  const v1 = useV1('developers');
  const session = useSession();
  if (v1 !== null && session !== null) {
    return (
      <DevelopersV1
        key={session.project.id}
        v1={v1}
        projectId={session.project.id}
        role={session.principal.role}
      />
    );
  }
  return <DevelopersOnApi />;
}

function DevelopersOnApi() {
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
