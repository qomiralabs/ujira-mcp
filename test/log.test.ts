// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The log sink: lines become JSON with the correlation fields of the running
// request, and secrets and personal data never reach the output, whether the
// line names them in a field or carries them in free text.

import { createHash, randomBytes } from 'node:crypto';

import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  addLogContext,
  errorCode,
  jsonLog,
  logLine,
  logRecord,
  parseLine,
  redactText,
  withLogContext,
} from '../src/log.js';

const TIME = new Date('2026-11-27T10:00:00.000Z');

function sink() {
  const out: string[] = [];
  const log = jsonLog({ service: 'test', write: (json) => out.push(json), now: () => TIME });
  const records = () => out.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, out, records };
}

const keypair = Keypair.fromRawEd25519Seed(createHash('sha256').update('log-test').digest());
const SEED = keypair.secret();
const ACCOUNT = keypair.publicKey();
const SIGNATURE = Buffer.from(keypair.sign(Buffer.from('a message'))).toString('base64');
const SIGNATURE_HEX = Buffer.from(keypair.sign(Buffer.from('a message'))).toString('hex');
const EMAIL = 'ada.lovelace+payouts@example.co.uk';
// Fake credentials are made at run time, so no key shaped literal sits in the repository.
const API_KEY = `ujk_test_${randomBytes(16).toString('hex')}`;
const SESSION = `${randomBytes(32).toString('base64url')}Aa1`;
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const JWT = `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'someone' })}.${randomBytes(32).toString('base64url')}`;
const DB_URL = 'postgres://ujira_app:hunter2-very-secret@db.example.internal:6543/postgres';
const XDR =
  'AAAAAgAAAABzdv3ojkzWHMD7KUoXhrPx0GH18vHKV0ZfqpMiEblG1gAAAGQAAAAAAAAAAQAAAAAAAAAAAAAAAQAAAAAAAAABAAAAAA==';
const TX_HASH = 'a3f1c2d4e5b6978899aabbccddeeff00112233445566778899aabbccddeeff00';
const CONTRACT = 'CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW';
const UUID = '0b8f7c3e-1d2a-4b5c-9e8f-7a6b5c4d3e2f';

const SECRETS = [
  SEED,
  ACCOUNT,
  SIGNATURE,
  SIGNATURE_HEX,
  EMAIL,
  API_KEY,
  SESSION,
  JWT,
  'hunter2-very-secret',
  XDR,
];

describe('log lines', () => {
  it('reads back exactly what logLine wrote, quoting what needs it', () => {
    const line = logLine('payout_recorded', {
      payoutId: TX_HASH,
      reason: 'two words',
      quote: 'say "hi" \\ there',
      count: 3,
      big: 12345678901234567890n,
      ok: true,
      none: null,
      skipped: undefined,
    });
    expect(line).toBe(
      `event=payout_recorded payoutId=${TX_HASH} reason="two words" quote="say \\"hi\\" \\\\ there" count=3 big=12345678901234567890 ok=true none=null`,
    );
    expect(Object.fromEntries(parseLine(line) ?? [])).toEqual({
      event: 'payout_recorded',
      payoutId: TX_HASH,
      reason: 'two words',
      quote: 'say "hi" \\ there',
      count: '3',
      big: '12345678901234567890',
      ok: 'true',
      none: 'null',
    });
  });

  it('never throws on a bad event or field name, so a log call cannot fail a payout', () => {
    expect(logLine('Not An Event', { 'bad key': 'x', event: 'y', fine: 'z' })).toBe(
      'event=log_misnamed fine=z',
    );
  });

  it('keeps anything that is not a whole structured line as free text', () => {
    for (const line of [
      'ready on testnet',
      'event=x key',
      'event=x key="open',
      'event=x a=1 a=2',
      'event=Bad a=1',
      'event=x  a=1',
    ]) {
      expect(parseLine(line), line).toBeUndefined();
    }
  });
});

describe('the JSON sink', () => {
  it('writes one JSON object per line with time, level, service, event and typed fields', () => {
    const { log, records } = sink();
    log(logLine('http_request', { requestId: UUID, method: 'GET', status: 200, ms: 12 }));
    expect(records()).toEqual([
      {
        time: TIME.toISOString(),
        level: 'info',
        service: 'test',
        event: 'http_request',
        message: `event=http_request requestId=${UUID} method=GET status=200 ms=12`,
        requestId: UUID,
        method: 'GET',
        status: 200,
        ms: 12,
      },
    ]);
  });

  it('marks alert lines at level error with the alert name, and failures at level error', () => {
    const { log, records } = sink();
    log(logLine('executor_low', { balanceStroops: 1 }));
    log(logLine('payout_request_failed', { error: 'rpc_timeout' }));
    log(logLine('health_degraded', { level: 'warn' }));
    log(logLine('health_degraded', { level: 'loud' }));
    log('recycle round failed (internal_error)');
    expect(records().map((r) => [r['event'], r['level'], r['alert']])).toEqual([
      ['executor_low', 'error', 'executor_low'],
      ['payout_request_failed', 'error', undefined],
      ['health_degraded', 'warn', undefined],
      ['health_degraded', 'info', undefined],
      ['log', 'error', undefined],
    ]);
  });

  it('adds the request context to every line written inside it, the correlation fields first', async () => {
    const { log, records } = sink();
    await withLogContext({ requestId: UUID }, async () => {
      await Promise.resolve();
      addLogContext({ principalId: 'p-1', projectId: 'j-1' });
      log(logLine('payout_recorded', { outcome: 'paid', payoutId: TX_HASH }));
      log('free text inside a request');
    });
    log(logLine('outside'));
    const [inside, text, outside] = records();
    expect(Object.keys(inside ?? {})).toEqual([
      'time',
      'level',
      'service',
      'event',
      'message',
      'requestId',
      'payoutId',
      'principalId',
      'projectId',
      'outcome',
    ]);
    expect(inside).toMatchObject({ requestId: UUID, principalId: 'p-1', payoutId: TX_HASH });
    expect(text).toMatchObject({ event: 'log', requestId: UUID });
    expect(outside?.['requestId']).toBeUndefined();
    // Outside any request there is nothing to add to.
    addLogContext({ principalId: 'ignored' });
  });

  it('does not let a line overwrite the fields the sink sets', () => {
    const record = logRecord(
      logLine('x', { time: 'then', service: 'other', message: 'm', alert: 'a' }),
      'test',
      TIME,
    );
    expect(record).toMatchObject({ time: TIME.toISOString(), service: 'test', event: 'x' });
    expect(record['alert']).toBeUndefined();
  });

  it('cuts very long values so one line cannot flood the log', () => {
    const record = logRecord(logLine('x', { detail: 'a '.repeat(2000) }), 'test', TIME);
    expect(String(record['detail']).length).toBeLessThan(600);
  });
});

describe('redaction', () => {
  it('drops secret and personal fields by name, whatever they hold', () => {
    const fields = {
      secret: 'x',
      agentSecret: 'x',
      password: 'x',
      token: 'x',
      authorization: 'x',
      cookie: 'x',
      signature: 'x',
      signedXdr: 'x',
      xdr: 'x',
      seed: 'x',
      email: 'x',
      phone: 'x',
      label: 'x',
      metadata: 'x',
      body: 'x',
      sessionId: 'x',
      idempotencyKey: 'x',
      recipient: 'Ada',
      destination: 'x',
      address: 'x',
      name: 'Ada',
      ip: 'x',
    };
    const record = logRecord(logLine('x', fields), 'test', TIME);
    for (const key of Object.keys(fields)) expect(record[key], key).toBe(REDACTED);
    expect(String(record['message'])).not.toContain('Ada');
  });

  it('takes secrets, signatures, tokens and emails out of any value and any free text', () => {
    const dirty = [
      `seed ${SEED}`,
      `signature ${SIGNATURE}`,
      `hex signature ${SIGNATURE_HEX}`,
      `mail ${EMAIL}`,
      `key ${API_KEY}`,
      `Bearer ${SESSION}`,
      `session ${SESSION}`,
      `jwt ${JWT}`,
      `db ${DB_URL}`,
      `envelope ${XDR}`,
      `from ${ACCOUNT}`,
      'client 203.0.113.7',
      'phone +254712345678',
    ].join(' | ');
    const { log, out } = sink();
    log(dirty);
    log(logLine('x', { detail: dirty }));
    const text = out.join('\n');
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    expect(text).not.toContain('203.0.113.7');
    expect(text).not.toContain('254712345678');
    expect(text).toContain(REDACTED);
    expect(text).toContain('postgres://[redacted]@db.example.internal');
    expect(text).toContain(`${ACCOUNT.slice(0, 4)}...${ACCOUNT.slice(-4)}`);
  });

  it('keeps what correlates and identifies public records: hashes, payout ids, contracts, uuids, codes', () => {
    for (const value of [
      TX_HASH,
      CONTRACT,
      UUID,
      'ResponseSchemaError',
      'mandate_entry_extended',
      'UNAVAILABLE reason=horizon_unavailable',
      '/m/:id/mcp',
      '2026-11-27T10:00:00.000Z',
    ]) {
      expect(redactText(value), value).toBe(value);
    }
  });

  it('names an error by its code or class, never its message', () => {
    expect(errorCode(Object.assign(new Error(`bad ${SEED}`), { code: 'rpc_timeout' }))).toBe(
      'rpc_timeout',
    );
    expect(errorCode(new TypeError(`bad ${SEED}`))).toBe('TypeError');
    expect(errorCode(Object.assign(new Error('x'), { code: 'has spaces in it' }))).toBe('Error');
    expect(errorCode('a string')).toBe('non_error');
  });
});
