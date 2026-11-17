// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useId, useState } from 'react';

import { explorerAccount, useApp } from '../app/context';
import { useAction } from '../app/hooks';
import { loaded, usePortfolio } from '../app/portfolio';
import { ConnectPrompt } from '../components/Connect';
import { Link } from '../components/Link';
import {
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  Skeleton,
  SoonRow,
  Spinner,
  StatusPill,
  TxLink,
} from '../components/ui';
import { labelProblem, nextName } from '../lib/mandateForm';
import type { Mandate } from '../lib/schemas';
import { buildSignSubmit } from '../lib/sign';
import { accountAddressProblem, shortAddress } from '../lib/strkey';
import { MANDATE_STATUS, mandateStatus } from '../lib/words';

function AllowRecipient({ m, onDone }: { m: Mandate; onDone: () => void }) {
  const { api, config, wallet, notify } = useApp();
  const taken = m.recipients.map((r) => r.label);
  const [label, setLabel] = useState(() => nextName(taken));
  const [address, setAddress] = useState('');
  const [test, setTest] = useState(false);
  const [errors, setErrors] = useState<{ label?: string; address?: string }>({});
  const [lastTx, setLastTx] = useState<string | null>(null);

  const makeTest = useAction(async () => {
    const r = await api.testRecipient();
    setAddress(r.address);
    setTest(true);
    setErrors({});
  });

  const allow = useAction(async () => {
    if (wallet === null) return;
    const name = label.trim();
    const next: typeof errors = {};
    const lp = labelProblem(name);
    if (lp !== null) next.label = lp;
    else if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) {
      next.label = 'This mandate already has someone with this name.';
    }
    const ap = accountAddressProblem(address);
    if (ap !== null) next.address = ap;
    else if (m.recipients.some((r) => r.address === address)) {
      next.address = 'This wallet is already on the list.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const res = await buildSignSubmit(api, config, wallet, 'allow_recipients', {
      mandate: m.id,
      recipients: [{ label: name, address }],
    });
    setLastTx(res.hash);
    notify(`${name} can now be paid from this mandate.`);
    setLabel(nextName([...taken, name]));
    setAddress('');
    setTest(false);
    onDone();
  });

  const busy = makeTest.busy || allow.busy;
  return (
    <form
      className="inline-form allow-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void allow.run();
      }}
    >
      <Field label="Name" value={label} onChange={setLabel} error={errors.label} />
      <Field
        label="Stellar address"
        mono
        placeholder="G..."
        value={address}
        onChange={(v) => {
          setAddress(v.trim());
          setTest(false);
        }}
        error={errors.address}
        help={test ? 'Test wallet made by UJIRA, ready to receive USDC' : undefined}
      />
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void makeTest.run()}>
          {makeTest.busy ? <Spinner /> : null}
          {makeTest.busy ? 'Making a test wallet' : 'Use a test wallet'}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {allow.busy ? <Spinner /> : null}
          {allow.busy ? 'Waiting for your wallet' : 'Allow and sign'}
        </button>
      </div>
      {makeTest.error === null ? null : <ErrorNotice error={makeTest.error} />}
      {allow.error === null ? null : <ErrorNotice error={allow.error} />}
      {lastTx === null ? null : (
        <p className="small allow-note">
          Added to the list. <TxLink hash={lastTx} />
        </p>
      )}
    </form>
  );
}

function MandateRecipients({ m, onDone }: { m: Mandate; onDone: () => void }) {
  const { config, wallet } = useApp();
  const titleId = useId();
  const status = mandateStatus(m.state);
  const word = MANDATE_STATUS[status];
  const owner = wallet !== null && wallet.address === m.principal;
  const open = status === 'active' || status === 'paused';
  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card-head">
        <h2 id={titleId} className="card-title">
          Mandate <span className="mono">{shortAddress(m.id, 6)}</span>
        </h2>
        <span className="actions">
          <StatusPill tone={word.tone}>{word.label}</StatusPill>
          <Link to={`/mandates/${m.id}`} className="card-link">
            Open
          </Link>
        </span>
      </div>
      {m.recipients.length === 0 ? (
        <p className="muted small">Nobody yet, so every payout is blocked.</p>
      ) : (
        <ul className="people">
          {m.recipients.map((r) => (
            <li key={r.address}>
              <span className="avatar" aria-hidden="true">
                {r.label.slice(0, 1).toUpperCase()}
              </span>
              <span className="people-main">
                <strong>{r.label}</strong>
                <a
                  className="mono-link people-address"
                  href={explorerAccount(config, r.address)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.address}
                  <span className="sr-only"> (opens Stellar Expert)</span>
                </a>
              </span>
              <CopyButton text={r.address} label={`Copy the address of ${r.label}`} icon />
            </li>
          ))}
        </ul>
      )}
      {owner && open ? <AllowRecipient m={m} onDone={onDone} /> : null}
    </section>
  );
}

export function RecipientsPage() {
  const { wallet } = useApp();
  const portfolio = usePortfolio();
  if (wallet === null || portfolio === null) {
    return (
      <div className="stack">
        <ConnectPrompt what="who your mandates can pay" />
      </div>
    );
  }
  const bundles = portfolio.data;
  return (
    <div className="stack">
      {portfolio.loading ? (
        <Skeleton lines={3} label="Loading your recipients" />
      ) : bundles === undefined ? (
        <ErrorNotice error={portfolio.error ?? 'Not loaded.'} onRetry={portfolio.reload} />
      ) : bundles.length === 0 ? (
        <section className="card">
          <Empty
            text="No recipients yet."
            action={
              <Link to="/mandates/new" className="btn btn-primary btn-small">
                Create a mandate
              </Link>
            }
          />
        </section>
      ) : (
        loaded(bundles).map(({ mandate }) => (
          <MandateRecipients key={mandate.id} m={mandate} onDone={portfolio.reload} />
        ))
      )}
      <SoonRow
        title="Invite people to be paid"
        items={['Invite by link', 'They choose how', 'Checked first']}
      />
    </div>
  );
}
