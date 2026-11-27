// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Keeps every active mandate's ledger entries from archiving. Testnet
// mandates made today would otherwise lose their instance and the record of
// their balance within weeks, and every later transaction would pay to
// restore them first.
//
// Each run reads every entry's time to live before it sends anything, and
// only extends the ones under the threshold. An extension raises an entry
// well above the threshold, so a second run finds nothing to do: that read,
// not a stored marker, is what makes a repeated or overlapping run harmless.
// A run is bounded in how many mandates it reads and how many transactions
// it sends; mandates past the bound get their turn on the next run.

import { z } from 'zod';

import {
  ChainError,
  callOptions,
  type AllowEntry,
  type EntryKeeper,
  type KeptEntry,
  type KeptEntryKind,
  type TxSigner,
} from '../chain/adapter.js';
import { EngineError } from '../errors.js';

/** About one day of ledgers at five seconds each. */
const LEDGERS_PER_DAY = 17_280;

export interface KeepAliveSettings {
  readonly enabled: boolean;
  /** An entry with fewer ledgers left than this is extended. */
  readonly thresholdLedgers: number;
  /** How many ledgers ahead an extended entry then lives. */
  readonly extendToLedgers: number;
  readonly maxMandatesPerRun: number;
  readonly maxTransactionsPerRun: number;
  /** Entries in one transaction's footprint. */
  readonly keysPerTransaction: number;
  readonly intervalSeconds: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const count = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/)
    .transform((s) => Number.parseInt(s, 10))
    .pipe(z.int().min(min).max(max));

// Twenty days leaves room for weeks of missed runs before anything lapses,
// and sixty means each entry costs one extension about every forty days.
const settingsSchema = z
  .object({
    UJIRA_KEEPALIVE: z.enum(['on', 'off']).default('on'),
    UJIRA_KEEPALIVE_THRESHOLD_LEDGERS: count(1, 3_110_399).default(20 * LEDGERS_PER_DAY),
    UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS: count(2, 3_110_399).default(60 * LEDGERS_PER_DAY),
    UJIRA_KEEPALIVE_MANDATES_PER_RUN: count(1, 10_000).default(200),
    UJIRA_KEEPALIVE_TRANSACTIONS_PER_RUN: count(1, 1_000).default(50),
    UJIRA_KEEPALIVE_KEYS_PER_TRANSACTION: count(1, 50).default(25),
    UJIRA_KEEPALIVE_INTERVAL_SECONDS: count(60, 7 * 86_400).default(86_400),
  })
  .refine((s) => s.UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS > s.UJIRA_KEEPALIVE_THRESHOLD_LEDGERS, {
    path: ['UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS'],
  });

export function loadKeepAliveSettings(env: Env = process.env): KeepAliveSettings {
  const present = Object.fromEntries(
    Object.keys(settingsSchema.shape).flatMap((k) =>
      env[k] === undefined || env[k] === '' ? [] : [[k, env[k]]],
    ),
  );
  const parsed = settingsSchema.safeParse(present);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ');
    throw new EngineError(
      'config_invalid',
      `${names} must be a whole number in range, and the extension above the threshold`,
    );
  }
  const s = parsed.data;
  return {
    enabled: s.UJIRA_KEEPALIVE === 'on',
    thresholdLedgers: s.UJIRA_KEEPALIVE_THRESHOLD_LEDGERS,
    extendToLedgers: s.UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS,
    maxMandatesPerRun: s.UJIRA_KEEPALIVE_MANDATES_PER_RUN,
    maxTransactionsPerRun: s.UJIRA_KEEPALIVE_TRANSACTIONS_PER_RUN,
    keysPerTransaction: s.UJIRA_KEEPALIVE_KEYS_PER_TRANSACTION,
    intervalSeconds: s.UJIRA_KEEPALIVE_INTERVAL_SECONDS,
  };
}

/** A mandate to look after, with the allowlist pairs the registry knows for it. */
export interface KeepAliveMandate {
  readonly contract: string;
  readonly recipients: readonly AllowEntry[];
}

export interface MandateStatus {
  /** Neither revoked nor expired; a paused mandate can still be resumed and pay. */
  readonly active: boolean;
  /** The asset contract that holds the mandate's balance. */
  readonly asset: string;
}

export interface MandateWarning {
  readonly code: 'ledger_entries_archived';
  readonly message: string;
  readonly kinds: readonly KeptEntryKind[];
}

export interface KeepAliveOptions {
  readonly keeper: EntryKeeper;
  /** Every mandate to consider, asked afresh on each run. */
  readonly mandates: () => readonly KeepAliveMandate[];
  readonly status: (contract: string) => Promise<MandateStatus>;
  /** Contracts every mandate depends on, such as the factory: instance and code only. */
  readonly shared?: readonly string[];
  /** Pays for extensions and restores. Without it a run only reads and reports. */
  readonly payer?: TxSigner;
  readonly settings: KeepAliveSettings;
  readonly log: (line: string) => void;
  /** Per chain call. */
  readonly callTimeoutMs?: number;
}

export interface KeepAliveRun {
  /** Contracts whose entries were read. */
  readonly checked: number;
  /** Mandates passed over because they are revoked or expired. */
  readonly inactive: number;
  readonly failed: number;
  readonly archived: number;
  readonly restored: number;
  readonly extended: number;
  /** Entries that needed a transaction this run did not send. */
  readonly deferred: number;
  readonly transactions: readonly string[];
}

interface Tally {
  checked: number;
  inactive: number;
  failed: number;
  archived: number;
  restored: number;
  extended: number;
  deferred: number;
  transactions: string[];
  budget: number;
  /** Set once a send's outcome is unknown; nothing more is sent this run. */
  halted: boolean;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
}

const kindsOf = (entries: readonly KeptEntry[]) => [...new Set(entries.map((e) => e.kind))];

/** The error's code, and its finer reason when it has one; never its message. */
function codeOf(error: unknown): string {
  if (error instanceof ChainError) {
    return error.reason === undefined ? error.code : `${error.code} reason=${error.reason}`;
  }
  if (error instanceof EngineError) return error.code;
  return 'internal_error';
}

const ARCHIVED_MESSAGE =
  "Some of this mandate's ledger entries are archived on the network. Its next transaction restores them first, at a higher fee.";

export class MandateKeepAlive {
  private readonly o: KeepAliveOptions;
  private readonly warnings = new Map<string, MandateWarning>();
  private cursor = 0;
  private running: Promise<KeepAliveRun> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;

  constructor(options: KeepAliveOptions) {
    if (options.settings.extendToLedgers > options.keeper.maxExtendLedgers) {
      throw new EngineError(
        'config_invalid',
        `UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS is above the network's ${String(options.keeper.maxExtendLedgers)}`,
      );
    }
    this.o = options;
  }

  /** What a mandate's page should warn about, from the last run that read it. */
  warningsFor(contract: string): readonly MandateWarning[] {
    const w = this.warnings.get(contract);
    return w === undefined ? [] : [w];
  }

  /** The next slice of mandates, round robin, so every one gets its turn. */
  private nextBatch(): KeepAliveMandate[] {
    const byId = new Map<string, KeepAliveMandate>();
    for (const m of this.o.mandates()) {
      const known = byId.get(m.contract);
      byId.set(
        m.contract,
        known === undefined ? m : { ...m, recipients: [...known.recipients, ...m.recipients] },
      );
    }
    const all = [...byId.values()];
    const size = this.o.settings.maxMandatesPerRun;
    if (all.length <= size) {
      this.cursor = 0;
      return all;
    }
    const start = this.cursor % all.length;
    const out: KeepAliveMandate[] = [];
    for (let i = 0; i < size; i++) {
      const next = all[(start + i) % all.length];
      if (next !== undefined) out.push(next);
    }
    this.cursor = (start + size) % all.length;
    return out;
  }

  private opts(contract: string) {
    return callOptions(`keepalive:${contract}`, this.o.callTimeoutMs);
  }

  /** Sends one transaction a chunk, while the run's budget lasts. Returns the ids sent. */
  private async send(
    t: Tally,
    contract: string,
    entries: readonly KeptEntry[],
    action: 'restore' | 'extend',
  ): Promise<string[]> {
    const payer = this.o.payer;
    const done: string[] = [];
    for (const part of chunks(entries, this.o.settings.keysPerTransaction)) {
      if (payer === undefined || t.halted || t.budget <= 0) {
        t.deferred += part.length;
        continue;
      }
      t.budget -= 1;
      const ids = part.map((e) => e.id);
      try {
        const { txHash } =
          action === 'restore'
            ? await this.o.keeper.restore(ids, payer, this.opts(contract))
            : await this.o.keeper.extend(
                ids,
                this.o.settings.extendToLedgers,
                payer,
                this.opts(contract),
              );
        t.transactions.push(txHash);
        done.push(...ids);
        const event = action === 'restore' ? 'mandate_entry_restored' : 'mandate_entry_extended';
        const to = action === 'extend' ? ` ledgers=${String(this.o.settings.extendToLedgers)}` : '';
        this.o.log(
          `event=${event} contract=${contract} kinds=${kindsOf(part).join(',')} count=${String(part.length)}${to} tx=${txHash}`,
        );
      } catch (error) {
        t.failed += 1;
        t.deferred += part.length;
        const hash = error instanceof ChainError && error.txHash !== undefined ? error.txHash : '';
        // A send that timed out may still land, and the payer's next sequence
        // number is then unknown; the next run reads the chain and carries on.
        if (error instanceof ChainError && error.code === 'TIMEOUT') t.halted = true;
        this.o.log(
          `event=mandate_entry_${action}_failed contract=${contract} count=${String(part.length)} error=${codeOf(error)}${hash === '' ? '' : ` tx=${hash}`}`,
        );
      }
    }
    return done;
  }

  private async keep(
    t: Tally,
    contract: string,
    asset: string | null,
    recipients: readonly AllowEntry[],
  ): Promise<void> {
    const read = await this.o.keeper.entries({ contract, asset, recipients }, this.opts(contract));
    t.checked += 1;
    const archived = read.entries.filter((e) => e.state === 'archived');
    const lapsing = read.entries.filter(
      (e) => e.state === 'live' && e.ledgersLeft < this.o.settings.thresholdLedgers,
    );
    if (archived.length > 0) {
      t.archived += archived.length;
      this.o.log(
        `event=mandate_entry_archived contract=${contract} kinds=${kindsOf(archived).join(',')} count=${String(archived.length)}`,
      );
    }
    const restoredIds = new Set(await this.send(t, contract, archived, 'restore'));
    t.restored += restoredIds.size;
    // A restored entry comes back with the network's minimum time to live,
    // so it is extended along with the ones running low.
    const restored = archived.filter((e) => restoredIds.has(e.id));
    t.extended += (await this.send(t, contract, [...lapsing, ...restored], 'extend')).length;
    const still = archived.filter((e) => !restoredIds.has(e.id));
    if (still.length === 0) this.warnings.delete(contract);
    else {
      this.warnings.set(contract, {
        code: 'ledger_entries_archived',
        message: ARCHIVED_MESSAGE,
        kinds: kindsOf(still),
      });
    }
  }

  private async pass(): Promise<KeepAliveRun> {
    const t: Tally = {
      checked: 0,
      inactive: 0,
      failed: 0,
      archived: 0,
      restored: 0,
      extended: 0,
      deferred: 0,
      transactions: [],
      budget: this.o.settings.maxTransactionsPerRun,
      halted: false,
    };
    // One payer, one sequence number: everything here runs one at a time.
    for (const contract of this.o.shared ?? []) {
      try {
        await this.keep(t, contract, null, []);
      } catch (error) {
        t.failed += 1;
        this.o.log(`event=mandate_keepalive_failed contract=${contract} error=${codeOf(error)}`);
      }
    }
    for (const m of this.nextBatch()) {
      try {
        const status = await this.o.status(m.contract);
        if (!status.active) {
          t.inactive += 1;
          this.warnings.delete(m.contract);
          continue;
        }
        await this.keep(t, m.contract, status.asset, m.recipients);
      } catch (error) {
        t.failed += 1;
        this.o.log(`event=mandate_keepalive_failed contract=${m.contract} error=${codeOf(error)}`);
      }
    }
    const run: KeepAliveRun = {
      checked: t.checked,
      inactive: t.inactive,
      failed: t.failed,
      archived: t.archived,
      restored: t.restored,
      extended: t.extended,
      deferred: t.deferred,
      transactions: t.transactions,
    };
    this.o.log(
      `event=mandate_keepalive_run checked=${String(run.checked)} inactive=${String(run.inactive)} failed=${String(run.failed)} archived=${String(run.archived)} restored=${String(run.restored)} extended=${String(run.extended)} deferred=${String(run.deferred)} transactions=${String(run.transactions.length)}${this.o.payer === undefined ? ' payer=none' : ''}`,
    );
    return run;
  }

  /** One run; a call while one is in flight shares it. */
  runOnce(): Promise<KeepAliveRun> {
    if (this.running !== undefined) return this.running;
    const settled = this.pass().finally(() => {
      this.running = undefined;
    });
    this.running = settled;
    return settled;
  }

  /**
   * Runs shortly after start and then every interval. A deploy restarts the
   * process more often than once a day, so waiting a full interval first
   * could mean never running; an extra run only reads. Timers never keep
   * the process alive.
   */
  start(firstDelayMs = 60_000): void {
    if (this.timer !== undefined || !this.o.settings.enabled) return;
    const tick = () => {
      this.runOnce().catch((error: unknown) => {
        this.o.log(`event=mandate_keepalive_failed error=${codeOf(error)}`);
      });
    };
    this.first = setTimeout(tick, firstDelayMs);
    this.first.unref();
    this.timer = setInterval(tick, this.o.settings.intervalSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.first !== undefined) clearTimeout(this.first);
    if (this.timer !== undefined) clearInterval(this.timer);
    this.first = undefined;
    this.timer = undefined;
  }
}
