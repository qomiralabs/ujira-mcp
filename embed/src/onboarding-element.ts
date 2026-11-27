// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The onboarding widget: one custom element, one shadow root, no framework
// needed on the page that hosts it.
//
// Given the embed token the integrator's server minted for one recipient,
// the widget asks which wallet the person uses, takes the address (typed, or
// shared by Freighter or Albedo), saves it through UJIRA, and has the wallet sign a
// short message to prove the address is theirs. The integrator owns the look
// (custom properties); the widget owns the flow: which question comes next,
// what counts as an answer, and what a person sees while it is being saved
// or after it failed.

import { html, LitElement, nothing, type CSSResultGroup, type TemplateResult } from 'lit';

import { httpClient, isExpiry, type OnboardingClient } from './api/client.js';
import { WALLET_METHOD, type OnboardingSession, type WalletChallenge } from './api/contract.js';
import { readWalletDestination } from './destination.js';
import { resolveLocale, translator, type MessageKey, type Translate } from './i18n/catalogue.js';
import { afterProofFailed, afterSaveFailed } from './outcomes.js';
import {
  connectsItself,
  findProblem,
  initialAnswers,
  isQuestionStep,
  nextStep,
  previousStep,
  shortLabel,
  stepCount,
  stepNumber,
  type Answers,
  type ConnectedWallet,
  type StepId,
  type WalletChoice,
} from './steps.js';
import type { ThemeMode } from './theme/defaults.js';
import { widgetStyles } from './theme/styles.js';
import { footer } from './views/footer.js';
import { textButton } from './views/parts.js';
import {
  stepView,
  waitingView,
  type Signer,
  type StepContext,
  type Waiting,
} from './views/step-views.js';
import {
  albedoAddress,
  albedoSign,
  freighterAddress,
  freighterSign,
  WalletRefused,
  type SignedMessage,
  type WalletConnector,
} from './wallet.js';

export const TAG_NAME = 'ujira-onboarding';

/** Fires whenever the step on screen changes. */
export const STEP_CHANGE_EVENT = 'ujira-step-change';

/** Fires once UJIRA has saved the address and the wallet has proved it. */
export const COMPLETE_EVENT = 'ujira-onboarding-complete';

export interface StepChangeDetail {
  step: StepId;
  /** Position in the progress line, or 0 on the confirmation screen. */
  position: number;
  total: number;
}

export interface CompleteDetail {
  wallet: WalletChoice;
  destination: string;
  memo: string;
  /** The saved method's id at UJIRA. */
  methodId: string;
}

/** How the widget picks its colours when the integrator sets none. */
export type WidgetMode = ThemeMode | 'system';

/** The http or https origin of a script address, or empty for anything else. */
export function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

/**
 * Where the API is when the page does not say: the origin the script was
 * loaded from, so the hosted file talks to the server that served it.
 */
const SCRIPT_ORIGIN = originOf(import.meta.url);

// Narrow views of two browser features the widget can do without: a page
// that has neither still renders, it just renders at rest.
interface Animatable {
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => unknown;
}

interface MotionAware {
  matchMedia?: (query: string) => { matches: boolean };
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

const LIFT = [
  { opacity: 0, transform: 'translateY(4px)' },
  { opacity: 1, transform: 'translateY(0)' },
];

type Loading = 'idle' | 'loading' | 'failed';

export class UjiraOnboarding extends LitElement {
  static override styles: CSSResultGroup = widgetStyles;

  static override properties = {
    mode: { type: String, reflect: true },
    locale: { type: String, reflect: true },
    token: { type: String },
    apiBase: { type: String, attribute: 'api-base' },
    client: { attribute: false },
    wallet: { attribute: false },
    step: { state: true },
    answers: { state: true },
    message: { state: true },
    session: { state: true },
    loading: { state: true },
    stopped: { state: true },
    working: { state: true },
    challenge: { state: true },
    challengeFailed: { state: true },
    signature: { state: true },
    copied: { state: true },
  };

  /** light, dark, or system to follow the reader's setting. */
  declare mode: WidgetMode;

  /** A language tag. Empty follows the reader's browser; English until others ship. */
  declare locale: string;

  /** The embed token the integrator's server minted for this recipient. */
  declare token: string;

  /** Where the UJIRA API is. Empty means the origin the script came from. */
  declare apiBase: string;

  /** A client to use instead of one built from the token, such as a test's. */
  declare client: OnboardingClient | undefined;

  /** The page's own wallet connection, if it can sign for the recipient. */
  declare wallet: WalletConnector | undefined;

  declare private step: StepId;
  declare private answers: Answers;
  declare private message: MessageKey | '';
  declare private session: OnboardingSession | undefined;
  declare private loading: Loading;
  /** Why the widget cannot go on at all, such as an expired link. */
  declare private stopped: MessageKey | '';
  declare private working: MessageKey | '';
  declare private challenge: WalletChallenge | undefined;
  declare private challengeFailed: boolean;
  declare private signature: string;
  declare private copied: boolean;

  private problemField: 'answer' | 'memo' = 'answer';
  private methodId = '';
  private built: { key: string; client: OnboardingClient } | undefined;
  /** Counts session loads, so a stale answer never lands over a newer one. */
  private loads = 0;
  private loadedFrom: OnboardingClient | undefined;
  /** True when the last render came from moving between steps. */
  private moved = false;
  /** Whether focus was inside the widget just before this render. */
  private focusInside = false;

  constructor() {
    super();
    this.mode = 'light';
    this.locale = '';
    this.token = '';
    this.apiBase = '';
    this.client = undefined;
    this.wallet = undefined;
    this.step = 'wallet';
    this.answers = initialAnswers();
    this.message = '';
    this.session = undefined;
    this.loading = 'idle';
    this.stopped = '';
    this.working = '';
    this.challenge = undefined;
    this.challengeFailed = false;
    this.signature = '';
    this.copied = false;
  }

  /** The step on screen. */
  get currentStep(): StepId {
    return this.step;
  }

  /** The answers so far. */
  get currentAnswers(): Answers {
    return { ...this.answers };
  }

  /** Starts again from the first question with nothing filled in. */
  reset(): void {
    this.answers = initialAnswers();
    this.methodId = '';
    this.challenge = undefined;
    this.signature = '';
    this.goTo('wallet');
  }

  /** The client in use: the page's own, or one built from the token. */
  private get api(): OnboardingClient | undefined {
    if (this.client !== undefined) return this.client;
    const base = this.apiBase === '' ? SCRIPT_ORIGIN : this.apiBase;
    if (this.token === '' || base === '') return undefined;
    const key = `${base}\n${this.token}`;
    if (this.built?.key !== key) {
      this.built = { key, client: httpClient({ baseUrl: base, token: this.token }) };
    }
    return this.built.client;
  }

  private get signer(): Signer {
    const chosen = this.answers.wallet;
    if (connectsItself(chosen)) return chosen;
    return this.wallet === undefined ? 'manual' : 'page';
  }

  protected override willUpdate(): void {
    this.focusInside = (this.shadowRoot?.activeElement ?? null) !== null;
    const api = this.api;
    if (api !== undefined && api !== this.loadedFrom) {
      this.loadedFrom = api;
      void this.load(api);
    }
  }

  protected override render(): TemplateResult {
    const locale = resolveLocale(
      this.locale,
      this.ownerDocument.defaultView?.navigator.languages ?? [],
    );
    const t = translator(locale);
    const waiting = this.waiting();
    const body =
      waiting === undefined
        ? html`${this.chrome(t)} ${stepView(this.step, this.context(t))}`
        : waitingView(t, waiting);
    return html`<section
      class="widget"
      part="widget"
      lang=${locale}
      aria-label=${t('widget.label')}
    >
      ${body} ${footer(t('footer.byline'))}
    </section>`;
  }

  protected override updated(): void {
    const target = this.renderRoot.querySelector<HTMLElement>('[data-focus]');
    if (!this.moved) {
      // A render that took away the control in focus, such as Try again once
      // the message to sign arrives, hands focus back to the step's heading
      // instead of dropping it on the page. Focus elsewhere is left alone.
      if (this.focusInside && this.shadowRoot?.activeElement === null) target?.focus();
      return;
    }
    this.moved = false;
    target?.focus();
    const step: Animatable | null = this.renderRoot.querySelector('.step');
    const view: MotionAware | null = this.ownerDocument.defaultView;
    if (view?.matchMedia?.(REDUCED_MOTION).matches === true) return;
    step?.animate?.(LIFT, { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  }

  private context(t: Translate): StepContext {
    return {
      t,
      answers: this.answers,
      message: this.message === '' ? '' : t(this.message),
      problemField: this.problemField,
      busy: this.working !== '',
      ...(this.working === '' ? {} : { busyLabel: t(this.working) }),
      submit: (event: Event) => {
        event.preventDefault();
        void this.onSubmit();
      },
      change: (value: string) => {
        this.answers = { ...this.answers, destination: value };
        this.message = '';
      },
      changeMemo: (value: string) => {
        this.answers = { ...this.answers, memo: value };
        this.message = '';
      },
      choose: (choice: WalletChoice) => {
        this.answers = { wallet: choice, destination: '', memo: '' };
        this.message = '';
      },
      proof: {
        challenge: this.challenge,
        failed: this.challengeFailed,
        signer: this.signer,
        signature: this.signature,
        changeSignature: (value: string) => {
          this.signature = value;
          this.message = '';
        },
        copy: () => {
          this.copyMessage();
        },
        copied: this.copied,
      },
    };
  }

  private waiting(): Waiting | undefined {
    if (this.stopped !== '') return { kind: 'stopped', key: this.stopped };
    const api = this.api;
    if (api === undefined) return { kind: 'stopped', key: 'widget.notReady' };
    if (this.session !== undefined) return undefined;
    if (this.loading === 'failed') {
      return {
        kind: 'failed',
        retry: () => {
          void this.load(api);
        },
      };
    }
    return { kind: 'loading' };
  }

  private async load(api: OnboardingClient): Promise<void> {
    this.loads += 1;
    const ticket = this.loads;
    this.loading = 'loading';
    this.session = undefined;
    try {
      const session = await api.session();
      if (ticket !== this.loads) return;
      this.loading = 'idle';
      if (!session.methods.includes(WALLET_METHOD)) {
        this.stopped = 'widget.closed';
        return;
      }
      this.stopped = '';
      this.session = session;
      this.reset();
    } catch (error) {
      if (ticket !== this.loads) return;
      if (isExpiry(error)) this.stopped = 'widget.expired';
      this.loading = 'failed';
    }
  }

  private show(key: MessageKey, field: 'answer' | 'memo' = 'answer'): void {
    this.message = key;
    this.problemField = field;
  }

  private chrome(t: Translate): TemplateResult {
    const step = this.step;
    const total = stepCount();
    const reached = isQuestionStep(step) ? stepNumber(step) : total;
    const bars = html`<div class="bars" aria-hidden="true">
      ${Array.from({ length: total }, (_, index) => html`<i class=${index < reached ? 'on' : ''}></i>`)}
    </div>`;
    if (!isQuestionStep(step)) return bars;
    const back = previousStep(step);
    const backLabel = back === undefined ? undefined : shortLabel(back);
    return html`${bars}
      <div class="chrome" part="chrome">
        ${
          back === undefined || backLabel === undefined || this.working !== ''
            ? nothing
            : textButton({
                label: t('widget.back'),
                name: t('widget.back.name', { step: t(backLabel) }),
                press: () => {
                  this.goTo(back);
                },
              })
        }
        <p class="progress" part="progress" role="status">
          ${t('widget.progress', { step: String(stepNumber(step)), total: String(total) })}
        </p>
      </div>`;
  }

  private async onSubmit(): Promise<void> {
    if (this.working !== '') return;
    if (this.step === 'prove') return this.prove();
    const found = findProblem(this.step, this.answers, this.session?.neverPayable ?? []);
    if (found !== undefined) {
      this.show(found.key, found.field);
      return;
    }
    this.message = '';
    if (this.step === 'address') {
      const chosen = this.answers.wallet;
      return connectsItself(chosen) ? this.connect(chosen) : this.save();
    }
    this.goTo(nextStep(this.step));
  }

  /** Freighter or Albedo shares the address, read with the same rules as a typed one. */
  private async connect(wallet: ConnectedWallet): Promise<void> {
    const albedo = wallet === 'albedo';
    this.working = albedo ? 'connect.albedo.busy' : 'connect.busy';
    let address: string;
    try {
      address = await (albedo ? albedoAddress() : freighterAddress());
    } catch (error) {
      this.working = '';
      const fallback = albedo ? 'connect.albedo.declined' : 'connect.declined';
      this.show(error instanceof WalletRefused ? error.key : fallback);
      return;
    }
    this.working = '';
    const read = readWalletDestination(address, '', this.session?.neverPayable ?? []);
    if (!read.ok) {
      this.show(read.problem);
      return;
    }
    this.answers = { ...this.answers, destination: read.destination.address, memo: '' };
    await this.save();
  }

  /** Saves the address through UJIRA, then fetches the message to sign. */
  private async save(): Promise<void> {
    const api = this.api;
    const session = this.session;
    if (api === undefined || session === undefined) return;
    const memo = this.answers.memo.trim();
    this.working = 'widget.busy';
    try {
      const saved = await api.addMethod(session.recipientId, {
        method: WALLET_METHOD,
        destination: {
          network: session.network,
          address: this.answers.destination.trim(),
          ...(memo === '' ? {} : { memo }),
        },
      });
      this.methodId = saved.id;
      this.working = '';
      this.goTo('prove');
      await this.fetchChallenge();
    } catch (error) {
      this.working = '';
      const outcome = afterSaveFailed(error);
      if (outcome.kind === 'expired') {
        this.stopped = 'widget.expired';
        return;
      }
      this.show(outcome.key, outcome.field);
    }
  }

  private async fetchChallenge(): Promise<void> {
    const api = this.api;
    const session = this.session;
    if (api === undefined || session === undefined) return;
    this.challenge = undefined;
    this.challengeFailed = false;
    this.signature = '';
    this.copied = false;
    try {
      this.challenge = await api.createWalletChallenge(session.recipientId, this.methodId);
    } catch (error) {
      if (isExpiry(error)) {
        this.stopped = 'widget.expired';
        return;
      }
      this.challengeFailed = true;
      this.show('widget.loadFailed');
    }
  }

  /** The signature over the challenge, from whichever wallet signs. */
  private async sign(challenge: WalletChallenge): Promise<SignedMessage | MessageKey> {
    const address = this.answers.destination.trim();
    const signer = this.signer;
    if (signer === 'manual') {
      const signature = this.signature.trim();
      return signature === '' ? 'prove.signature.missing' : { signature };
    }
    const wallet = this.wallet;
    try {
      if (signer === 'freighter') return await freighterSign(challenge.message, address);
      if (signer === 'albedo') return await albedoSign(challenge.message, address);
      if (wallet === undefined) return 'prove.declined';
      return await wallet.signMessage(challenge.message, address);
    } catch (error) {
      return error instanceof WalletRefused ? error.key : 'prove.declined';
    }
  }

  /** Has the wallet sign the challenge, and sends the proof. */
  private async prove(): Promise<void> {
    const api = this.api;
    const session = this.session;
    const challenge = this.challenge;
    if (api === undefined || session === undefined) return;
    if (challenge === undefined) {
      this.message = '';
      await this.fetchChallenge();
      return;
    }
    this.working = 'prove.busy';
    const signed = await this.sign(challenge);
    if (typeof signed === 'string') {
      this.working = '';
      this.show(signed);
      return;
    }
    try {
      await api.submitWalletProof(session.recipientId, this.methodId, {
        challengeId: challenge.challengeId,
        message: challenge.message,
        nonce: challenge.nonce,
        signature: signed.signature,
        ...(signed.signer === undefined ? {} : { signer: signed.signer }),
      });
      this.working = '';
      this.complete();
    } catch (error) {
      this.working = '';
      const outcome = afterProofFailed(error);
      if (outcome.kind === 'expired') {
        this.stopped = 'widget.expired';
        return;
      }
      // A challenge is good for one try, so the next try gets a new one.
      await this.fetchChallenge();
      this.show(outcome.key);
    }
  }

  private copyMessage(): void {
    const text = this.challenge?.message;
    const clipboard = this.ownerDocument.defaultView?.navigator.clipboard;
    if (text === undefined || clipboard === undefined) return;
    // A refused copy changes nothing: the message is on screen to select.
    clipboard.writeText(text).then(
      () => {
        this.copied = true;
      },
      () => undefined,
    );
  }

  private complete(): void {
    const wallet = this.answers.wallet;
    if (wallet === '') return;
    this.dispatchEvent(
      new CustomEvent<CompleteDetail>(COMPLETE_EVENT, {
        detail: {
          wallet,
          destination: this.answers.destination.trim(),
          memo: this.answers.memo.trim(),
          methodId: this.methodId,
        },
        bubbles: true,
        composed: true,
      }),
    );
    this.goTo('done');
  }

  private goTo(step: StepId): void {
    if (step === this.step) return;
    this.step = step;
    this.message = '';
    this.moved = true;
    this.dispatchEvent(
      new CustomEvent<StepChangeDetail>(STEP_CHANGE_EVENT, {
        detail: {
          step,
          position: isQuestionStep(step) ? stepNumber(step) : 0,
          total: stepCount(),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
