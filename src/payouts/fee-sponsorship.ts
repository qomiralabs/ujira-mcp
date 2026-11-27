// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Sends the transactions principals sign with the fee paid by UJIRA's fee
// sponsor, so a principal never needs XLM. Each principal may use the sponsor
// up to a daily cap, across all of its projects, kept in the database so every
// instance of the server sees the same total.
//
// The fee is reserved at the fee bump's maximum before the transaction leaves
// and settled at what the network charged once it is final. A principal past
// its cap gets a refusal that says when the day turns, and nothing is sent.
// The sponsor's own balance is watched by the server's alert watch, which
// writes fee_sponsor_low.

import { z } from 'zod';

import {
  type CallOptions,
  type ChainAdapter,
  type FeeBudget,
  type Hex32,
  type SigningRequest,
  type SubmitResult,
} from '../chain/adapter.js';
import { feeSponsorships, type Database, type ProjectContext } from '../db/index.js';
import { EngineError } from '../errors.js';
import { errorCode, logLine, type Log } from '../log.js';
import { FeeSponsorCapError } from './errors.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface FeeSponsorSettings {
  /** Stroops each principal may have the sponsor pay in one UTC day. */
  readonly dailyCap: bigint;
}

// Five XLM a day covers dozens of mandate actions at testnet prices, where a
// resource fee is well under one XLM, and bounds what one principal can cost.
export const DEFAULT_FEE_SPONSOR_DAILY_CAP = 50_000_000n;

// The network's fees are signed 64 bit integers.
const INT64_MAX = (1n << 63n) - 1n;

const stroops = z
  .string()
  .regex(/^\d{1,19}$/)
  .transform((s) => BigInt(s))
  .refine((n) => n >= 1n && n <= INT64_MAX);

const settingsSchema = z.object({
  UJIRA_FEE_SPONSOR_DAILY_CAP: stroops.optional(),
});

export function loadFeeSponsorSettings(env: Env = process.env): FeeSponsorSettings {
  const present = Object.fromEntries(
    Object.keys(settingsSchema.shape).flatMap((k) =>
      env[k] === undefined || env[k] === '' ? [] : [[k, env[k]]],
    ),
  );
  const parsed = settingsSchema.safeParse(present);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new EngineError('config_invalid', `${names} must be a whole number of stroops above 0`);
  }
  return { dailyCap: parsed.data.UJIRA_FEE_SPONSOR_DAILY_CAP ?? DEFAULT_FEE_SPONSOR_DAILY_CAP };
}

export type FeeReservation =
  | { readonly kind: 'reserved' | 'replay'; readonly used: bigint }
  | { readonly kind: 'capped'; readonly used: bigint };

/** Where the daily totals live: the database in the server, memory in tests. */
export interface FeeLedger {
  reserve(
    tenant: ProjectContext,
    entry: {
      readonly innerTxHash: Hex32;
      readonly day: string;
      readonly maxFee: bigint;
      readonly dailyCap: bigint;
    },
  ): Promise<FeeReservation>;
  settle(
    tenant: ProjectContext,
    entry: { readonly innerTxHash: Hex32; readonly charged: bigint },
  ): Promise<boolean>;
  release(tenant: ProjectContext, entry: { readonly innerTxHash: Hex32 }): Promise<boolean>;
}

/** The ledger on the fee sponsorship tables, one short tenant transaction per call. */
export function databaseFeeLedger(db: Database): FeeLedger {
  return {
    reserve: (tenant, entry) =>
      db.tenant(tenant).transaction((tx) => feeSponsorships.reserve(tx, entry)),
    settle: (tenant, entry) =>
      db.tenant(tenant).transaction((tx) => feeSponsorships.settle(tx, entry)),
    release: (tenant, entry) =>
      db.tenant(tenant).transaction((tx) => feeSponsorships.release(tx, entry)),
  };
}

const DAY_MS = 86_400_000;

/** The UTC day of a moment, as YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole seconds until the next UTC midnight, at least one. */
export function secondsToNextUtcDay(ms: number): number {
  const next = (Math.floor(ms / DAY_MS) + 1) * DAY_MS;
  return Math.max(1, Math.ceil((next - ms) / 1000));
}

export interface SponsoredSubmitterOptions {
  readonly adapter: ChainAdapter;
  readonly ledger: FeeLedger;
  readonly settings: FeeSponsorSettings;
  readonly log: Log;
  /** Milliseconds since the epoch; the server clock unless a test sets one. */
  readonly now?: () => number;
}

export class SponsoredSubmitter {
  private readonly o: SponsoredSubmitterOptions;
  private readonly now: () => number;

  constructor(options: SponsoredSubmitterOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Checks the envelope against its signing request, then relays it inside a
   * fee bump charged to the tenant's principal. Throws FeeSponsorCapError past
   * the cap, before anything is sent, and the adapter's ChainError otherwise.
   */
  submit(
    tenant: ProjectContext,
    signedXdr: string,
    expected: SigningRequest,
    o: CallOptions,
  ): Promise<SubmitResult> {
    const at = this.now();
    const day = utcDay(at);
    const { ledger, settings, log } = this.o;
    const budget: FeeBudget = {
      reserve: async (fee) => {
        const got = await ledger.reserve(tenant, {
          innerTxHash: fee.innerTxHash,
          day,
          maxFee: fee.maxFee,
          dailyCap: settings.dailyCap,
        });
        if (got.kind === 'capped') {
          log(
            logLine('fee_sponsor_cap_reached', {
              principalId: tenant.principalId,
              projectId: tenant.projectId,
              day,
              usedStroops: got.used,
              maxFeeStroops: fee.maxFee,
              capStroops: settings.dailyCap,
            }),
          );
          throw new FeeSponsorCapError(secondsToNextUtcDay(at));
        }
      },
      settle: async (fee, charged) => {
        try {
          await ledger.settle(tenant, { innerTxHash: fee.innerTxHash, charged });
        } catch (error) {
          // The reservation stays at its maximum, which only ever overcounts.
          log(
            logLine('fee_sponsor_settle_failed', {
              principalId: tenant.principalId,
              projectId: tenant.projectId,
              innerTxHash: fee.innerTxHash,
              error: errorCode(error),
            }),
          );
        }
      },
      release: async (fee) => {
        try {
          await ledger.release(tenant, { innerTxHash: fee.innerTxHash });
        } catch (error) {
          log(
            logLine('fee_sponsor_release_failed', {
              principalId: tenant.principalId,
              projectId: tenant.projectId,
              innerTxHash: fee.innerTxHash,
              error: errorCode(error),
            }),
          );
        }
      },
    };
    return this.o.adapter.submitSigned(signedXdr, expected, o, budget);
  }
}
