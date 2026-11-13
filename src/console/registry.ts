// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the console remembers that the chain does not tell it: which mandates
// it created and for whom, the names people gave their recipients, and which
// addresses already took from the faucet. One JSON file in the data
// directory, read once at start and rewritten whole on each change, through
// a temporary file and a rename so a crash never leaves half a file.
//
// Everything here is public on chain anyway except the labels, which the
// mandate's owner typed and which only ever go back to whoever asks about
// that mandate.

import { mkdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { EngineError } from '../errors.js';
import { accountAddress, contractAddress, hex32 } from '../ids.js';

/** Bounds that keep the file small whatever a flood of callers does. */
export const MAX_MANDATES = 50_000;
export const MAX_RECIPIENTS = 50;
export const MAX_FAUCET_CLAIMS = 200_000;

const txHash = z.string().regex(/^[0-9a-f]{64}$/);

const recipientSchema = z.object({
  label: z.string().min(1).max(64),
  address: accountAddress,
  recipientRef: hex32,
});

const mandateSchema = z.object({
  id: contractAddress,
  principal: accountAddress,
  createdAt: z.string(),
  createTx: txHash,
  recipients: z.array(recipientSchema),
});

const claimSchema = z.object({ address: accountAddress, hash: txHash, at: z.string() });

const fileSchema = z.object({
  version: z.literal(1),
  mandates: z.array(mandateSchema),
  faucet: z.array(claimSchema),
});

export type RecipientEntry = z.infer<typeof recipientSchema>;
export type MandateEntry = z.infer<typeof mandateSchema>;
export type FaucetClaim = z.infer<typeof claimSchema>;
type RegistryFile = z.infer<typeof fileSchema>;

function load(path: string): RegistryFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, mandates: [], faucet: [] };
    }
    throw new EngineError('config_invalid', 'the console registry cannot be read', {
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new EngineError('config_invalid', 'the console registry is not valid JSON', {
      cause: error,
    });
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new EngineError('config_invalid', 'the console registry is not in the expected format');
  }
  return parsed.data;
}

export class ConsoleRegistry {
  readonly path: string;
  private data: RegistryFile;
  private readonly byId = new Map<string, MandateEntry>();
  private readonly claims = new Map<string, FaucetClaim>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, data: RegistryFile) {
    this.path = path;
    this.data = data;
    this.index();
  }

  /** Reads the registry, or starts an empty one; fails at start if the directory cannot be made. */
  static open(path: string): ConsoleRegistry {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      throw new EngineError('config_invalid', 'the console data directory cannot be created', {
        cause: error,
      });
    }
    return new ConsoleRegistry(path, load(path));
  }

  private index() {
    this.byId.clear();
    this.claims.clear();
    for (const m of this.data.mandates) this.byId.set(m.id, m);
    for (const c of this.data.faucet) this.claims.set(c.address, c);
  }

  /** Applies a change and writes it; memory changes only once the write landed. */
  private change(apply: (draft: RegistryFile) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.data);
      apply(draft);
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${String(process.pid)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.path);
      this.data = draft;
      this.index();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  mandate(id: string): MandateEntry | undefined {
    return this.byId.get(id);
  }

  /** A principal's mandates, newest first. */
  mandatesOf(principal: string): MandateEntry[] {
    return this.data.mandates
      .filter((m) => m.principal === principal)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  addMandate(entry: Omit<MandateEntry, 'recipients'>): Promise<void> {
    return this.change((draft) => {
      if (draft.mandates.some((m) => m.id === entry.id)) return;
      if (draft.mandates.length >= MAX_MANDATES) {
        throw new EngineError('config_invalid', 'the console registry is full');
      }
      draft.mandates.push({ ...entry, recipients: [] });
    });
  }

  /**
   * Adds recipients to a mandate, or renames ones it has. A label belongs to
   * one address per mandate, so an agent naming it always means one wallet.
   */
  upsertRecipients(id: string, entries: readonly RecipientEntry[]): Promise<void> {
    return this.change((draft) => {
      const m = draft.mandates.find((x) => x.id === id);
      if (m === undefined) throw new EngineError('input_invalid', 'no such mandate');
      for (const e of entries) {
        m.recipients = m.recipients.filter((r) => r.label !== e.label || r.address === e.address);
        const at = m.recipients.findIndex((r) => r.address === e.address);
        if (at === -1) {
          if (m.recipients.length >= MAX_RECIPIENTS) continue;
          m.recipients.push(e);
        } else {
          m.recipients[at] = e;
        }
      }
    });
  }

  faucetClaim(address: string): FaucetClaim | undefined {
    return this.claims.get(address);
  }

  recordFaucet(claim: FaucetClaim): Promise<void> {
    return this.change((draft) => {
      if (draft.faucet.length >= MAX_FAUCET_CLAIMS) draft.faucet.shift();
      draft.faucet.push(claim);
    });
  }
}

/** The label a recipient gets when its owner gave none. */
export function defaultLabel(existing: readonly RecipientEntry[], address: string): string {
  return existing.find((r) => r.address === address)?.label ?? `recipient-${address.slice(0, 6)}`;
}
