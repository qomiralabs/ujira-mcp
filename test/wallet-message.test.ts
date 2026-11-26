// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { createHash } from 'node:crypto';

import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  WALLET_MESSAGE_TTL_MS,
  WalletMessageError,
  createWalletMessage,
  formatWalletMessage,
  parseWalletMessage,
  verifyWalletMessage,
  walletSignatureToBase64,
  type WalletMessage,
  type WalletMessageErrorCode,
  type WalletNonceStore,
  type WalletProofVerifier,
} from '../src/auth/wallet-message.js';

const ORIGIN = 'https://ujira.co';
const NOW = new Date('2026-11-26T10:00:00.000Z');

// Stands in for the chain adapter. It checks SEP-53 with the SDK, and the
// published SEP-53 test vector below proves it is SEP-53 and not merely
// consistent with the signer in these tests.
const sep53: WalletProofVerifier = {
  parseAccount(raw) {
    if (!StrKey.isValidEd25519PublicKey(raw)) throw new Error('not an account');
    return raw;
  },
  verifyWalletProof(address, message, signatureBase64) {
    return Keypair.fromPublicKey(address).verifyMessage(
      message,
      Buffer.from(signatureBase64, 'base64'),
    );
  },
};

/** Issues nonces and lets each be used once, as the challenge table will. */
class MemoryNonces implements WalletNonceStore {
  private readonly open = new Set<string>();

  issue(message: WalletMessage): void {
    this.open.add(`${message.purpose}|${message.address}|${message.nonce}`);
  }

  consume(message: WalletMessage): Promise<boolean> {
    return Promise.resolve(
      this.open.delete(`${message.purpose}|${message.address}|${message.nonce}`),
    );
  }
}

// What each wallet hands back, from its source: Freighter (extension 5.53,
// freighter-api 6) returns the SEP-53 signature in base64 as `signedMessage`;
// Albedo (intent 0.13) returns it in hex as `signedMessage` and keeps its old
// signature, over sha256("<pubkey>:<message>"), in `message_signature`.
const freighterSignature = (kp: Keypair, text: string) =>
  Buffer.from(kp.signMessage(text)).toString('base64');
const albedoSignature = (kp: Keypair, text: string) =>
  Buffer.from(kp.signMessage(text)).toString('hex');
const albedoLegacySignature = (kp: Keypair, text: string) =>
  Buffer.from(kp.sign(createHash('sha256').update(`${kp.publicKey()}:${text}`).digest())).toString(
    'hex',
  );
// Freighter before SEP-53 signed the message bytes with no prefix and no hash.
const freighterLegacySignature = (kp: Keypair, text: string) =>
  Buffer.from(kp.sign(Buffer.from(text, 'utf8'))).toString('base64');

function challenge(kp: Keypair, overrides: { origin?: string; now?: Date } = {}) {
  const nonces = new MemoryNonces();
  const { message, text } = createWalletMessage({
    purpose: 'sign_in',
    origin: overrides.origin ?? ORIGIN,
    address: kp.publicKey(),
    now: overrides.now ?? NOW,
  });
  nonces.issue(message);
  return { message, text, nonces };
}

async function refusal(promise: Promise<unknown>): Promise<WalletMessageErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WalletMessageError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

function expectCode(fn: () => unknown, code: WalletMessageErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WalletMessageError);
    expect((error as WalletMessageError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

const FIELDS: WalletMessage = {
  version: 1,
  purpose: 'sign_in',
  origin: ORIGIN,
  address: 'GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L',
  nonce: 'n0nce_n0nce-n0nce_n0nc',
  issuedAt: '2026-11-26T10:00:00.000Z',
  expiresAt: '2026-11-26T10:10:00.000Z',
};

const TEXT = [
  'ujira.co asks you to sign in with your wallet.',
  'Signing proves you hold this wallet. It moves no money and approves nothing.',
  '',
  'Version: 1',
  'Purpose: sign_in',
  'Origin: https://ujira.co',
  'Address: GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L',
  'Nonce: n0nce_n0nce-n0nce_n0nc',
  'Issued At: 2026-11-26T10:00:00.000Z',
  'Expires At: 2026-11-26T10:10:00.000Z',
].join('\n');

describe('the test verifier', () => {
  it('accepts the SEP-53 published test vector', () => {
    expect(
      sep53.verifyWalletProof(
        'GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L',
        'Hello, World!',
        'fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==',
      ),
    ).toBe(true);
  });
});

describe('the wallet message format', () => {
  it('is exactly the documented text', () => {
    expect(formatWalletMessage(FIELDS)).toBe(TEXT);
  });

  it('names the purpose in the first line', () => {
    const text = formatWalletMessage({ ...FIELDS, purpose: 'recipient_wallet' });
    expect(text.split('\n')[0]).toBe(
      'ujira.co asks you to prove you hold this wallet to receive payouts.',
    );
    expect(parseWalletMessage(text).purpose).toBe('recipient_wallet');
  });

  it('keeps a port in the host', () => {
    const text = formatWalletMessage({ ...FIELDS, origin: 'http://localhost:5173' });
    expect(text.split('\n')[0]).toBe('localhost:5173 asks you to sign in with your wallet.');
  });

  it('parses back to the same fields', () => {
    expect(parseWalletMessage(TEXT)).toEqual(FIELDS);
  });

  it('creates a fresh nonce and a ten minute expiry', () => {
    const kp = Keypair.random();
    const a = createWalletMessage({
      purpose: 'sign_in',
      origin: ORIGIN,
      address: kp.publicKey(),
      now: NOW,
    });
    const b = createWalletMessage({
      purpose: 'sign_in',
      origin: ORIGIN,
      address: kp.publicKey(),
      now: NOW,
    });
    expect(a.message.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.message.nonce).not.toBe(b.message.nonce);
    expect(Date.parse(a.message.expiresAt) - Date.parse(a.message.issuedAt)).toBe(
      WALLET_MESSAGE_TTL_MS,
    );
    expect(parseWalletMessage(a.text)).toEqual(a.message);
  });

  it('defaults the issue time to now', () => {
    const before = Date.now();
    const { message } = createWalletMessage({
      purpose: 'sign_in',
      origin: ORIGIN,
      address: FIELDS.address,
    });
    expect(Date.parse(message.issuedAt)).toBeGreaterThanOrEqual(before);
  });

  it.each([
    ['an origin with a path', { origin: 'https://ujira.co/app' }],
    ['an origin with a trailing slash', { origin: 'https://ujira.co/' }],
    ['plain http off the local machine', { origin: 'http://ujira.co' }],
    ['an origin that is not a URL', { origin: 'ujira.co' }],
    ['another scheme', { origin: 'ftp://ujira.co' }],
    ['an address with a newline', { address: `${FIELDS.address}\nNonce: x` }],
    ['a short nonce', { nonce: 'short' }],
    ['a nonce outside base64url', { nonce: 'n0nce+n0nce/n0nce=n0nc' }],
    ['a date that does not exist', { issuedAt: '2026-02-30T10:00:00.000Z' }],
    ['a time without milliseconds', { issuedAt: '2026-11-26T10:00:00Z' }],
    ['an expiry before the issue time', { expiresAt: '2026-11-26T09:59:59.999Z' }],
    ['an expiry equal to the issue time', { expiresAt: '2026-11-26T10:00:00.000Z' }],
    ['a lifetime over ten minutes', { expiresAt: '2026-11-26T10:10:00.001Z' }],
  ])('refuses to format %s', (_name, change) => {
    expectCode(() => formatWalletMessage({ ...FIELDS, ...change }), 'MESSAGE_MALFORMED');
  });

  it('refuses to create a challenge that lives longer than ten minutes', () => {
    expectCode(
      () =>
        createWalletMessage({
          purpose: 'sign_in',
          origin: ORIGIN,
          address: FIELDS.address,
          now: NOW,
          ttlMs: WALLET_MESSAGE_TTL_MS + 1,
        }),
      'MESSAGE_MALFORMED',
    );
  });

  it.each([
    ['Windows line endings', TEXT.replaceAll('\n', '\r\n')],
    ['a trailing newline', `${TEXT}\n`],
    ['an extra line', `${TEXT}\nChain: stellar`],
    ['a missing line', TEXT.split('\n').slice(0, -1).join('\n')],
    ['a changed headline', TEXT.replace('ujira.co asks', 'evil.example asks')],
    ['a changed notice', TEXT.replace('moves no money', 'moves money')],
    ['a padded version', TEXT.replace('Version: 1', 'Version: 01')],
    ['a later version', TEXT.replace('Version: 1', 'Version: 2')],
    ['an unknown purpose', TEXT.replace('Purpose: sign_in', 'Purpose: pay')],
    ['a relabelled field', TEXT.replace('Nonce: ', 'Nonse: ')],
    [
      'fields out of order',
      TEXT.replace('Version: 1\nPurpose: sign_in', 'Purpose: sign_in\nVersion: 1'),
    ],
    ['a doubled space', TEXT.replace('Nonce: ', 'Nonce:  ')],
    ['text past the length cap', `${TEXT}${' '.repeat(1024)}`],
    ['an empty string', ''],
  ])('refuses to parse %s', (_name, text) => {
    expectCode(() => parseWalletMessage(text), 'MESSAGE_MALFORMED');
  });
});

describe('wallet signatures', () => {
  const kp = Keypair.random();
  const sig = Buffer.from(kp.signMessage('x'));

  it('takes base64 as is and hex as base64', () => {
    expect(walletSignatureToBase64(sig.toString('base64'))).toBe(sig.toString('base64'));
    expect(walletSignatureToBase64(sig.toString('hex'))).toBe(sig.toString('base64'));
    expect(walletSignatureToBase64(sig.toString('hex').toUpperCase())).toBe(sig.toString('base64'));
  });

  it.each([
    ['empty', ''],
    ['63 bytes in base64', sig.subarray(0, 63).toString('base64')],
    ['65 bytes in base64', Buffer.concat([sig, Buffer.of(0)]).toString('base64')],
    ['63 bytes in hex', sig.subarray(0, 63).toString('hex')],
    ['base64 without padding', sig.toString('base64').replace(/=+$/, '')],
    ['base64url', sig.toString('base64url')],
    // The last character before the padding carries four bits of nothing;
    // setting them gives another string Node decodes to the same bytes.
    [
      'base64 with stray low bits',
      (() => {
        const b64 = sig.toString('base64');
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const last = alphabet.indexOf(b64.charAt(85));
        return `${b64.slice(0, 85)}${alphabet.charAt(last | 1)}==`;
      })(),
    ],
    ['a buffer printed as JSON', JSON.stringify(sig)],
    ['hex with a 0x prefix', `0x${sig.toString('hex')}`],
  ])('refuses %s', (_name, raw) => {
    expectCode(() => walletSignatureToBase64(raw), 'SIGNATURE_MALFORMED');
  });
});

describe('verifying a signed wallet message', () => {
  const expected = { purpose: 'sign_in', origin: ORIGIN } as const;

  it('accepts a Freighter signature (SEP-53, base64)', async () => {
    const kp = Keypair.random();
    const { message, text, nonces } = challenge(kp);
    const verified = await verifyWalletMessage(
      {
        message: text,
        address: kp.publicKey(),
        signature: freighterSignature(kp, text),
        expected,
        now: NOW,
      },
      { verifier: sep53, nonces },
    );
    expect(verified).toEqual(message);
  });

  it('checks the time against the clock when no time is given', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp, { now: new Date() });
    await expect(
      verifyWalletMessage(
        {
          message: text,
          address: kp.publicKey(),
          signature: freighterSignature(kp, text),
          expected,
        },
        { verifier: sep53, nonces },
      ),
    ).resolves.toBeDefined();
    const old = challenge(kp, { now: new Date(Date.now() - WALLET_MESSAGE_TTL_MS - 1000) });
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: old.text,
            address: kp.publicKey(),
            signature: freighterSignature(kp, old.text),
            expected,
          },
          { verifier: sep53, nonces: old.nonces },
        ),
      ),
    ).toBe('MESSAGE_EXPIRED');
  });

  it('accepts an Albedo signature (SEP-53, hex)', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    const verified = await verifyWalletMessage(
      {
        message: text,
        address: kp.publicKey(),
        signature: albedoSignature(kp, text),
        expected,
        now: NOW,
      },
      { verifier: sep53, nonces },
    );
    expect(verified.address).toBe(kp.publicKey());
  });

  it('accepts a signature up to the last millisecond and with a clock a minute behind', async () => {
    const kp = Keypair.random();
    for (const at of ['2026-11-26T10:09:59.999Z', '2026-11-26T09:59:00.000Z']) {
      const { text, nonces } = challenge(kp);
      await expect(
        verifyWalletMessage(
          {
            message: text,
            address: kp.publicKey(),
            signature: freighterSignature(kp, text),
            expected,
            now: new Date(at),
          },
          { verifier: sep53, nonces },
        ),
      ).resolves.toBeDefined();
    }
  });

  it('refuses a claimed address that is not the one in the message', async () => {
    const kp = Keypair.random();
    const other = Keypair.random();
    const { text, nonces } = challenge(kp);
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: text,
            address: other.publicKey(),
            signature: freighterSignature(other, text),
            expected,
            now: NOW,
          },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('ADDRESS_MISMATCH');
  });

  it('refuses a signature made by another key', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: text,
            address: kp.publicKey(),
            signature: freighterSignature(Keypair.random(), text),
            expected,
            now: NOW,
          },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('SIGNATURE_INVALID');
  });

  it('refuses an address the adapter cannot parse, and keeps the cause', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    const error = await verifyWalletMessage(
      {
        message: text,
        address: 'not-an-account',
        signature: freighterSignature(kp, text),
        expected,
        now: NOW,
      },
      { verifier: sep53, nonces },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletMessageError);
    expect((error as WalletMessageError).code).toBe('ADDRESS_INVALID');
    expect((error as WalletMessageError).cause).toBeInstanceOf(Error);
  });

  it('refuses an expired message', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: text,
            address: kp.publicKey(),
            signature: freighterSignature(kp, text),
            expected,
            now: new Date('2026-11-26T10:10:00.000Z'),
          },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('MESSAGE_EXPIRED');
  });

  it('refuses a message issued more than a minute in the future', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: text,
            address: kp.publicKey(),
            signature: freighterSignature(kp, text),
            expected,
            now: new Date('2026-11-26T09:58:59.999Z'),
          },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('MESSAGE_NOT_YET_VALID');
  });

  it('refuses a message signed for another site', async () => {
    const kp = Keypair.random();
    // A real signature, collected by a site that copied our format.
    const { text, nonces } = challenge(kp, { origin: 'https://ujira.co.evil.example' });
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: text,
            address: kp.publicKey(),
            signature: freighterSignature(kp, text),
            expected,
            now: NOW,
          },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('ORIGIN_MISMATCH');
  });

  it('refuses a message signed for another purpose', async () => {
    const kp = Keypair.random();
    const nonces = new MemoryNonces();
    const { message, text } = createWalletMessage({
      purpose: 'recipient_wallet',
      origin: ORIGIN,
      address: kp.publicKey(),
      now: NOW,
    });
    nonces.issue(message);
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: text,
            address: kp.publicKey(),
            signature: freighterSignature(kp, text),
            expected,
            now: NOW,
          },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('PURPOSE_MISMATCH');
  });

  it('refuses a reused nonce', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    const input = {
      message: text,
      address: kp.publicKey(),
      signature: freighterSignature(kp, text),
      expected,
      now: NOW,
    };
    await verifyWalletMessage(input, { verifier: sep53, nonces });
    expect(await refusal(verifyWalletMessage(input, { verifier: sep53, nonces }))).toBe(
      'NONCE_REUSED',
    );
  });

  it('lets only one of two concurrent uses of a nonce through', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    const input = {
      message: text,
      address: kp.publicKey(),
      signature: freighterSignature(kp, text),
      expected,
      now: NOW,
    };
    const results = await Promise.allSettled([
      verifyWalletMessage(input, { verifier: sep53, nonces }),
      verifyWalletMessage(input, { verifier: sep53, nonces }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses a nonce the server never issued', async () => {
    const kp = Keypair.random();
    const { text } = challenge(kp);
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: text,
            address: kp.publicKey(),
            signature: freighterSignature(kp, text),
            expected,
            now: NOW,
          },
          { verifier: sep53, nonces: new MemoryNonces() },
        ),
      ),
    ).toBe('NONCE_REUSED');
  });

  it('does not use up the nonce when the signature is bad', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    const base = { message: text, address: kp.publicKey(), expected, now: NOW };
    expect(
      await refusal(
        verifyWalletMessage(
          { ...base, signature: freighterSignature(Keypair.random(), text) },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('SIGNATURE_INVALID');
    await expect(
      verifyWalletMessage(
        { ...base, signature: freighterSignature(kp, text) },
        { verifier: sep53, nonces },
      ),
    ).resolves.toBeDefined();
  });

  it.each([
    ['empty', () => ''],
    [
      'a truncated signature',
      (kp: Keypair, text: string) => freighterSignature(kp, text).slice(0, 40),
    ],
    ['not base64 or hex', () => 'definitely not a signature'],
  ])('refuses a malformed signature: %s', async (_name, make) => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    expect(
      await refusal(
        verifyWalletMessage(
          { message: text, address: kp.publicKey(), signature: make(kp, text), expected, now: NOW },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('SIGNATURE_MALFORMED');
  });

  it("refuses Albedo's own message_signature, which is not SEP-53", async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: text,
            address: kp.publicKey(),
            signature: albedoLegacySignature(kp, text),
            expected,
            now: NOW,
          },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('SIGNATURE_INVALID');
  });

  it('refuses a pre SEP-53 Freighter signature over the bare message', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: text,
            address: kp.publicKey(),
            signature: freighterLegacySignature(kp, text),
            expected,
            now: NOW,
          },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('SIGNATURE_INVALID');
  });

  it('refuses a signed message whose text was changed after signing', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    const signature = freighterSignature(kp, text);
    const { text: other } = challenge(kp);
    expect(
      await refusal(
        verifyWalletMessage(
          { message: other, address: kp.publicKey(), signature, expected, now: NOW },
          { verifier: sep53, nonces },
        ),
      ),
    ).toBe('SIGNATURE_INVALID');
  });

  it('refuses a malformed message before anything else', async () => {
    const kp = Keypair.random();
    expect(
      await refusal(
        verifyWalletMessage(
          {
            message: 'hello',
            address: kp.publicKey(),
            signature: freighterSignature(kp, 'hello'),
            expected,
            now: NOW,
          },
          { verifier: sep53, nonces: new MemoryNonces() },
        ),
      ),
    ).toBe('MESSAGE_MALFORMED');
  });

  it('lets a verifier or store failure through instead of calling it a bad signature', async () => {
    const kp = Keypair.random();
    const { text, nonces } = challenge(kp);
    const input = {
      message: text,
      address: kp.publicKey(),
      signature: freighterSignature(kp, text),
      expected,
      now: NOW,
    };
    const outage = new Error('store unavailable');
    const broken: WalletNonceStore = { consume: () => Promise.reject(outage) };
    await expect(verifyWalletMessage(input, { verifier: sep53, nonces: broken })).rejects.toBe(
      outage,
    );
    const failing: WalletProofVerifier = {
      parseAccount: (raw) => raw,
      verifyWalletProof: () => {
        throw outage;
      },
    };
    await expect(verifyWalletMessage(input, { verifier: failing, nonces })).rejects.toBe(outage);
  });

  it('never puts the signature or the nonce in an error message', async () => {
    const kp = Keypair.random();
    const { message, text, nonces } = challenge(kp);
    const signature = freighterSignature(Keypair.random(), text);
    const error = await verifyWalletMessage(
      { message: text, address: kp.publicKey(), signature, expected, now: NOW },
      { verifier: sep53, nonces },
    ).catch((e: unknown) => e);
    expect(String(error)).not.toContain(signature);
    expect(String(error)).not.toContain(message.nonce);
  });
});
