// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A stand in for the UJIRA API, for the unit tests and the browser test
// pages. It keeps the contract's rules: it refuses what the real onboarding
// refuses, answers with the same codes, and gives a challenge one try.
// Nothing here is imported by the widget itself.

import { readWalletDestination } from '../destination.js';
import {
  MEMO_UNSUPPORTED,
  WALLET_METHOD,
  type OnboardingSession,
  type ReceivabilityReason,
} from './contract.js';
import { ApiProblem, type OnboardingClient } from './client.js';

/** Testnet's USDC issuer, which is public. Paying it would burn the amount. */
export const FAKE_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** The one recipient the fake knows. */
export const FAKE_RECIPIENT = '6a1f0e1c-55a4-4f0e-9b65-2f9d6c3b8a10';

/** A signature the fake treats as made by the wrong key. */
export const WRONG_SIGNATURE = 'wrong-key';

export interface FakeScenario {
  /** The methods the session lists for the recipient. */
  methods: readonly string[];
  /** Why the wallet cannot receive, or null when it can. */
  receivability: ReceivabilityReason | null;
  /** Whether the signing key is a current signer of the account. */
  signerAuthorized: boolean;
}

export const BASE_SCENARIO: FakeScenario = {
  methods: [WALLET_METHOD],
  receivability: null,
  signerAuthorized: true,
};

function problem(status: number, code: string, reason?: string): ApiProblem {
  return new ApiProblem({
    status,
    code,
    requestId: 'req_fake_0001',
    ...(reason === undefined ? {} : { reason }),
  });
}

/** Runs a step and hands back its result or its refusal as a promise. */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** One call the fake answered, for tests to read. */
export interface FakeCall {
  name: keyof OnboardingClient;
  args: readonly unknown[];
}

export type FakeClient = OnboardingClient & { readonly calls: FakeCall[] };

export function fakeClient(scenario: Partial<FakeScenario> = {}): FakeClient {
  const world: FakeScenario = { ...BASE_SCENARIO, ...scenario };
  const calls: FakeCall[] = [];
  const methods = new Set<string>();
  const challenges = new Set<string>();
  let counter = 0;
  const next = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${String(counter).padStart(4, '0')}`;
  };
  const knownRecipient = (recipientId: string): void => {
    if (recipientId !== FAKE_RECIPIENT) throw problem(404, 'NOT_FOUND');
  };
  const knownMethod = (recipientId: string, methodId: string): void => {
    knownRecipient(recipientId);
    if (!methods.has(methodId)) throw problem(404, 'NOT_FOUND');
  };
  const session = (): OnboardingSession => ({
    recipientId: FAKE_RECIPIENT,
    network: 'stellar:testnet',
    methods: [...world.methods],
    neverPayable: [FAKE_ISSUER],
  });

  return {
    calls,
    session: () =>
      settle(() => {
        calls.push({ name: 'session', args: [] });
        return session();
      }),
    addMethod: (recipientId, body) =>
      settle(() => {
        calls.push({ name: 'addMethod', args: [recipientId, body] });
        knownRecipient(recipientId);
        if (!world.methods.includes(body.method)) throw problem(422, 'DESTINATION_INVALID');
        const read = readWalletDestination(body.destination.address, body.destination.memo ?? '', [
          FAKE_ISSUER,
        ]);
        if (!read.ok) {
          const memo = read.problem === 'destination.memo.unsupported';
          throw problem(422, 'DESTINATION_INVALID', memo ? MEMO_UNSUPPORTED : undefined);
        }
        const id = next('method');
        methods.add(id);
        return { id, method: body.method, status: 'active' as const };
      }),
    createWalletChallenge: (recipientId, methodId) =>
      settle(() => {
        calls.push({ name: 'createWalletChallenge', args: [recipientId, methodId] });
        knownMethod(recipientId, methodId);
        const challengeId = next('challenge');
        challenges.add(challengeId);
        return {
          challengeId,
          message: `ujira.co asks you to confirm your payout address.\nNonce: ${challengeId}`,
          nonce: challengeId,
          expiresAt: '2026-11-26T12:05:00.000Z',
        };
      }),
    submitWalletProof: (recipientId, methodId, proof) =>
      settle(() => {
        calls.push({ name: 'submitWalletProof', args: [recipientId, methodId, proof] });
        knownMethod(recipientId, methodId);
        if (!challenges.delete(proof.challengeId)) throw problem(422, 'WALLET_PROOF_EXPIRED');
        if (proof.signature === WRONG_SIGNATURE) throw problem(422, 'WALLET_PROOF_INVALID');
        if (!world.signerAuthorized) throw problem(422, 'WALLET_SIGNER_NOT_AUTHORIZED');
        if (world.receivability !== null) {
          throw problem(422, 'DESTINATION_NOT_RECEIVABLE', world.receivability);
        }
        return { verificationId: next('verification'), level: 'wallet_signature' as const };
      }),
  };
}
