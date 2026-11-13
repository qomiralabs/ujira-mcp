// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useState } from 'react';

import { useApp } from '../app/context';
import { useAction, useResource } from '../app/hooks';
import { SigningSteps, type SigningStep } from '../components/SigningSteps';
import { ErrorNotice, Field, Notice, Spinner } from '../components/ui';
import {
  DEFAULT_DRAFT,
  MAX_LABEL,
  validateDraft,
  type DraftErrors,
  type MandateDraft,
  type MandatePlan,
} from '../lib/mandateForm';
import { formatAmount, formatUsdc } from '../lib/money';
import type { Wallet } from '../lib/wallet';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function endDate(days: string): string | null {
  if (!/^\d+$/.test(days.trim())) return null;
  const n = Number(days);
  if (n < 1 || n > 365) return null;
  return new Date(Date.now() + n * 86_400_000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

const NAMES = ['Ada', 'Kofi', 'Wanjiru', 'Tunde', 'Amara', 'Zawadi', 'Chidi', 'Nia'];

function nextName(taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  return NAMES.find((n) => !lower.has(n.toLowerCase())) ?? `Recipient ${taken.length + 1}`;
}

function RecipientsEditor({
  draft,
  setDraft,
  errors,
}: {
  draft: MandateDraft;
  setDraft: (d: MandateDraft) => void;
  errors: DraftErrors;
}) {
  const { api, notify } = useApp();
  const addTest = useAction(async () => {
    const r = await api.testRecipient();
    const label = nextName(draft.recipients.map((x) => x.label));
    setDraft({
      ...draft,
      recipients: [...draft.recipients, { label, address: r.address, test: true }],
    });
    notify(`Added ${label}, a fresh test wallet that can receive USDC.`);
  });
  const update = (i: number, patch: { label?: string; address?: string }) => {
    setDraft({
      ...draft,
      recipients: draft.recipients.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    });
  };
  return (
    <fieldset className="recipients">
      <legend>Who can be paid</legend>
      <p className="help">
        Only these wallets can ever receive money from this mandate. A test recipient is a new
        testnet wallet we make for you, already able to receive USDC.
      </p>
      {draft.recipients.length === 0 ? null : (
        <ul className="recipient-rows">
          {draft.recipients.map((r, i) => {
            const rowError = errors.recipientRows?.[i];
            return (
              <li key={i} className={rowError === undefined ? undefined : 'row-invalid'}>
                <Field
                  label="Name"
                  value={r.label}
                  onChange={(v) => {
                    update(i, { label: v.slice(0, MAX_LABEL) });
                  }}
                />
                <Field
                  label="Stellar address"
                  value={r.address}
                  mono
                  placeholder="G..."
                  onChange={(v) => {
                    update(i, { address: v.trim() });
                  }}
                  help={r.test === true ? 'Test wallet made by UJIRA' : undefined}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-small remove"
                  onClick={() => {
                    setDraft({ ...draft, recipients: draft.recipients.filter((_, j) => j !== i) });
                  }}
                >
                  Remove
                  <span className="sr-only"> {r.label === '' ? 'this recipient' : r.label}</span>
                </button>
                {rowError === undefined ? null : (
                  <p className="error-text row-error" role="alert">
                    {rowError}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() => void addTest.run()}
          disabled={addTest.busy}
        >
          {addTest.busy ? <Spinner /> : null}
          {addTest.busy ? 'Making a test wallet' : 'Add a test recipient'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setDraft({
              ...draft,
              recipients: [
                ...draft.recipients,
                { label: nextName(draft.recipients.map((x) => x.label)), address: '' },
              ],
            });
          }}
        >
          Paste an address
        </button>
      </div>
      {errors.recipients === undefined ? null : <p className="error-text">{errors.recipients}</p>}
      {addTest.error === null ? null : <ErrorNotice error={addTest.error} />}
    </fieldset>
  );
}

function stepsFor(plan: MandatePlan): SigningStep[] {
  const n = plan.recipients.length;
  return [
    {
      title: 'Create the mandate',
      why: `Deploys your mandate contract with these rules: budget ${formatUsdc(plan.budget)}, at most ${formatUsdc(plan.perPaymentCap)} per payment and ${formatUsdc(plan.dailyCap)} per recipient per day, your approval from ${formatUsdc(plan.approvalThreshold)}. You are the owner and the approver.`,
    },
    {
      title: n === 1 ? 'Allow 1 recipient' : `Allow ${n} recipients`,
      why: `Adds ${plan.recipients.map((r) => r.label).join(', ')} to the list of wallets this mandate may pay. Nobody else can be paid.`,
    },
    {
      title: `Fund it with ${formatUsdc(plan.fund)}`,
      why: 'Moves test USDC from your wallet into the mandate. You can take back whatever is left at any time by revoking it.',
    },
  ];
}

function CreateForm({ wallet, onPlan }: { wallet: Wallet; onPlan: (p: MandatePlan) => void }) {
  const { api } = useApp();
  const account = useResource(`account:${wallet.address}`, () => api.account(wallet.address));
  const [draft, setDraft] = useState<MandateDraft>(DEFAULT_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [tried, setTried] = useState(false);
  const walletUsdc = account.data === undefined ? undefined : account.data.usdc;

  const check = (d: MandateDraft) =>
    validateDraft(d, {
      nowSeconds: nowSeconds(),
      ...(walletUsdc === undefined ? {} : { walletUsdc }),
    });

  const change = (d: MandateDraft) => {
    setDraft(d);
    if (tried) {
      const r = check(d);
      setErrors(r.ok ? {} : r.errors);
    }
  };
  const set = (key: Exclude<keyof MandateDraft, 'recipients'>) => (value: string) => {
    change({ ...draft, [key]: value });
  };

  const end = endDate(draft.expiryDays);
  const errorCount =
    Object.keys(errors).filter((k) => k !== 'recipientRows').length +
    Object.keys(errors.recipientRows ?? {}).length;

  return (
    <form
      className="card form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        const r = check(draft);
        if (r.ok) {
          setErrors({});
          onPlan(r.plan);
        } else {
          setErrors(r.errors);
        }
      }}
    >
      <fieldset>
        <legend>The rules</legend>
        <div className="form-grid">
          <Field
            label="Total budget"
            suffix="USDC"
            inputMode="decimal"
            value={draft.budget}
            onChange={set('budget')}
            error={errors.budget}
            help="The most this mandate can ever pay out, all payouts together."
          />
          <Field
            label="Max per payment"
            suffix="USDC"
            inputMode="decimal"
            value={draft.perPaymentCap}
            onChange={set('perPaymentCap')}
            error={errors.perPaymentCap}
            help="No single payout can be bigger than this."
          />
          <Field
            label="Max per recipient per day"
            suffix="USDC"
            inputMode="decimal"
            value={draft.dailyCap}
            onChange={set('dailyCap')}
            error={errors.dailyCap}
            help="What one person can receive in a day, all payouts together."
          />
          <Field
            label="Needs your approval from"
            suffix="USDC"
            inputMode="decimal"
            value={draft.approvalThreshold}
            onChange={set('approvalThreshold')}
            error={errors.approvalThreshold}
            help="Payouts of this amount or more wait until you approve them in your wallet."
          />
          <Field
            label="Ends after"
            suffix="days"
            inputMode="numeric"
            value={draft.expiryDays}
            onChange={set('expiryDays')}
            error={errors.expiryDays}
            help={
              end === null
                ? 'After this the mandate stops paying.'
                : `It stops paying after ${end}.`
            }
          />
          <Field
            label="Fund it with"
            suffix="USDC"
            inputMode="decimal"
            value={draft.fund}
            onChange={set('fund')}
            error={errors.fund}
            help={
              walletUsdc === undefined
                ? 'Test USDC moved from your wallet into the mandate now.'
                : walletUsdc === null
                  ? 'Your wallet cannot hold USDC yet. Finish the setup steps first.'
                  : `Moved from your wallet now. You hold ${formatAmount(walletUsdc)} USDC.`
            }
          />
        </div>
      </fieldset>
      <RecipientsEditor draft={draft} setDraft={change} errors={errors} />
      {errorCount > 0 ? (
        <Notice
          tone="blocked"
          title={errorCount === 1 ? 'One thing to fix' : `${errorCount} things to fix`}
        >
          <p>Each one is marked next to its field.</p>
        </Notice>
      ) : null}
      <div className="actions">
        <button type="submit" className="btn btn-primary">
          Review and sign
        </button>
        <a href="#/" className="btn btn-ghost">
          Cancel
        </a>
      </div>
      <p className="muted small">
        Next you sign three transactions in your wallet: create, allow recipients, fund. We show
        what each one does before you sign.
      </p>
    </form>
  );
}

export function CreateMandate() {
  const { wallet, api } = useApp();
  const [plan, setPlan] = useState<MandatePlan | null>(null);
  if (wallet === null) {
    return (
      <div className="stack narrow">
        <h1>Create a mandate</h1>
        <Notice tone="info">
          <p>
            Connect a wallet first. <a href="#/">Go to the start</a>
          </p>
        </Notice>
      </div>
    );
  }
  return (
    <div className="stack narrow">
      <div className="page-head">
        <a href="#/" className="back">
          &larr; Back
        </a>
        <h1>Create a mandate</h1>
        <p className="muted">
          Write the rules once. After that the agent can only pay inside them, and the contract on
          Stellar enforces every one.
        </p>
      </div>
      {plan === null ? (
        <CreateForm wallet={wallet} onPlan={setPlan} />
      ) : (
        <SigningSteps
          steps={stepsFor(plan)}
          onBack={() => {
            setPlan(null);
          }}
          run={async (index, ctx) => {
            const mandate = ctx.mandate;
            if (index === 0) {
              return api.buildTx('create_mandate', wallet.address, {
                budget: plan.budget,
                perPaymentCap: plan.perPaymentCap,
                dailyCap: plan.dailyCap,
                approvalThreshold: plan.approvalThreshold,
                expiresAt: plan.expiresAt,
              });
            }
            if (mandate === undefined)
              throw new Error('The mandate address is missing. Start again.');
            if (index === 1) {
              return api.buildTx('allow_recipients', wallet.address, {
                mandate,
                recipients: plan.recipients,
              });
            }
            return api.buildTx('fund_mandate', wallet.address, { mandate, amount: plan.fund });
          }}
        />
      )}
    </div>
  );
}
