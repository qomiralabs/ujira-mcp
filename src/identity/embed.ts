// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the onboarding widget does for a recipient, and how a project hands
// it out. A project makes a short lived embed session for one of its
// recipients and gets the token once; only the token's hash is kept. The
// widget, holding that token, can read what onboarding needs and save the
// recipient's wallet, and nothing else.
//
// A wallet saved here is unproven. Proving it belongs to the recipient, and
// marking it verified, is the wallet proof's job, which runs on the same
// token after this.

import { callOptions, ChainError, type ChainAdapter } from '../chain/adapter.js';
import {
  constraintViolation,
  embedSessions,
  embedSettings,
  payoutMethods,
  recipients,
  type Database,
  type EmbedSession,
  type Page,
  type PayoutMethod,
  type ProjectContext,
  type StorableCheck,
} from '../db/index.js';
import type { EmbedCaller } from '../auth/embed-auth.js';
import { issueEmbedToken } from '../auth/embed-token.js';
import type { TokenEnvironment } from '../auth/token.js';

export type EmbedErrorCode =
  | 'RECIPIENT_NOT_FOUND'
  | 'RECIPIENT_SUSPENDED'
  | 'SESSION_NOT_FOUND'
  | 'DESTINATION_INVALID'
  | 'CHAIN_UNAVAILABLE';

/** Narrows DESTINATION_INVALID for the widget, which tells the person what to fix. */
export type DestinationProblem = 'MEMO_UNSUPPORTED';

export class EmbedError extends Error {
  override readonly name = 'EmbedError';
  readonly reason: DestinationProblem | undefined;

  constructor(
    readonly code: EmbedErrorCode,
    message: string,
    options: { reason?: DestinationProblem; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.reason = options.reason;
  }
}

/** The one method this build offers, as the widget names it. */
export const WALLET_METHOD = 'stellar_wallet' as const;

/** The default life of an embed session: long enough to finish, short enough to lapse soon. */
export const DEFAULT_EMBED_SESSION_SECONDS = 30 * 60;

export interface NewSessionInput {
  readonly recipientId: string;
  readonly expiresInSeconds: number;
}

export interface SessionListQuery {
  readonly recipientId?: string | undefined;
  readonly after?: string | undefined;
  readonly limit: number;
}

export interface CreatedEmbedSession {
  readonly session: EmbedSession;
  /** Shown once. Only its hash is stored. */
  readonly token: string;
}

export interface EmbedSessionService {
  create(context: ProjectContext, input: NewSessionInput): Promise<CreatedEmbedSession>;
  list(context: ProjectContext, query: SessionListQuery): Promise<Page<EmbedSession>>;
  /** Revoking twice is the same as once. */
  revoke(context: ProjectContext, id: string): Promise<EmbedSession>;
  allowedOrigins(context: ProjectContext): Promise<string[]>;
  setAllowedOrigins(context: ProjectContext, origins: readonly string[]): Promise<string[]>;
}

export interface OnboardingView {
  readonly recipientId: string;
  readonly network: string;
  readonly methods: readonly string[];
  readonly neverPayable: readonly string[];
}

export interface WalletDestinationInput {
  readonly network: string;
  readonly address: string;
  readonly memo?: string | undefined;
}

export interface EmbedOnboardingService {
  onboarding(caller: EmbedCaller): Promise<OnboardingView>;
  addWallet(
    caller: EmbedCaller,
    recipientId: string,
    destination: WalletDestinationInput,
    correlationId: string,
  ): Promise<PayoutMethod>;
}

export interface EmbedServiceOptions {
  readonly db: Database;
  readonly chain: ChainAdapter;
  readonly environment: TokenEnvironment;
  /** The asset a wallet must be able to take, as the adapter's destination check takes it. */
  readonly destinationAsset: string;
  /** Addresses a payout would burn, such as the asset's issuer. */
  readonly neverPayable: readonly string[];
  readonly chainTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

const DESTINATION_CONSTRAINT = 'payout_methods_destination_per_recipient';

function tenantOf(caller: EmbedCaller): ProjectContext {
  return { principalId: caller.principalId, projectId: caller.projectId };
}

function invalidDestination(message: string, reason?: DestinationProblem, cause?: unknown) {
  return new EmbedError('DESTINATION_INVALID', message, {
    ...(reason === undefined ? {} : { reason }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export function createEmbedSessionService(
  o: Pick<EmbedServiceOptions, 'db' | 'environment'>,
): EmbedSessionService {
  return {
    async create(context, input) {
      const issued = issueEmbedToken(o.environment);
      const session = await o.db.tenant(context).transaction(async (tx) => {
        // Read under the caller's tenant, so another project's recipient
        // reads as not there.
        const recipient = await recipients.get(tx, input.recipientId);
        if (recipient === undefined) {
          throw new EmbedError('RECIPIENT_NOT_FOUND', 'no such recipient in this project');
        }
        if (recipient.status === 'suspended') {
          throw new EmbedError('RECIPIENT_SUSPENDED', 'payouts to this recipient are on hold');
        }
        return embedSessions.create(tx, {
          recipientId: recipient.id,
          tokenSha256: issued.secretSha256,
          lifetimeSeconds: input.expiresInSeconds,
        });
      });
      return { session, token: issued.token };
    },

    list(context, query) {
      return o.db.tenant(context).transaction((tx) =>
        embedSessions.list(tx, {
          limit: query.limit,
          ...(query.recipientId === undefined ? {} : { recipientId: query.recipientId }),
          ...(query.after === undefined ? {} : { after: query.after }),
        }),
      );
    },

    async revoke(context, id) {
      const session = await o.db.tenant(context).transaction((tx) => embedSessions.revoke(tx, id));
      if (session === undefined) {
        throw new EmbedError('SESSION_NOT_FOUND', 'no such embed session in this project');
      }
      return session;
    },

    allowedOrigins(context) {
      return o.db.tenant(context).transaction((tx) => embedSettings.allowedOrigins(tx));
    },

    setAllowedOrigins(context, origins) {
      return o.db
        .tenant(context)
        .transaction((tx) => embedSettings.setAllowedOrigins(tx, [...new Set(origins)]));
    },
  };
}

export function createEmbedOnboardingService(o: EmbedServiceOptions): EmbedOnboardingService {
  const log = o.log ?? (() => undefined);

  // The recipient the token was made for, and only that one. Any other id
  // reads as not there, so a token cannot be used to learn which ids exist.
  function ownRecipient(caller: EmbedCaller, recipientId: string): void {
    if (recipientId !== caller.recipientId) {
      throw new EmbedError('RECIPIENT_NOT_FOUND', 'no such recipient for this token');
    }
  }

  function parseDestination(raw: string): string {
    try {
      return o.chain.parseAccount(raw);
    } catch (error) {
      if (error instanceof ChainError && error.code === 'INVALID_ADDRESS') {
        throw invalidDestination('the address is not an account address', undefined, error);
      }
      throw error;
    }
  }

  async function check(destination: string, correlationId: string): Promise<StorableCheck> {
    let answer: Awaited<ReturnType<ChainAdapter['checkDestination']>>;
    try {
      answer = await o.chain.checkDestination(
        destination,
        o.destinationAsset,
        callOptions(correlationId, o.chainTimeoutMs),
      );
    } catch (error) {
      if (
        error instanceof ChainError &&
        (error.code === 'TIMEOUT' || error.code === 'UNAVAILABLE')
      ) {
        throw new EmbedError('CHAIN_UNAVAILABLE', 'the chain did not answer in time', {
          cause: error,
        });
      }
      throw error;
    }
    if (answer.receivable) return answer;
    // A wallet payout sends no memo, so money sent to an address that needs
    // one would arrive without saying whose it is.
    if (answer.reason === 'NEEDS_MEMO') {
      throw invalidDestination('the address needs a memo', 'MEMO_UNSUPPORTED');
    }
    return { receivable: false, reason: answer.reason };
  }

  return {
    async onboarding(caller) {
      const recipient = await o.db
        .tenant(tenantOf(caller))
        .transaction((tx) => recipients.get(tx, caller.recipientId));
      if (recipient === undefined) {
        throw new EmbedError('RECIPIENT_NOT_FOUND', 'no such recipient for this token');
      }
      return {
        recipientId: recipient.id,
        network: o.chain.network,
        // A recipient on hold cannot be set up to be paid, so the widget is
        // offered nothing and says so.
        methods: recipient.status === 'suspended' ? [] : [WALLET_METHOD],
        neverPayable: o.neverPayable,
      };
    },

    async addWallet(caller, recipientId, input, correlationId) {
      ownRecipient(caller, recipientId);
      if (input.network !== o.chain.network) {
        throw invalidDestination('the destination is on a network not served here');
      }
      if (input.memo !== undefined) {
        throw invalidDestination('a wallet payout sends no memo', 'MEMO_UNSUPPORTED');
      }
      const destination = parseDestination(input.address);
      if (o.neverPayable.includes(destination)) {
        throw invalidDestination('a payout to this address would be lost');
      }
      const tenant = tenantOf(caller);
      const existing = await o.db.tenant(tenant).transaction(async (tx) => {
        const recipient = await recipients.get(tx, recipientId);
        if (recipient === undefined) {
          throw new EmbedError('RECIPIENT_NOT_FOUND', 'no such recipient for this token');
        }
        if (recipient.status === 'suspended') {
          throw new EmbedError('RECIPIENT_SUSPENDED', 'payouts to this recipient are on hold');
        }
        const methods = await payoutMethods.forRecipients(tx, [recipientId]);
        return methods.find((method) => method.destination === destination);
      });
      // Saving the same wallet again, as a retry does, returns what was saved.
      if (existing !== undefined) return existing;
      const destinationCheck = await check(destination, correlationId);
      try {
        return await o.db
          .tenant(tenant)
          .transaction((tx) =>
            payoutMethods.addWallet(
              tx,
              { recipientId, destination, destinationCheck, verified: false },
              o.chain,
            ),
          );
      } catch (error) {
        const violation = constraintViolation(error);
        if (violation?.kind !== 'unique' || violation.constraint !== DESTINATION_CONSTRAINT) {
          throw error;
        }
        // Two saves of one wallet at once: the other one won, and its row is the answer.
        log(`event=embed_wallet_saved_twice correlationId=${correlationId}`);
        const saved = await o.db
          .tenant(tenant)
          .transaction((tx) => payoutMethods.forRecipients(tx, [recipientId]));
        const found = saved.find((method) => method.destination === destination);
        if (found === undefined) throw error;
        return found;
      }
    },
  };
}
