// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// One receipt per task, kept in a local JSON file. Amounts are written as
// decimal strings and read back as bigint, so no float ever holds one.
// Writes go to a temporary file that is renamed over the log, so a crash
// leaves either the old log or the new one, never half of one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { EngineError } from '../errors.js';
import { hex32 } from '../ids.js';
import { RAIL_NAMES } from '../rails/rail.js';

/**
 * `settling` means the mandate paid but the rail has not finished, such as
 * SDP not having paid the person yet. Requesting the task again finishes it.
 */
export const OUTCOMES = [
  'paid',
  'blocked',
  'approval_required',
  'approved_then_paid',
  'settling',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

const txHash = z.string().regex(/^[0-9a-f]{64}$/);

const receiptSchema = z.object({
  task_id: z.string().min(1),
  mandate: z.string(),
  principal: z.string(),
  agent: z.string(),
  network: z.string(),
  recipient: z.string(),
  destination: z.string(),
  amount: z
    .string()
    .regex(/^[0-9]+$/)
    .transform((s) => BigInt(s)),
  asset: z.string(),
  rail: z.enum(RAIL_NAMES),
  outcome: z.enum(OUTCOMES),
  reason: z.string().optional(),
  /** How a block was decided: by the quote alone, or by the contract itself. */
  blocked_by: z.enum(['quote', 'contract']).optional(),
  contract_error: z.number().int().optional(),
  payout_id: hex32.optional(),
  tx_hash: txHash.optional(),
  request_tx_hash: txHash.optional(),
  sdp_disbursement_id: z.string().optional(),
  sdp_payment_id: z.string().optional(),
  /** The transaction in which SDP paid the person; `tx_hash` is the mandate's. */
  sdp_tx_hash: txHash.optional(),
  /** While settling: the outcome the payout gets once the rail finishes. */
  settles_as: z.enum(['paid', 'approved_then_paid']).optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Receipt = z.output<typeof receiptSchema>;

const fileSchema = z.object({ version: z.literal(1), receipts: z.array(receiptSchema) });

export function receiptToJson(r: Receipt): Record<string, unknown> {
  return { ...r, amount: r.amount.toString() };
}

export interface ReceiptFilter {
  readonly taskId?: string;
  readonly outcome?: Outcome;
  readonly limit?: number;
}

export class ReceiptLog {
  readonly path: string;
  /** Serializes every read-modify-write in this process. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  private async load(): Promise<Receipt[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw new EngineError('config_invalid', 'the receipt log cannot be read', { cause: error });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new EngineError('config_invalid', 'the receipt log is not valid JSON', {
        cause: error,
      });
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      throw new EngineError('config_invalid', 'the receipt log is not in the expected format');
    }
    return parsed.data.receipts;
  }

  private async save(receipts: readonly Receipt[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${String(process.pid)}.tmp`;
    const body = { version: 1, receipts: receipts.map(receiptToJson) };
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Inserts the receipt, or replaces the one for the same mandate and task. */
  upsert(receipt: Receipt): Promise<Receipt> {
    return this.serial(async () => {
      const all = await this.load();
      const i = all.findIndex(
        (r) => r.mandate === receipt.mandate && r.task_id === receipt.task_id,
      );
      if (i === -1) all.push(receipt);
      else all[i] = receipt;
      await this.save(all);
      return receipt;
    });
  }

  find(mandate: string, taskId: string): Promise<Receipt | undefined> {
    return this.serial(async () =>
      (await this.load()).find((r) => r.mandate === mandate && r.task_id === taskId),
    );
  }

  /** Newest first. Only receipts of `mandate`, so one log can serve several. */
  list(mandate: string, filter: ReceiptFilter = {}): Promise<Receipt[]> {
    return this.serial(async () => {
      const mine = (await this.load()).filter(
        (r) =>
          r.mandate === mandate &&
          (filter.taskId === undefined || r.task_id === filter.taskId) &&
          (filter.outcome === undefined || r.outcome === filter.outcome),
      );
      // Reversed first, so receipts updated in the same instant keep newest first.
      mine.reverse();
      mine.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return filter.limit === undefined ? mine : mine.slice(0, filter.limit);
    });
  }
}
