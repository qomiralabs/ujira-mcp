// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Creating a mandate on /v1: the server prepares the factory call with the
// project's agent key, and the owner's wallet signs it. A recipient belongs
// to one mandate, so each person is added once the mandate exists, and the
// owner signs to allow them. Then the owner signs the first deposit. Each
// step is done only when the server shows it.

import { useEffect, useRef, useState } from 'react';

import { useApp } from '../app/context';
import { ConnectPrompt } from '../components/Connect';
import { Link } from '../components/Link';
import { SignPanel, readUntil, useV1Signing, type SignJob } from '../components/V1Sign';
import { Field, Icon, Notice, SoonRow, Tip } from '../components/ui';
import { DEFAULT_DRAFT, validateRules, type RulesDraft, type RulesPlan } from '../lib/mandateForm';
import {
  NEW_RECIPIENTS_MAX,
  checkNewRecipients,
  nameProblem,
  prepareInput,
  tokenOf,
  v1Network,
  type AssetUnit,
  type NewRecipient,
  type NewRecipientProblems,
} from '../lib/mandateV1';
import { LABEL_MAX } from '../lib/recipientsV1';
import { formatToken } from '../lib/money';
import { shortAddress } from '../lib/strkey';
import type { V1Api } from '../lib/v1';

const nowSeconds = () => Math.floor(Date.now() / 1000);

interface Plan {
  readonly name: string;
  readonly rules: RulesPlan;
  readonly recipients: readonly NewRecipient[];
}

type Errors = Partial<Record<keyof RulesDraft | 'name', string>>;
type RowErrors = Readonly<Record<number, NewRecipientProblems>>;

function useUnit(): AssetUnit {
  const { config } = useApp();
  return {
    asset: config.asset.code,
    network: v1Network(config.network),
    scale: config.asset.decimals,
  };
}

function signatureWords(people: number): string {
  if (people === 0) return 'Two signatures: create, then fund.';
  return `${String(people + 2)} signatures: create, one for each person, then fund.`;
}

/** New name and wallet pairs: each becomes a recipient of this mandate alone. */
function NewRecipients({
  rows,
  errors,
  onChange,
}: {
  rows: readonly NewRecipient[];
  errors: RowErrors;
  onChange: (rows: readonly NewRecipient[]) => void;
}) {
  const full = rows.length >= NEW_RECIPIENTS_MAX;
  const update = (i: number, patch: Partial<NewRecipient>) => {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  return (
    <fieldset className="recipients">
      <legend>Who can be paid</legend>
      {rows.length === 0 ? (
        <p className="muted small">No one yet. You can add people now or later.</p>
      ) : (
        <div className="recipient-rows">
          {rows.map((r, i) => {
            const e = errors[i];
            const who = r.label.trim() === '' ? `Person ${String(i + 1)}` : r.label.trim();
            return (
              // A named group per person, so each "Their name" field says whose it is.
              <div
                key={i}
                role="group"
                aria-label={who}
                className={e === undefined ? 'recipient-row' : 'recipient-row row-invalid'}
              >
                <Field
                  label="Their name"
                  value={r.label}
                  onChange={(v) => {
                    update(i, { label: v.slice(0, LABEL_MAX) });
                  }}
                  error={e?.label}
                  autoComplete="off"
                />
                <Field
                  label="Stellar wallet"
                  value={r.address}
                  mono
                  placeholder="G..."
                  onChange={(v) => {
                    update(i, { address: v.trim() });
                  }}
                  error={e?.address}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-small remove"
                  onClick={() => {
                    onChange(rows.filter((_, j) => j !== i));
                  }}
                >
                  Remove<span className="sr-only"> {who}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={full}
          onClick={() => {
            onChange([...rows, { label: '', address: '' }]);
          }}
        >
          <Icon name="plus" size={16} />
          Add someone
        </button>
        <Tip
          label="About who can be paid"
          text="Only wallets on this list can ever be paid from this mandate. Each person is added once the mandate exists, and you sign once to allow each."
        />
      </div>
      {full ? (
        <p className="muted small">
          Up to {NEW_RECIPIENTS_MAX} here. Add more on the mandate later.
        </p>
      ) : null}
    </fieldset>
  );
}

function CreateForm({ onPlan }: { onPlan: (plan: Plan) => void }) {
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
  const [people, setPeople] = useState<readonly NewRecipient[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [rowErrors, setRowErrors] = useState<RowErrors>({});
  const [tried, setTried] = useState(false);

  const check = (n: string, d: RulesDraft, p: readonly NewRecipient[]) => {
    const r = validateRules(d, { nowSeconds: nowSeconds() });
    const e: Errors = r.ok ? {} : { ...r.errors };
    const problem = nameProblem(n);
    if (problem !== null) e.name = problem;
    const rows = checkNewRecipients(p);
    const plan: Plan | undefined =
      r.ok && problem === null && rows.list !== null
        ? { name: n.trim(), rules: r.rules, recipients: rows.list }
        : undefined;
    return { plan, errors: e, rows: rows.rows };
  };

  const change = (n: string, d: RulesDraft, p: readonly NewRecipient[]) => {
    setName(n);
    setDraft(d);
    setPeople(p);
    if (tried) {
      const r = check(n, d, p);
      setErrors(r.errors);
      setRowErrors(r.rows);
    }
  };
  const set = (key: keyof RulesDraft) => (value: string) => {
    change(name, { ...draft, [key]: value }, people);
  };
  const count =
    Object.keys(errors).length +
    Object.values(rowErrors).reduce((sum, e) => sum + Object.keys(e).length, 0);

  return (
    <form
      className="card form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        const r = check(name, draft, people);
        setErrors(r.errors);
        setRowErrors(r.rows);
        if (r.plan !== undefined) onPlan(r.plan);
      }}
    >
      <Field
        label="Name"
        value={name}
        onChange={(v) => {
          change(v, draft, people);
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
      <NewRecipients
        rows={people}
        errors={rowErrors}
        onChange={(p) => {
          change(name, draft, p);
        }}
      />
      {count > 0 ? (
        <Notice tone="blocked" title={count === 1 ? 'One thing to fix' : `${count} things to fix`}>
          <p>Each one is marked next to its field.</p>
        </Notice>
      ) : null}
      <div className="form-foot">
        <p className="assure">
          <Icon name="lock" size={16} />
          {signatureWords(people.length)}
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

interface Step {
  readonly title: string;
  readonly why: string;
  readonly done: string;
}

function CreateSteps({ v1, plan, onBack }: { v1: V1Api; plan: Plan; onBack: () => void }) {
  const { notify } = useApp();
  const unit = useUnit();
  const signing = useV1Signing(v1);
  const [index, setIndex] = useState(0);
  const [mandateId, setMandateId] = useState<string | null>(null);
  // The recipient each allow step added, so a retry asks to allow it again
  // instead of adding the same person twice.
  const added = useRef(new Map<number, string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const fund = tokenOf(plan.rules.fund, unit);
  const r = plan.rules;
  const people = plan.recipients;
  const fundStep = people.length + 1;
  const total = people.length + 2;

  const steps: Step[] = [
    {
      title: 'Create the mandate',
      why: `${plan.name}. Budget ${formatToken(tokenOf(r.budget, unit))}, max ${formatToken(tokenOf(r.perPaymentCap, unit))} per payment. You own it.`,
      done: 'Created.',
    },
    ...people.map((p) => ({
      title: `Allow ${p.label}`,
      why: `${shortAddress(p.address)} can be paid from this mandate, inside your rules.`,
      done: 'Allowed.',
    })),
    {
      title: `Fund it with ${formatToken(fund)}`,
      why: 'From your wallet. Take back what is free any time.',
      done: 'Funded.',
    },
  ];

  const allowJob = (k: number, id: string, who: NewRecipient): SignJob => ({
    prepare: async () => {
      const known = added.current.get(k);
      if (known !== undefined) {
        return v1.mandateAction(id, { kind: 'allow_recipients', recipientIds: [known] });
      }
      const made = await v1.createRecipient({
        mandateId: id,
        label: who.label,
        address: who.address,
      });
      added.current.set(k, made.recipient.id);
      return (
        made.signingRequest ??
        v1.mandateAction(id, { kind: 'allow_recipients', recipientIds: [made.recipient.id] })
      );
    },
    confirm: () =>
      readUntil(
        () => v1.mandate(id),
        () => true,
      ),
    onDone: () => {
      notify(`${who.label} can be paid.`);
      setIndex(k + 2);
    },
  });

  const jobFor = (i: number, id: string | null): SignJob | null => {
    if (i === 0) {
      return {
        prepare: () => v1.prepareMandate(prepareInput(plan.name, r, unit)),
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
          notify(`Step 1 of ${String(total)} is done.`);
          setIndex(1);
        },
      };
    }
    if (id === null) return null;
    const who = people[i - 1];
    if (i < fundStep && who !== undefined) return allowJob(i - 1, id, who);
    if (i === fundStep) {
      return {
        prepare: () => v1.mandateAction(id, { kind: 'fund', amount: fund.amount }),
        confirm: () =>
          readUntil(
            () => v1.mandate(id),
            (m) => m.state.balance.amount >= fund.amount,
          ),
        onDone: () => {
          notify('Your mandate is live.');
          setIndex(total);
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

  const finished = index >= total;
  const stuck = signing.phase.kind === 'done' && index === 0 && mandateId === null;

  return (
    <section className="card signing" aria-labelledby="signing-title">
      <h2 id="signing-title" className="card-title" tabIndex={-1} ref={heading}>
        {finished ? 'Your mandate is live' : `Sign step ${String(index + 1)} of ${String(total)}`}
      </h2>
      <ol className="sign-steps">
        {steps.map((s, i) => {
          const state = i < index ? 'done' : i === index ? 'current' : 'later';
          return (
            <li
              key={`${String(i)}-${s.title}`}
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
            {finished ? 'Open your mandate' : index === fundStep ? 'Fund it later' : 'Finish later'}
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
export function CreateMandateV1({ v1 }: { v1: V1Api; projectId: string }) {
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
        <CreateForm onPlan={setPlan} />
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
