// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Keypair, scValToNative, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { loadSettings, createEngine } from '../src/config.js';
import { ContractRefusedError, contractCodeIn, mandateErrorName } from '../src/errors.js';
import { defaultRecipientRef, payoutIdFor, taskRefFor } from '../src/ids.js';
import { decodeConfig, decodePayoutEntry, encodePayoutRequest } from '../src/mandate/codec.js';
import { statusName } from '../src/mandate/types.js';
import { formatUnits, minorUnits, units } from '../src/money.js';
import { ReceiptLog } from '../src/receipts/log.js';
import { contractCodeInEvents, withTimeout } from '../src/stellar/gateway.js';
import { keypairFromMnemonic, keypairFromText, signerFromEnv } from '../src/stellar/keys.js';
import { FakeMandateRpc, MANDATE } from './fake-rpc.js';
import { alice } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ujira-mcp-'));

// SEP-0005 test vector 1.
const SEP5_WORDS = 'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const SEP5_ACCOUNT_0 = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

describe('ids', () => {
  it('derives stable, distinct IDs per mandate and task', () => {
    expect(payoutIdFor(MANDATE, 't')).toBe(payoutIdFor(MANDATE, 't'));
    expect(payoutIdFor(MANDATE, 't')).not.toBe(payoutIdFor(MANDATE, 'u'));
    expect(taskRefFor('t')).toMatch(/^[0-9a-f]{64}$/);
    expect(defaultRecipientRef(alice)).not.toBe(taskRefFor(alice));
  });
});

describe('money', () => {
  it('parses minor units from strings only', () => {
    expect(minorUnits.parse('25')).toBe(25n);
    expect(minorUnits.safeParse(25).success).toBe(false);
    expect(minorUnits.safeParse('1e3').success).toBe(false);
    expect(minorUnits.safeParse('9'.repeat(39)).success).toBe(false);
  });

  it('formats units for people', () => {
    expect(formatUnits(250_000_000n)).toBe('25');
    expect(formatUnits(12_345_678n)).toBe('1.2345678');
    expect(formatUnits(-5_000_000n)).toBe('-0.5');
    expect(units(3)).toBe(30_000_000n);
    expect(() => units(1.5)).toThrow(RangeError);
  });
});

describe('errors', () => {
  it('reads contract codes from host errors', () => {
    expect(contractCodeIn('HostError: Error(Contract, #41)\nmore')).toBe(41);
    expect(contractCodeIn('HostError: Error(Budget, ExceededLimit)')).toBeUndefined();
    expect(mandateErrorName(50)).toBe('recipient_not_allowed');
    expect(mandateErrorName(999)).toBe('mandate_error_999');
    expect(new ContractRefusedError('execute', 42).message).toContain('daily_cap_exceeded');
  });

  it('reads contract codes from diagnostic events', () => {
    const ev = (json: unknown) => ({ toJson: () => json });
    expect(contractCodeInEvents([ev({ data: { error: { contract: 42 } } })])).toBe(42);
    expect(contractCodeInEvents([ev({ contract: 'CABC' })])).toBeUndefined();
  });
});

describe('codec', () => {
  it('encodes a request as a map with sorted field names', () => {
    const v = encodePayoutRequest({
      payoutId: 'aa'.repeat(32),
      recipientRef: 'bb'.repeat(32),
      total: 5n,
      fee: 0n,
      legs: [{ destination: alice, amount: 5n }],
      deadline: 99n,
      taskRef: 'cc'.repeat(32),
    });
    if (v.type !== 'scvMap') throw new Error('expected a map');
    const keys = (v.map ?? []).map((e) => String(scValToNative(e.key)));
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain('task_ref');
    expect(scValToNative(v)).toMatchObject({
      total: 5n,
      legs: [{ destination: alice, amount: 5n }],
    });
  });

  it('refuses answers in an unexpected shape', () => {
    expect(() => decodeConfig(xdr.ScVal.scvBool(true))).toThrow(/unexpected shape/);
    expect(decodePayoutEntry(xdr.ScVal.scvVoid())).toBeNull();
  });

  it('names payout statuses', () => {
    expect(statusName(3)).toBe('executed');
    expect(statusName(9)).toBe('unknown');
  });
});

describe('keys', () => {
  it('derives stellar CLI identities from their seed phrase (SEP-0005)', () => {
    expect(keypairFromMnemonic(SEP5_WORDS).publicKey()).toBe(SEP5_ACCOUNT_0);
    expect(keypairFromText(`seed_phrase = "${SEP5_WORDS}"\n`, 'k').publicKey()).toBe(
      SEP5_ACCOUNT_0,
    );
  });

  it('reads a bare secret and a secret_key line', () => {
    const kp = Keypair.random();
    expect(keypairFromText(`${kp.secret()}\n`, 'k').publicKey()).toBe(kp.publicKey());
    expect(keypairFromText(`secret_key = "${kp.secret()}"`, 'k').publicKey()).toBe(kp.publicKey());
  });

  it('never echoes text it cannot read', () => {
    let message = '';
    try {
      keypairFromText('SOMETHING-PRIVATE', 'UJIRA_AGENT_SECRET');
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('UJIRA_AGENT_SECRET');
    expect(message).not.toContain('SOMETHING-PRIVATE');
  });

  it('loads from env or a file, and refuses both at once', () => {
    const kp = Keypair.random();
    const file = join(tmp(), 'agent.toml');
    writeFileSync(file, `secret_key = "${kp.secret()}"\n`);
    expect(signerFromEnv({ X_SECRET: kp.secret() }, 'X')?.publicKey).toBe(kp.publicKey());
    expect(signerFromEnv({ X_KEY_FILE: file }, 'X')?.publicKey).toBe(kp.publicKey());
    expect(signerFromEnv({}, 'X')).toBeUndefined();
    expect(() => signerFromEnv({ X_SECRET: kp.secret(), X_KEY_FILE: file }, 'X')).toThrow(
      /not both/,
    );
    expect(() => signerFromEnv({ X_KEY_FILE: join(tmp(), 'missing') }, 'X')).toThrow(
      /cannot be read/,
    );
  });
});

describe('receipt log', () => {
  it('starts empty, round-trips bigint amounts and refuses a corrupt file', async () => {
    const path = join(tmp(), 'r.json');
    const log = new ReceiptLog(path);
    expect(await log.list(MANDATE)).toEqual([]);
    const at = new Date(0).toISOString();
    const base = {
      task_id: 't',
      mandate: MANDATE,
      principal: 'P',
      agent: 'A',
      network: 'testnet',
      recipient: alice,
      destination: alice,
      amount: 2n ** 100n,
      asset: 'USDC',
      rail: 'usdc' as const,
      outcome: 'paid' as const,
      created_at: at,
      updated_at: at,
    };
    await log.upsert(base);
    await log.upsert({ ...base, task_id: 'other', mandate: 'CELSEWHERE' });
    expect((await new ReceiptLog(path).find(MANDATE, 't'))?.amount).toBe(2n ** 100n);
    expect(await log.list(MANDATE)).toHaveLength(1);
    writeFileSync(path, '{not json');
    await expect(log.list(MANDATE)).rejects.toThrow(/not valid JSON/);
    writeFileSync(path, '{"version":2}');
    await expect(log.list(MANDATE)).rejects.toThrow(/expected format/);
  });
});

describe('settings', () => {
  const kp = Keypair.random();

  it('reads the mandate file and the keys, and defaults the rest', () => {
    const dir = tmp();
    const file = join(dir, 'mandate.json');
    writeFileSync(
      file,
      JSON.stringify({
        network: 'testnet',
        mandate: MANDATE,
        asset: { code: 'USDC' },
        recipients: [{ recipient_ref: 'ab'.repeat(32), destination: alice, name: 'r1' }],
        extra: 'ignored',
      }),
    );
    const s = loadSettings({ UJIRA_MANDATE_FILE: file, UJIRA_AGENT_SECRET: kp.secret() });
    expect(s).toMatchObject({ network: 'testnet', mandateId: MANDATE, assetCode: 'USDC' });
    expect(s.recipientRefs.get(alice)).toBe('ab'.repeat(32));
    expect(s.executor.publicKey).toBe(kp.publicKey());
    const { engine } = createEngine(s, { gateway: new FakeMandateRpc() });
    expect(engine.recipientRefFor(alice)).toBe('ab'.repeat(32));
    expect(engine.mandateId).toBe(MANDATE);
  });

  it.each([
    [{ UJIRA_NETWORK: 'mainnet' }, /only testnet/],
    [{}, /UJIRA_MANDATE_ID/],
    [{ UJIRA_MANDATE_ID: 'CNOTVALID' }, /UJIRA_MANDATE_ID/],
    [{ UJIRA_MANDATE_ID: MANDATE }, /UJIRA_AGENT_SECRET/],
    [{ UJIRA_MANDATE_FILE: '/nonexistent/mandate.json' }, /cannot be read/],
  ])('refuses %o', (env, message) => {
    expect(() => loadSettings(env)).toThrow(message);
  });

  it('reads the mandate facts inline from UJIRA_MANDATE_JSON', () => {
    const json = JSON.stringify({
      mandate: MANDATE,
      asset: { code: 'UJTEST' },
      recipients: [{ recipient_ref: 'cd'.repeat(32), destination: alice }],
    });
    const s = loadSettings({ UJIRA_MANDATE_JSON: json, UJIRA_AGENT_SECRET: kp.secret() });
    expect(s).toMatchObject({ mandateId: MANDATE, assetCode: 'UJTEST' });
    expect(s.recipientRefs.get(alice)).toBe('cd'.repeat(32));
    expect(s.sdp).toBeUndefined();
  });

  it.each([
    [{ UJIRA_MANDATE_JSON: '{nope' }, /UJIRA_MANDATE_JSON cannot be read as JSON/],
    [{ UJIRA_MANDATE_JSON: '{"network":"testnet"}' }, /UJIRA_MANDATE_JSON is missing the mandate/],
    [{ UJIRA_MANDATE_JSON: '{}', UJIRA_MANDATE_FILE: '/x.json' }, /not both/],
  ])('refuses inline mandate facts %o', (env, message) => {
    expect(() => loadSettings(env)).toThrow(message);
  });

  it('refuses a mandate file without a mandate', () => {
    const file = join(tmp(), 'm.json');
    writeFileSync(file, '{"network":"testnet"}');
    expect(() => loadSettings({ UJIRA_MANDATE_FILE: file })).toThrow(/missing the mandate/);
  });
});

describe('withTimeout', () => {
  it('fails a call that takes too long', async () => {
    await expect(withTimeout(new Promise(() => undefined), 5, 'slow call')).rejects.toThrow(
      /slow call timed out/,
    );
    await expect(withTimeout(Promise.resolve(1), 1000, 'fast')).resolves.toBe(1);
  });
});
