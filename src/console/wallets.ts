// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The test recipient wallets this server made, with their keys, so the money
// a demo pays them can go back to the faucet afterwards. These are throwaway
// testnet accounts the server created itself; no person ever holds them.
//
// The keys live in their own file, apart from the registry, written with mode
// 600 through a temporary file and a rename. A key never leaves this module:
// callers get addresses, and ask this module to sign.

import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Keypair, StrKey, type Transaction } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { EngineError } from '../errors.js';
import { accountAddress } from '../ids.js';

/** Past this many, the oldest wallets are forgotten and no longer recycled. */
export const MAX_TEST_WALLETS = 5_000;

const walletSchema = z.object({
  address: accountAddress,
  secret: z.string().refine((s) => StrKey.isValidEd25519SecretSeed(s)),
  createdAt: z.string(),
});

const fileSchema = z.object({ version: z.literal(1), wallets: z.array(walletSchema) });

type WalletFile = z.infer<typeof fileSchema>;

export interface TestWallet {
  readonly address: string;
  readonly createdAt: string;
}

function load(path: string): WalletFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, wallets: [] };
    }
    throw new EngineError('config_invalid', 'the test wallet file cannot be read', {
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // The parser's message can quote the file, and the file holds keys.
    throw new EngineError('config_invalid', 'the test wallet file is not valid JSON');
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new EngineError('config_invalid', 'the test wallet file is not in the expected format');
  }
  for (const w of parsed.data.wallets) {
    if (Keypair.fromSecret(w.secret).publicKey() !== w.address) {
      throw new EngineError('config_invalid', 'the test wallet file has a key for another address');
    }
  }
  return parsed.data;
}

export class TestWalletStore {
  readonly path: string;
  private data: WalletFile;
  private readonly max: number;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, data: WalletFile, max: number) {
    this.path = path;
    this.data = data;
    this.max = max;
  }

  /** Reads the store, or starts an empty one; fails at start if the file is unusable. */
  static open(path: string, max = MAX_TEST_WALLETS): TestWalletStore {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      throw new EngineError('config_invalid', 'the console data directory cannot be created', {
        cause: error,
      });
    }
    const data = load(path);
    // A file copied in by hand may have looser permissions; tighten them now.
    if (data.wallets.length > 0) chmodSync(path, 0o600);
    return new TestWalletStore(path, data, max);
  }

  /** Addresses, oldest first. */
  list(): TestWallet[] {
    return this.data.wallets.map((w) => ({ address: w.address, createdAt: w.createdAt }));
  }

  has(address: string): boolean {
    return this.data.wallets.some((w) => w.address === address);
  }

  get size(): number {
    return this.data.wallets.length;
  }

  /** Remembers a wallet this server made; the oldest drop out past the cap. */
  add(keypair: Keypair, createdAt: string): Promise<void> {
    return this.change((draft) => {
      const address = keypair.publicKey();
      if (draft.wallets.some((w) => w.address === address)) return;
      draft.wallets.push({ address, secret: keypair.secret(), createdAt });
      while (draft.wallets.length > this.max) draft.wallets.shift();
    });
  }

  /** Signs with a wallet this server made; false when it does not know the address. */
  sign(address: string, tx: Transaction): boolean {
    const w = this.data.wallets.find((x) => x.address === address);
    if (w === undefined) return false;
    tx.sign(Keypair.fromSecret(w.secret));
    return true;
  }

  private change(apply: (draft: WalletFile) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.data);
      apply(draft);
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${String(process.pid)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
      await rename(tmp, this.path);
      this.data = draft;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Keeps the keys out of anything that prints this object. */
  toJSON(): { path: string; wallets: number } {
    return { path: this.path, wallets: this.data.wallets.length };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `TestWalletStore(${String(this.data.wallets.length)} wallets)`;
  }
}
