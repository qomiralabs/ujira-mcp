// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The one way the widget talks to UJIRA. Everything goes through this
// interface, so the widget runs the same against the real API and against
// the fake the tests use.
//
// The HTTP client authenticates with the embed token the integrator's server
// minted for this one recipient. The token is meant for a browser: it reaches
// only that recipient, only for a short while, and it is never an API key.

import type * as z from 'zod/mini';

import {
  ErrorEnvelope,
  OnboardingSession,
  Problem,
  SavedMethod,
  WalletChallenge,
  WalletProofAccepted,
  WALLET_METHOD,
} from './contract.js';

export interface DestinationBody {
  network: string;
  address: string;
  /** A numeric memo, as text. Absent when there is none. */
  memo?: string;
}

export interface WalletProof {
  challengeId: string;
  message: string;
  nonce: string;
  signature: string;
  /** The key that signed, when it is not the account's own. */
  signer?: string;
}

export interface OnboardingClient {
  session(): Promise<OnboardingSession>;
  addMethod(
    recipientId: string,
    body: { method: typeof WALLET_METHOD; destination: DestinationBody },
  ): Promise<SavedMethod>;
  createWalletChallenge(recipientId: string, methodId: string): Promise<WalletChallenge>;
  submitWalletProof(
    recipientId: string,
    methodId: string,
    proof: WalletProof,
  ): Promise<WalletProofAccepted>;
}

/** The API said no, in its own words. */
export class ApiProblem extends Error {
  override readonly name = 'ApiProblem';
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.code);
    this.problem = problem;
  }
}

/** The answer could not be read: no network, or a body that is not the contract. */
export class ApiUnreachable extends Error {
  override readonly name = 'ApiUnreachable';
}

/**
 * The problem a client rejected with, read by shape rather than by class. A
 * client the page supplies is built from its own copy of this code, so its
 * ApiProblem is a different class from ours: what counts is that the error
 * carries a problem the contract can read.
 */
export function problemOf(error: unknown): Problem | undefined {
  if (error instanceof ApiProblem) return error.problem;
  if (typeof error !== 'object' || error === null || !('problem' in error)) return undefined;
  const parsed = Problem.safeParse(error.problem);
  return parsed.success ? parsed.data : undefined;
}

/** The embed token is no longer good. */
export function isExpiry(error: unknown): boolean {
  return problemOf(error)?.status === 401;
}

export interface HttpClientOptions {
  /** Where the API is, such as https://ujira.co; no trailing path. */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function httpClient(options: HttpClientOptions): OnboardingClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(
    schema: z.ZodMiniType<T>,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'omit',
      });
    } catch (error) {
      throw new ApiUnreachable('the request did not reach UJIRA', { cause: error });
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = ErrorEnvelope.safeParse(json);
      if (!envelope.success) {
        throw new ApiUnreachable(`status ${String(response.status)} without an error body`);
      }
      const { code, reason, requestId } = envelope.data.error;
      throw new ApiProblem({
        status: response.status,
        code,
        ...(reason === undefined ? {} : { reason }),
        ...(requestId === undefined ? {} : { requestId }),
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiUnreachable(`${path} answered outside its contract`);
    return parsed.data;
  }

  const recipient = (id: string): string => `/v1/embed/recipients/${segment(id)}`;
  const method = (id: string, methodId: string): string =>
    `${recipient(id)}/methods/${segment(methodId)}`;

  return {
    session: () => call(OnboardingSession, 'GET', '/v1/embed/onboarding'),
    // Built field by field, so nothing a caller adds to the body is sent.
    addMethod: (id, body) =>
      call(SavedMethod, 'POST', `${recipient(id)}/methods`, {
        method: body.method,
        destination: {
          network: body.destination.network,
          address: body.destination.address,
          ...(body.destination.memo === undefined
            ? {}
            : { memoType: 'id', memo: body.destination.memo }),
        },
      }),
    createWalletChallenge: (id, methodId) =>
      call(WalletChallenge, 'POST', `${method(id, methodId)}/wallet-challenges`),
    submitWalletProof: (id, methodId, proof) =>
      call(WalletProofAccepted, 'POST', `${method(id, methodId)}/wallet-proofs`, {
        challengeId: proof.challengeId,
        message: proof.message,
        nonce: proof.nonce,
        signature: proof.signature,
        ...(proof.signer === undefined ? {} : { signer: proof.signer }),
      }),
  };
}
