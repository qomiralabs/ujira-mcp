// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { encodeAccountAddress } from './destination.js';
import {
  connectsItself,
  findProblem,
  initialAnswers,
  isQuestionStep,
  isWalletChoice,
  nextStep,
  previousStep,
  QUESTION_STEPS,
  shortLabel,
  stepCount,
  stepNumber,
  STEP_IDS,
  WALLET_CHOICES,
} from './steps.js';

const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));

describe('the steps', () => {
  it('are choose the wallet, give the address, prove it, then done', () => {
    expect(STEP_IDS).toEqual(['wallet', 'address', 'prove', 'done']);
    expect(QUESTION_STEPS).toEqual(['wallet', 'address', 'prove']);
    expect(stepCount()).toBe(3);
    expect(QUESTION_STEPS.map((step) => stepNumber(step))).toEqual([1, 2, 3]);
    expect(isQuestionStep('done')).toBe(false);
  });

  it('go forward in order, and back only from the address', () => {
    expect(nextStep('wallet')).toBe('address');
    expect(nextStep('address')).toBe('prove');
    expect(nextStep('prove')).toBe('done');
    expect(nextStep('done')).toBe('done');
    expect(previousStep('wallet')).toBeUndefined();
    expect(previousStep('address')).toBe('wallet');
    // The address is saved by then and cannot be unsaved.
    expect(previousStep('prove')).toBeUndefined();
    expect(previousStep('done')).toBeUndefined();
  });

  it('name the steps Back can return to', () => {
    expect(shortLabel('wallet')).toBe('step.wallet.short');
    expect(shortLabel('address')).toBe('step.address.short');
    expect(shortLabel('prove')).toBeUndefined();
  });

  it('start with nothing chosen', () => {
    expect(initialAnswers()).toEqual({ wallet: '', destination: '', memo: '' });
    expect(isWalletChoice('freighter')).toBe(true);
    expect(isWalletChoice('albedo')).toBe(true);
    expect(isWalletChoice('other')).toBe(true);
    expect(isWalletChoice('xbull')).toBe(false);
  });

  it('offer Freighter, Albedo, then any other wallet', () => {
    expect(WALLET_CHOICES).toEqual(['freighter', 'albedo', 'other']);
    expect(connectsItself('freighter')).toBe(true);
    expect(connectsItself('albedo')).toBe(true);
    expect(connectsItself('other')).toBe(false);
  });
});

describe('the check before a step is left', () => {
  it('wants a wallet chosen', () => {
    expect(findProblem('wallet', initialAnswers())).toEqual({
      key: 'wallet.missing',
      field: 'answer',
    });
    expect(findProblem('wallet', { ...initialAnswers(), wallet: 'other' })).toBeUndefined();
  });

  it('reads a typed address and memo in full', () => {
    const typed = { wallet: 'other' as const, destination: WALLET, memo: '' };
    expect(findProblem('address', typed)).toBeUndefined();
    expect(findProblem('address', { ...typed, destination: '' })?.key).toBe(
      'destination.wallet.missing',
    );
    expect(findProblem('address', { ...typed, memo: 'abc' })).toEqual({
      key: 'destination.memo.unsupported',
      field: 'memo',
    });
    expect(findProblem('address', typed, [WALLET])?.key).toBe('destination.wallet.unpayable');
  });

  it('has nothing to read with Freighter or Albedo, whose address arrives as the step is left', () => {
    expect(findProblem('address', { wallet: 'freighter', destination: '', memo: '' })).toBe(
      undefined,
    );
    expect(findProblem('address', { wallet: 'albedo', destination: '', memo: '' })).toBe(undefined);
    expect(findProblem('prove', initialAnswers())).toBeUndefined();
  });
});
