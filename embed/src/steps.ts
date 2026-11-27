// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The step framework: one question per step, the order they come in, and the
// check that runs before a step is left. Pure functions, so the flow can be
// tested without a browser.
//
// Three questions, then the confirmation: which wallet, the address (typed,
// or shared by Freighter or Albedo), and the signature that proves the wallet is the
// recipient's. The address is saved when the second step is left, so there
// is no going back from the third.

import { readWalletDestination } from './destination.js';
import type { MessageKey } from './i18n/catalogue.js';

/** Every screen. The last one is the confirmation, not a question. */
export const STEP_IDS = ['wallet', 'address', 'prove', 'done'] as const;

export type StepId = (typeof STEP_IDS)[number];

/** The questions, in order. */
export const QUESTION_STEPS: readonly StepId[] = ['wallet', 'address', 'prove'];

/**
 * How the person brings their wallet: Freighter in the browser, Albedo on
 * the web, or any other wallet, where they paste the address and sign by hand.
 */
export const WALLET_CHOICES = ['freighter', 'albedo', 'other'] as const;

export type WalletChoice = (typeof WALLET_CHOICES)[number];

/** The wallets the widget connects to itself: they share the address and sign in one press. */
export type ConnectedWallet = Exclude<WalletChoice, 'other'>;

export function connectsItself(choice: WalletChoice | ''): choice is ConnectedWallet {
  return choice === 'freighter' || choice === 'albedo';
}

export interface Answers {
  /** Empty until a wallet is chosen. */
  wallet: WalletChoice | '';
  destination: string;
  /** A numeric memo for an exchange address, or empty. */
  memo: string;
}

export function initialAnswers(): Answers {
  return { wallet: '', destination: '', memo: '' };
}

export function isWalletChoice(value: string): value is WalletChoice {
  return (WALLET_CHOICES as readonly string[]).includes(value);
}

export function isQuestionStep(step: StepId): boolean {
  return QUESTION_STEPS.includes(step);
}

/** The 1 based position of a step in the progress line. */
export function stepNumber(step: StepId): number {
  return QUESTION_STEPS.indexOf(step) + 1;
}

export function stepCount(): number {
  return QUESTION_STEPS.length;
}

export function nextStep(step: StepId): StepId {
  const index = QUESTION_STEPS.indexOf(step);
  return index < 0 ? 'done' : (QUESTION_STEPS[index + 1] ?? 'done');
}

/** Where Back goes. Nowhere once the address is saved: it cannot be unsaved. */
export function previousStep(step: StepId): StepId | undefined {
  return step === 'address' ? 'wallet' : undefined;
}

const SHORT_LABELS: Readonly<Partial<Record<StepId, MessageKey>>> = {
  wallet: 'step.wallet.short',
  address: 'step.address.short',
};

/** Names the step in "Back to your wallet". */
export function shortLabel(step: StepId): MessageKey | undefined {
  return SHORT_LABELS[step];
}

/** A problem with an answer, and the field it belongs to. */
export interface AnswerProblem {
  key: MessageKey;
  field: 'answer' | 'memo';
}

/**
 * The problem with the current answer, or undefined when the step is ready
 * to be left. A typed address is read in full, with the server's rules; the
 * server reads it again and has the last word. With Freighter or Albedo
 * there is nothing typed to check: the address arrives when the step is left.
 */
export function findProblem(
  step: StepId,
  answers: Answers,
  neverPayable: readonly string[] = [],
): AnswerProblem | undefined {
  if (step === 'wallet') {
    return answers.wallet === '' ? { key: 'wallet.missing', field: 'answer' } : undefined;
  }
  if (step === 'address' && answers.wallet === 'other') {
    const read = readWalletDestination(answers.destination, answers.memo, neverPayable);
    return read.ok
      ? undefined
      : { key: read.problem, field: read.field === 'memo' ? 'memo' : 'answer' };
  }
  return undefined;
}
