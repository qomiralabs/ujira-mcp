// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { useEffect, useState } from 'react';

import { useApp } from '../app/context';
import { useAction, useResource } from '../app/hooks';
import { ConnectPrompt } from '../components/Connect';
import { Link } from '../components/Link';
import { SigningSteps, type SigningStep } from '../components/SigningSteps';
import { TopUpPanel } from '../components/TopUp';
import { ErrorNotice, Field, Icon, Notice, Spinner, Tip } from '../components/ui';
import {
  DEFAULT_DRAFT,
  MAX_LABEL,
  maxRecipients,
  nextName,
  validateDraft,
  type DraftErrors,
  type MandateDraft,
  type MandatePlan,
} from '../lib/mandateForm';
import { compareMinor, formatAmount, formatUsdc, parseAmount } from '../lib/money';
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

function RecipientsEditor({
  draft,
  setDraft,
  errors,
}: {
  draft: MandateDraft;
  setDraft: (d: MandateDraft) => void;
  errors: DraftErrors;
}) {
  const { api, config, notify } = useApp();
  const limit = maxRecipients(config.sdpAvailable);
  const full = draft.recipients.length >= limit;
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
                  help={r.test === true ? 'Test wallet' : undefined}
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
          disabled={addTest.busy || full}
        >
          {addTest.busy ? <Spinner /> : null}
          {addTest.busy ? 'Making a test wallet' : 'Add a test recipient'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={full}
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
        <Tip
          label="About recipients"
          text="Only these wallets can ever be paid from this mandate. A test recipient is a fresh testnet wallet we make for you. Test recipients send the USDC they receive back to our faucet a few minutes later, so the demo stays funded; receipts still show every payment."
        />
      </div>
      {full ? <p className="muted small">Up to {limit} per signature.</p> : null}
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
      why: `Budget ${formatUsdc(plan.budget)}. Max ${formatUsdc(plan.perPaymentCap)} per payment, ${formatUsdc(plan.dailyCap)} per person a day. Your approval from ${formatUsdc(plan.approvalThreshold)}. You own it.`,
    },
    {
      title: n === 1 ? 'Allow 1 recipient' : `Allow ${n} recipients`,
      why: `${plan.recipients.map((r) => r.label).join(', ')}. Nobody else can be paid.`,
    },
    {
      title: `Fund it with ${formatUsdc(plan.fund)}`,
      why: 'From your wallet. Revoke any time to take back what is left.',
    },
  ];
}

function CreateForm({ wallet, onPlan }: { wallet: Wallet; onPlan: (p: MandatePlan) => void }) {
  const { api, config } = useApp();
  const account = useResource(`account:${wallet.address}`, () => api.account(wallet.address));
  const [draft, setDraft] = useState<MandateDraft>(DEFAULT_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [tried, setTried] = useState(false);
  const walletUsdc = account.data === undefined ? undefined : account.data.usdc;

  const check = (d: MandateDraft) =>
    validateDraft(d, {
      nowSeconds: nowSeconds(),
      maxRecipients: maxRecipients(config.sdpAvailable),
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

  // Re-check once a top up lands, so a stale "not enough" goes away by itself.
  useEffect(() => {
    if (!tried) return;
    const r = validateDraft(draft, {
      nowSeconds: nowSeconds(),
      maxRecipients: maxRecipients(config.sdpAvailable),
      ...(walletUsdc === undefined ? {} : { walletUsdc }),
    });
    setErrors(r.ok ? {} : r.errors);
    // Only a new wallet balance triggers this; typing re-checks on its own.
  }, [walletUsdc]);

  const wanted = parseAmount(draft.fund);
  const short =
    typeof walletUsdc === 'string' && wanted.ok && compareMinor(wanted.minor, walletUsdc) > 0;

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
            tip="The most this mandate can ever pay out, all payouts together."
          />
          <Field
            label="Max per payment"
            suffix="USDC"
            inputMode="decimal"
            value={draft.perPaymentCap}
            onChange={set('perPaymentCap')}
            error={errors.perPaymentCap}
            tip="No single payout can be bigger than this."
          />
          <Field
            label="Daily cap per person"
            suffix="USDC"
            inputMode="decimal"
            value={draft.dailyCap}
            onChange={set('dailyCap')}
            error={errors.dailyCap}
            tip="What one recipient can receive in a day, all payouts together."
          />
          <Field
            label="Approval from"
            suffix="USDC"
            inputMode="decimal"
            value={draft.approvalThreshold}
            onChange={set('approvalThreshold')}
            error={errors.approvalThreshold}
            tip="Payouts of this amount or more wait until you approve them in your wallet. Use 0 to approve every payout."
          />
          <Field
            label="Ends after"
            suffix="days"
            inputMode="numeric"
            value={draft.expiryDays}
            onChange={set('expiryDays')}
            error={errors.expiryDays}
            help={end === null ? undefined : `On ${end}`}
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
                ? undefined
                : walletUsdc === null
                  ? 'Your wallet cannot hold USDC yet.'
                  : `You hold ${formatAmount(walletUsdc)} USDC`
            }
          />
        </div>
        {short ? (
          <TopUpPanel
            wallet={wallet}
            intro="Not enough test USDC in your wallet to fund this."
            onDone={account.reload}
          />
        ) : null}
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
      <div className="form-foot">
        <p className="assure">
          <Icon name="lock" size={16} />
          Three signatures: create, allow, fund.
        </p>
        <div className="actions">
          <Link to="/mandates" className="btn btn-ghost">
            Cancel
          </Link>
          <button type="submit" className="btn btn-primary">
            Review and sign
          </button>
        </div>
      </div>
    </form>
  );
}

export function CreateMandate() {
  const { wallet, api } = useApp();
  const [plan, setPlan] = useState<MandatePlan | null>(null);
  if (wallet === null) {
    return (
      <div className="stack narrow">
        <ConnectPrompt what="your mandates and create one" />
      </div>
    );
  }
  return (
    <div className="stack narrow">
      <Link to="/mandates" className="back">
        <Icon name="back" size={16} />
        Mandates
      </Link>
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
