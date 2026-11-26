// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// One view per step, one question per view. Each view is a plain function of
// the answers so far, so every state can be rendered and read in a test
// without driving the whole widget.

import { html, nothing, type TemplateResult } from 'lit';

import type { WalletChallenge } from '../api/contract.js';
import type { MessageKey, Translate } from '../i18n/catalogue.js';
import { WALLET_CHOICES, type Answers, type StepId, type WalletChoice } from '../steps.js';
import { alertBlock, busyBlock, primaryAction, textButton, textField } from './parts.js';

export const MEMO_ID = 'memo';
export const SIGNATURE_ID = 'signature';

/** Who signs the proof: Freighter, the page's own wallet, or the person by hand. */
export type Signer = 'freighter' | 'page' | 'manual';

export interface ProofContext {
  /** Undefined while it is being fetched, or when fetching it failed. */
  challenge: WalletChallenge | undefined;
  /** Fetching the message failed; the step offers to try again. */
  failed: boolean;
  signer: Signer;
  signature: string;
  changeSignature: (value: string) => void;
  copy: () => void;
  copied: boolean;
}

export interface StepContext {
  t: Translate;
  answers: Answers;
  /** The problem on screen, translated. Empty when there is none. */
  message: string;
  /** Which field the problem belongs to. */
  problemField: 'answer' | 'memo';
  busy: boolean;
  /** What the busy line says, when it is not the default. */
  busyLabel?: string;
  submit: (event: Event) => void;
  change: (value: string) => void;
  changeMemo: (value: string) => void;
  choose: (choice: WalletChoice) => void;
  proof: ProofContext;
}

function heading(text: string): TemplateResult {
  return html`<h2 class="heading" data-focus tabindex="-1">${text}</h2>`;
}

function busyLine(ctx: StepContext): TemplateResult | typeof nothing {
  return busyBlock(ctx.busyLabel ?? ctx.t('widget.busy'), ctx.busy);
}

const CHOICE_WORDS: Readonly<Record<WalletChoice, { name: MessageKey; line: MessageKey }>> = {
  freighter: { name: 'wallet.freighter.name', line: 'wallet.freighter.line' },
  other: { name: 'wallet.other.name', line: 'wallet.other.line' },
};

function choice(ctx: StepContext, id: WalletChoice): TemplateResult {
  const { t } = ctx;
  const lineId = `wallet-${id}-line`;
  return html`<label class="choice">
    <input
      type="radio"
      name="wallet"
      value=${id}
      .checked=${ctx.answers.wallet === id}
      ?disabled=${ctx.busy}
      aria-describedby=${lineId}
      @change=${() => {
        ctx.choose(id);
      }}
    />
    <span class="choice-name">${t(CHOICE_WORDS[id].name)}</span>
    <span class="choice-line" id=${lineId}>${t(CHOICE_WORDS[id].line)}</span>
  </label>`;
}

/** Which wallet the person brings. The method itself is fixed: their own wallet. */
export function walletStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    <fieldset class="step">
      <legend class="heading" data-focus tabindex="-1">${t('wallet.heading')}</legend>
      <p class="hint">${t('wallet.hint')}</p>
      ${alertBlock(ctx.message)}
      <div class="choices">${WALLET_CHOICES.map((id) => choice(ctx, id))}</div>
    </fieldset>
    ${primaryAction({ label: t('wallet.action'), busy: ctx.busy })} ${busyLine(ctx)}
  </form>`;
}

/**
 * Where the payouts arrive. With Freighter the answer is one press: the
 * wallet shares its address. Otherwise the person pastes it, with a memo
 * only when an exchange gave them one.
 */
export function addressStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  if (ctx.answers.wallet === 'freighter') {
    return html`<form class="step" novalidate @submit=${ctx.submit}>
      ${heading(t('connect.heading'))}
      <p class="hint">${t('connect.hint')}</p>
      ${alertBlock(ctx.message)} ${primaryAction({ label: t('connect.action'), busy: ctx.busy })}
      ${busyLine(ctx)}
    </form>`;
  }
  const problem = ctx.message !== '';
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t('destination.wallet.heading'))} ${alertBlock(ctx.message)}
    ${textField({
      label: t('destination.wallet.label'),
      hint: t('destination.wallet.hint'),
      value: ctx.answers.destination,
      invalid: problem && ctx.problemField === 'answer',
      disabled: ctx.busy,
      code: true,
      inputMode: 'text',
      autocomplete: 'off',
      change: ctx.change,
    })}
    ${textField({
      id: MEMO_ID,
      label: t('destination.memo.label'),
      hint: t('destination.memo.hint'),
      value: ctx.answers.memo,
      invalid: problem && ctx.problemField === 'memo',
      disabled: ctx.busy,
      code: true,
      inputMode: 'numeric',
      autocomplete: 'off',
      change: ctx.changeMemo,
    })}
    ${primaryAction({ label: t('destination.wallet.action'), busy: ctx.busy })} ${busyLine(ctx)}
  </form>`;
}

function savedAddress(ctx: StepContext): TemplateResult {
  return html`<div class="statement">
    <span class="statement-label">${ctx.t('prove.address')}</span>
    <p class="statement-value">${ctx.answers.destination.trim()}</p>
  </div>`;
}

/**
 * The wallet signs a message to show the address is the recipient's. With
 * Freighter or the page's wallet that is one press; otherwise the person
 * signs in their own wallet app and pastes the signature back.
 */
export function proveStep(ctx: StepContext): TemplateResult {
  const { t, proof } = ctx;
  const challenge = proof.challenge;
  if (challenge === undefined) {
    // Fetching the message to sign, or a failed fetch with a way to retry.
    return html`<form class="step" novalidate @submit=${ctx.submit}>
      ${heading(t('prove.heading'))} ${alertBlock(ctx.message)}
      ${
        proof.failed
          ? primaryAction({ label: t('widget.retry'), busy: ctx.busy })
          : busyBlock(t('widget.loading'), true)
      }
    </form>`;
  }
  if (proof.signer !== 'manual') {
    const action = proof.signer === 'freighter' ? 'prove.freighter.action' : 'prove.action';
    return html`<form class="step" novalidate @submit=${ctx.submit}>
      ${heading(t('prove.heading'))}
      <p class="hint">${t('prove.hint')}</p>
      ${savedAddress(ctx)} ${alertBlock(ctx.message)}
      ${primaryAction({ label: t(action), busy: ctx.busy })} ${busyLine(ctx)}
    </form>`;
  }
  return html`<form class="step" novalidate @submit=${ctx.submit}>
    ${heading(t('prove.heading'))}
    <p class="hint">${t('prove.manual.hint')}</p>
    ${alertBlock(ctx.message)}
    <div class="field">
      <div class="answer-head">
        <span class="label">${t('prove.message.label')}</span>
        ${textButton({
          label: proof.copied ? t('prove.copied') : t('prove.copy'),
          name: t('prove.copy.name'),
          press: proof.copy,
        })}
      </div>
      <pre class="sign-text">${challenge.message}</pre>
    </div>
    ${textField({
      id: SIGNATURE_ID,
      label: t('prove.signature.label'),
      hint: t('prove.signature.hint'),
      value: proof.signature,
      invalid: ctx.message !== '',
      disabled: ctx.busy,
      code: true,
      inputMode: 'text',
      autocomplete: 'off',
      change: proof.changeSignature,
    })}
    ${primaryAction({ label: t('prove.manual.action'), busy: ctx.busy })} ${busyLine(ctx)}
  </form>`;
}

export function doneStep(ctx: StepContext): TemplateResult {
  const { t } = ctx;
  return html`<div class="step">
    ${heading(t('done.heading'))}
    <p class="hint">${t('done.body')}</p>
    ${savedAddress(ctx)}
  </div>`;
}

const VIEWS: Readonly<Record<StepId, (ctx: StepContext) => TemplateResult>> = {
  wallet: walletStep,
  address: addressStep,
  prove: proveStep,
  done: doneStep,
};

export function stepView(step: StepId, ctx: StepContext): TemplateResult {
  return VIEWS[step](ctx);
}

/** Before the first question, or instead of it. */
export type Waiting =
  | { kind: 'loading' }
  | { kind: 'failed'; retry: () => void }
  | { kind: 'stopped'; key: MessageKey };

export function waitingView(t: Translate, state: Waiting): TemplateResult {
  if (state.kind === 'loading') {
    return html`<div class="step">${busyBlock(t('widget.loading'), true)}</div>`;
  }
  if (state.kind === 'stopped') {
    return html`<div class="step">${alertBlock(t(state.key))}</div>`;
  }
  return html`<form
    class="step"
    novalidate
    @submit=${(event: Event) => {
      event.preventDefault();
      state.retry();
    }}
  >
    ${alertBlock(t('widget.loadFailed'))}
    ${primaryAction({ label: t('widget.retry'), busy: false })}
  </form>`;
}
