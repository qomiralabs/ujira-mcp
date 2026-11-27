// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Creating a mandate on /v1: the server prepares the factory call with the
// project's agent key, the owner's wallet signs it, then signs the first
// deposit. Each step is done only when the server shows it.

import { useEffect, useRef, useState } from 'react';

import { useApp } from '../app/context';
import { ConnectPrompt } from '../components/Connect';
import { Link } from '../components/Link';
import { RecipientPicker } from '../components/RecipientPicker';
import { SignPanel, readUntil, useV1Signing, type SignJob } from '../components/V1Sign';
import { Field, Icon, Notice, SoonRow } from '../components/ui';
import { DEFAULT_DRAFT, validateRules, type RulesDraft, type RulesPlan } from '../lib/mandateForm';
import { nameProblem, prepareInput, tokenOf, v1Network, type AssetUnit } from '../lib/mandateV1';
import { formatToken } from '../lib/money';
import type { V1Api } from '../lib/v1';

const nowSeconds = () => Math.floor(Date.now() / 1000);

interface Plan {
  readonly name: string;
  readonly rules: RulesPlan;
  readonly recipientIds: readonly string[];
}

type Errors = Partial<Record<keyof RulesDraft | 'name', string>>;

function useUnit(): AssetUnit {
  const { config } = useApp();
  return {
    asset: config.asset.code,
    network: v1Network(config.network),
    scale: config.asset.decimals,
  };
}

function CreateForm({
  v1,
  projectId,
  onPlan,
}: {
  v1: V1Api;
  projectId: string;
  onPlan: (plan: Plan) => void;
}) {
  const unit = useUnit();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<RulesDraft>(() => ({
    budget: DEFAULT_DRAFT.budget,
    perPaymentCap: DEFAULT_DRAFT.perPaymentCap,
    dailyCap: DEFAULT_DRAFT.dailyCap,
    approvalThreshold: DEFAULT_DRAFT.approvalThreshold,
    expiryDays: DEFAULT_DRAFT.expiryDays,
    fund: DEFAULT_DRAFT.fund,
  }));
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Errors>({});
  const [tried, setTried] = useState(false);

  const check = (n: string, d: RulesDraft): { plan?: Plan; errors: Errors } => {
    const r = validateRules(d, { nowSeconds: nowSeconds() });
    const e: Errors = r.ok ? {} : { ...r.errors };
    const problem = nameProblem(n);
    if (problem !== null) e.name = problem;
    if (!r.ok || problem !== null) return { errors: e };
    return { plan: { name: n.trim(), rules: r.rules, recipientIds: [...picked] }, errors: {} };
  };

  const change = (n: string, d: RulesDraft) => {
    setName(n);
    setDraft(d);
    if (tried) setErrors(check(n, d).errors);
  };
  const set = (key: keyof RulesDraft) => (value: string) => {
    change(name, { ...draft, [key]: value });
  };
  const count = Object.keys(errors).length;

  return (
    <form
      className="card form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        const r = check(name, draft);
        setErrors(r.errors);
        if (r.plan !== undefined) onPlan(r.plan);
      }}
    >
      <Field
        label="Name"
        value={name}
        onChange={(v) => {
          change(v, draft);
        }}
        error={errors.name}
        placeholder="Weekly payouts"
        tip="Only you see it. You type it back to revoke."
      />
      <fieldset>
        <legend>The rules</legend>
        <div className="form-grid">
          <Field
            label="Total budget"
            suffix={unit.asset}
            inputMode="decimal"
            value={draft.budget}
            onChange={set('budget')}
            error={errors.budget}
            tip="The most this mandate can ever pay out, all payouts together."
          />
          <Field
            label="Max per payment"
            suffix={unit.asset}
            inputMode="decimal"
            value={draft.perPaymentCap}
            onChange={set('perPaymentCap')}
            error={errors.perPaymentCap}
            tip="No single payout can be bigger than this."
          />
          <Field
            label="Daily cap per person"
            suffix={unit.asset}
            inputMode="decimal"
            value={draft.dailyCap}
            onChange={set('dailyCap')}
            error={errors.dailyCap}
            tip="What one recipient can receive in a day, all payouts together."
          />
          <Field
            label="Approval from"
            suffix={unit.asset}
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
          />
          <Field
            label="Fund it with"
            suffix={unit.asset}
            inputMode="decimal"
            value={draft.fund}
            onChange={set('fund')}
            error={errors.fund}
          />
        </div>
      </fieldset>
      <RecipientPicker
        v1={v1}
        projectId={projectId}
        legend="Who can be paid"
        selected={picked}
        onChange={setPicked}
      />
      {count > 0 ? (
        <Notice tone="blocked" title={count === 1 ? 'One thing to fix' : `${count} things to fix`}>
          <p>Each one is marked next to its field.</p>
        </Notice>
      ) : null}
      <div className="form-foot">
        <p className="assure">
          <Icon name="lock" size={16} />
          Two signatures: create, then fund.
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

function CreateSteps({ v1, plan, onBack }: { v1: V1Api; plan: Plan; onBack: () => void }) {
  const { notify } = useApp();
  const unit = useUnit();
  const signing = useV1Signing(v1);
  const [index, setIndex] = useState(0);
  const [mandateId, setMandateId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fund = tokenOf(plan.rules.fund, unit);
  const r = plan.rules;
  const n = plan.recipientIds.length;

  const steps = [
    {
      title: 'Create the mandate',
      why: `${plan.name}. Budget ${formatToken(tokenOf(r.budget, unit))}, max ${formatToken(tokenOf(r.perPaymentCap, unit))} per payment. ${n === 1 ? '1 recipient' : `${String(n)} recipients`}. You own it.`,
      done: 'Created.',
    },
    {
      title: `Fund it with ${formatToken(fund)}`,
      why: 'From your wallet. Take back what is free any time.',
      done: 'Funded.',
    },
  ];

  const jobFor = (i: number, id: string | null): SignJob | null => {
    if (i === 0) {
      return {
        prepare: () => v1.prepareMandate(prepareInput(plan.name, r, plan.recipientIds, unit)),
        confirm: async (s) => {
          const made = s.mandateId ?? null;
          if (made === null) return false;
          setMandateId(made);
          return readUntil(
            () => v1.mandate(made),
            () => true,
          );
        },
        onDone: (s) => {
          if (s.mandateId === undefined || s.mandateId === null) return;
          notify('Step 1 of 2 is done.');
          setIndex(1);
        },
      };
    }
    if (i === 1 && id !== null) {
      return {
        prepare: () => v1.mandateAction(id, { kind: 'fund', amount: fund.amount }),
        confirm: () =>
          readUntil(
            () => v1.mandate(id),
            (m) => m.state.balance.amount >= fund.amount,
          ),
        onDone: () => {
          notify('Your mandate is live.');
          setIndex(2);
        },
      };
    }
    return null;
  };

  // Each step asks the server for its signing request as soon as it is reached.
  useEffect(() => {
    const job = jobFor(index, mandateId);
    if (job === null) return;
    signing.reset();
    signing.start(job);
    heading.current?.focus();
    // A step starts once, when it is reached.
  }, [index]);

  const finished = index >= steps.length;
  const stuck = signing.phase.kind === 'done' && index === 0 && mandateId === null;

  return (
    <section className="card signing" aria-labelledby="signing-title">
      <h2 id="signing-title" className="card-title" tabIndex={-1} ref={heading}>
        {finished ? 'Your mandate is live' : `Sign step ${String(index + 1)} of 2`}
      </h2>
      <ol className="sign-steps">
        {steps.map((s, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'later';
          return (
            <li
              key={s.title}
              className={`sign-step sign-${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="setup-n" aria-hidden="true">
                {state === 'done' ? <Icon name="check" size={16} /> : i + 1}
              </span>
              <div className="setup-body">
                <h3>
                  {s.title}
                  <span className="sr-only">
                    {state === 'done' ? ' (done)' : state === 'current' ? ' (now)' : ' (next)'}
                  </span>
                </h3>
                {state === 'current' ? (
                  <>
                    <p className="muted small">{s.why}</p>
                    <SignPanel signing={signing} done={s.done} />
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {stuck ? (
        <Notice tone="waiting">
          <p>Stellar confirmed it, but the server did not name the new mandate yet.</p>
        </Notice>
      ) : null}
      {finished ? <Notice tone="paid" title="Created and funded" /> : null}
      <div className="actions">
        {mandateId === null ? (
          index === 0 && !signing.busy ? (
            <button type="button" className="btn btn-ghost" onClick={onBack}>
              Change the rules
            </button>
          ) : null
        ) : (
          <Link
            className={finished ? 'btn btn-primary' : 'btn btn-ghost'}
            to={`/mandates/${mandateId}`}
          >
            {finished ? 'Open your mandate' : 'Fund it later'}
          </Link>
        )}
        {stuck ? (
          <Link className="btn" to="/mandates">
            See your mandates
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/** The create screen on /v1, for the open project. */
export function CreateMandateV1({ v1, projectId }: { v1: V1Api; projectId: string }) {
  const { wallet } = useApp();
  const [plan, setPlan] = useState<Plan | null>(null);
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
        <CreateForm v1={v1} projectId={projectId} onPlan={setPlan} />
      ) : (
        <CreateSteps
          v1={v1}
          plan={plan}
          onBack={() => {
            setPlan(null);
          }}
        />
      )}
      <SoonRow title="Mandates next" items={['Approve as a team', 'Import a mandate']} />
    </div>
  );
}
