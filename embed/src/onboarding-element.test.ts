// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// @vitest-environment happy-dom

// The whole flow against the fake API: choose a wallet, give the address,
// prove it, done. Freighter is stood in for at its library, so the widget's
// own calls into it are what is tested.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiProblem } from './api/client.js';
import { fakeClient, FAKE_ISSUER, WRONG_SIGNATURE, type FakeScenario } from './api/fake.js';
import { encodeAccountAddress, encodeMuxedAddress } from './destination.js';
import { en } from './i18n/en.js';
import { TAG_NAME } from './index.js';
import {
  COMPLETE_EVENT,
  originOf,
  STEP_CHANGE_EVENT,
  type CompleteDetail,
  type StepChangeDetail,
  type UjiraOnboarding,
} from './onboarding-element.js';
import type { WalletConnector } from './wallet.js';

const freighter = vi.hoisted(() => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  signMessage: vi.fn(),
}));

vi.mock('@stellar/freighter-api', () => freighter);

const albedo = vi.hoisted(() => ({
  publicKey: vi.fn(),
  signMessage: vi.fn(),
}));

vi.mock('@albedo-link/intent', () => ({ default: albedo }));

const WALLET = encodeAccountAddress(new Uint8Array(32).fill(7));
const OTHER = encodeAccountAddress(new Uint8Array(32).fill(8));

/** 64 bytes of 0xab: what Albedo sends as hex, and the server is sent as base64. */
const ALBEDO_HEX = 'ab'.repeat(64);
const ALBEDO_BASE64 = btoa(String.fromCharCode(...new Uint8Array(64).fill(0xab)));

let widget: UjiraOnboarding;

function root(): ShadowRoot {
  const shadow = widget.shadowRoot;
  if (shadow === null) throw new Error('the widget has no shadow root');
  return shadow;
}

function find(selector: string): HTMLElement {
  const found = root().querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

function text(selector: string): string {
  return find(selector).textContent.trim();
}

function field(selector: string): HTMLInputElement {
  const found = find(selector);
  if (!(found instanceof HTMLInputElement)) throw new Error(`${selector} is not an input`);
  return found;
}

/** Lets every pending promise and the render after it settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 6; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await widget.updateComplete;
  }
}

async function type(selector: string, value: string): Promise<void> {
  const input = field(selector);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await widget.updateComplete;
}

async function choose(wallet: 'freighter' | 'albedo' | 'other'): Promise<void> {
  const radio = field(`input[value="${wallet}"]`);
  radio.checked = true;
  radio.dispatchEvent(new Event('change'));
  await widget.updateComplete;
}

async function submit(): Promise<void> {
  const form = find('form');
  if (!(form instanceof HTMLFormElement)) throw new Error('that is not a form');
  form.requestSubmit();
  await settle();
}

async function open(
  scenario: Partial<FakeScenario> = {},
  wallet?: WalletConnector,
): Promise<ReturnType<typeof fakeClient>> {
  const client = fakeClient(scenario);
  widget = document.createElement(TAG_NAME);
  widget.client = client;
  if (wallet !== undefined) widget.wallet = wallet;
  document.body.replaceChildren(widget);
  await settle();
  return client;
}

/** Another wallet, a typed address, ending on the proof step. */
async function typeAddress(address = WALLET, memo = ''): Promise<void> {
  await choose('other');
  await submit();
  await type('#answer', address);
  if (memo !== '') await type('#memo', memo);
  await submit();
}

function names(client: ReturnType<typeof fakeClient>): string[] {
  return client.calls.map((call) => call.name);
}

beforeEach(() => {
  freighter.isConnected.mockResolvedValue({ isConnected: true });
  freighter.requestAccess.mockResolvedValue({ address: WALLET });
  freighter.signMessage.mockResolvedValue({ signedMessage: 'c2lnbmVk', signerAddress: WALLET });
  albedo.publicKey.mockResolvedValue({ pubkey: WALLET });
  albedo.signMessage.mockResolvedValue({ pubkey: WALLET, signedMessage: ALBEDO_HEX });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('the first step', () => {
  it('reads the session, then asks which wallet, step 1 of 3', async () => {
    const client = await open();
    expect(names(client)).toEqual(['session']);
    expect(widget.currentStep).toBe('wallet');
    expect(text('.progress')).toBe('Step 1 of 3');
    expect(text('.heading')).toBe(en['wallet.heading']);
    expect(text('.hint')).toBe('Payouts arrive as USDC to your Stellar wallet.');
    const choices = [...root().querySelectorAll('.choice-name')].map((n) => n.textContent);
    expect(choices).toEqual([
      en['wallet.freighter.name'],
      en['wallet.albedo.name'],
      en['wallet.other.name'],
    ]);
    expect(root().querySelectorAll('.bars i.on')).toHaveLength(1);
  });

  it('asks for a choice before it moves on', async () => {
    await open();
    await submit();
    expect(widget.currentStep).toBe('wallet');
    expect(text('.alert')).toBe(en['wallet.missing']);
  });

  it('renders in light mode by default and says Payouts by UJIRA in the footer', async () => {
    await open();
    expect(widget.getAttribute('mode')).toBe('light');
    expect(text('.footer')).toBe('Payouts by UJIRA');
    expect(find('.widget').getAttribute('lang')).toBe('en');
  });

  it('shows English even when the page asks for a language that is not reviewed', async () => {
    await open();
    widget.locale = 'fr';
    await settle();
    expect(text('.heading')).toBe(en['wallet.heading']);
  });
});

describe('with Freighter', () => {
  it('connects, saves the shared address and signs the proof with Freighter', async () => {
    const client = await open();
    const done: CompleteDetail[] = [];
    widget.addEventListener(COMPLETE_EVENT, (event) => {
      done.push((event as CustomEvent<CompleteDetail>).detail);
    });
    await choose('freighter');
    await submit();
    expect(widget.currentStep).toBe('address');
    expect(text('.heading')).toBe(en['connect.heading']);
    expect(text('.primary')).toBe(en['connect.action']);

    await submit();
    expect(widget.currentStep).toBe('prove');
    expect(text('.progress')).toBe('Step 3 of 3');
    expect(text('.statement-value')).toBe(WALLET);
    expect(text('.primary')).toBe(en['prove.freighter.action']);
    const added = client.calls.find((call) => call.name === 'addMethod');
    expect(added?.args[1]).toEqual({
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: WALLET },
    });

    await submit();
    expect(freighter.signMessage).toHaveBeenCalledWith(
      expect.stringContaining('confirm your payout address'),
      { address: WALLET },
    );
    expect(widget.currentStep).toBe('done');
    expect(text('.heading')).toBe(en['done.heading']);
    expect(done).toEqual([
      { wallet: 'freighter', destination: WALLET, memo: '', methodId: 'method-0001' },
    ]);
  });

  it('says so when Freighter is not installed, and saves nothing', async () => {
    freighter.isConnected.mockResolvedValue({ isConnected: false });
    const client = await open();
    await choose('freighter');
    await submit();
    await submit();
    expect(widget.currentStep).toBe('address');
    expect(text('.alert')).toBe(en['connect.missing']);
    expect(names(client)).not.toContain('addMethod');
  });

  it('says so when Freighter will not share an address', async () => {
    freighter.requestAccess.mockResolvedValue({
      address: '',
      error: { code: -4, message: 'The user rejected this request.' },
    });
    await open();
    await choose('freighter');
    await submit();
    await submit();
    expect(text('.alert')).toBe(en['connect.declined']);
  });

  it('refuses an address Freighter shares that a payout would burn', async () => {
    freighter.requestAccess.mockResolvedValue({ address: FAKE_ISSUER });
    const client = await open();
    await choose('freighter');
    await submit();
    await submit();
    expect(text('.alert')).toBe(en['destination.wallet.unpayable']);
    expect(names(client)).not.toContain('addMethod');
  });

  it('says so when the person turns the signature down', async () => {
    freighter.signMessage.mockResolvedValue({
      signedMessage: null,
      signerAddress: '',
      error: { code: -4, message: 'The user rejected this request.' },
    });
    await open();
    await choose('freighter');
    await submit();
    await submit();
    await submit();
    expect(widget.currentStep).toBe('prove');
    expect(text('.alert')).toBe(en['prove.declined']);
  });
});

describe('with Albedo', () => {
  it('connects, saves the shared address and signs the proof with Albedo', async () => {
    const client = await open();
    const done: CompleteDetail[] = [];
    widget.addEventListener(COMPLETE_EVENT, (event) => {
      done.push((event as CustomEvent<CompleteDetail>).detail);
    });
    await choose('albedo');
    await submit();
    expect(widget.currentStep).toBe('address');
    expect(text('.heading')).toBe(en['connect.albedo.heading']);
    expect(text('.primary')).toBe(en['connect.albedo.action']);
    expect(albedo.publicKey).not.toHaveBeenCalled();

    await submit();
    expect(widget.currentStep).toBe('prove');
    expect(text('.statement-value')).toBe(WALLET);
    expect(text('.primary')).toBe(en['prove.albedo.action']);
    const added = client.calls.find((call) => call.name === 'addMethod');
    expect(added?.args[1]).toEqual({
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: WALLET },
    });

    await submit();
    expect(albedo.signMessage).toHaveBeenCalledWith({
      message: expect.stringContaining('confirm your payout address') as unknown,
      pubkey: WALLET,
    });
    const proof = client.calls.find((call) => call.name === 'submitWalletProof');
    expect(proof?.args[2]).toMatchObject({ signature: ALBEDO_BASE64 });
    expect(widget.currentStep).toBe('done');
    expect(done).toEqual([
      { wallet: 'albedo', destination: WALLET, memo: '', methodId: 'method-0001' },
    ]);
  });

  it('says so when its window is closed without an address, and saves nothing', async () => {
    albedo.publicKey.mockRejectedValue(new Error('Request was cancelled'));
    const client = await open();
    await choose('albedo');
    await submit();
    await submit();
    expect(widget.currentStep).toBe('address');
    expect(text('.alert')).toBe(en['connect.albedo.declined']);
    expect(names(client)).not.toContain('addMethod');
  });

  it('refuses an answer with only message_signature, and sends nothing', async () => {
    albedo.signMessage.mockResolvedValue({ pubkey: WALLET, message_signature: 'cd'.repeat(64) });
    const client = await open();
    await choose('albedo');
    await submit();
    await submit();
    await submit();
    expect(widget.currentStep).toBe('prove');
    expect(text('.alert')).toBe(en['prove.albedo.unusable']);
    expect(names(client)).not.toContain('submitWalletProof');
  });

  it('asks for the saved account when Albedo signs with another', async () => {
    albedo.signMessage.mockResolvedValue({ pubkey: OTHER, signedMessage: ALBEDO_HEX });
    const client = await open();
    await choose('albedo');
    await submit();
    await submit();
    await submit();
    expect(text('.alert')).toBe(en['prove.albedo.otherAccount']);
    expect(names(client)).not.toContain('submitWalletProof');
  });
});

describe('with another wallet', () => {
  it('saves the typed address and memo, then takes a pasted signature', async () => {
    const client = await open();
    await typeAddress(WALLET, '42');
    expect(widget.currentStep).toBe('prove');
    const added = client.calls.find((call) => call.name === 'addMethod');
    expect(added?.args[1]).toEqual({
      method: 'stellar_wallet',
      destination: { network: 'stellar:testnet', address: WALLET, memo: '42' },
    });
    expect(text('.sign-text')).toContain('confirm your payout address');
    await submit();
    expect(text('.alert')).toBe(en['prove.signature.missing']);
    await type('#signature', 'c2lnbmVk');
    await submit();
    expect(widget.currentStep).toBe('done');
    const proof = client.calls.find((call) => call.name === 'submitWalletProof');
    expect(proof?.args[2]).toMatchObject({ signature: 'c2lnbmVk', challengeId: 'challenge-0002' });
  });

  it('signs in one press with the page wallet when there is one', async () => {
    const signed: string[] = [];
    await open(
      {},
      {
        signMessage: (message) => {
          signed.push(message);
          return Promise.resolve({ signature: 'c2lnbmVk' });
        },
      },
    );
    await typeAddress();
    expect(text('.primary')).toBe(en['prove.action']);
    expect(root().querySelector('#signature')).toBeNull();
    await submit();
    expect(signed).toHaveLength(1);
    expect(widget.currentStep).toBe('done');
  });

  it('checks the address before anything is saved', async () => {
    const client = await open();
    await choose('other');
    await submit();
    await submit();
    expect(text('.alert')).toBe(en['destination.wallet.missing']);
    await type('#answer', `${WALLET.slice(0, 55)}A`);
    await submit();
    expect(text('.alert')).toBe(en['destination.wallet.invalid']);
    expect(field('#answer').getAttribute('aria-invalid')).toBe('true');
    await type('#answer', WALLET);
    await type('#memo', 'invoice 12');
    await submit();
    expect(text('.alert')).toBe(en['destination.memo.unsupported']);
    expect(field('#memo').getAttribute('aria-invalid')).toBe('true');
    await type('#memo', '');
    await type('#answer', encodeMuxedAddress(new Uint8Array(32).fill(7), 3n));
    await type('#memo', '5');
    await submit();
    expect(text('.alert')).toBe(en['destination.memo.notNeeded']);
    expect(names(client)).not.toContain('addMethod');
  });

  it('asks for a new signature when it did not match, with a fresh message', async () => {
    const client = await open();
    await typeAddress();
    await type('#signature', WRONG_SIGNATURE);
    await submit();
    expect(widget.currentStep).toBe('prove');
    expect(text('.alert')).toBe(en['prove.invalid']);
    expect(names(client).filter((name) => name === 'createWalletChallenge')).toHaveLength(2);
    expect(field('#signature').value).toBe('');
  });

  it('explains why a wallet cannot receive yet, in plain words', async () => {
    for (const [receivability, key] of [
      ['ACCOUNT_NOT_FOUND', 'receive.accountNotFound'],
      ['NO_TRUSTLINE', 'receive.noTrustline'],
      ['TRUSTLINE_LIMIT', 'receive.limit'],
      ['TRUSTLINE_NOT_AUTHORIZED', 'receive.notAuthorized'],
    ] as const) {
      await open({ receivability });
      await typeAddress();
      await type('#signature', 'c2lnbmVk');
      await submit();
      expect(widget.currentStep, receivability).toBe('prove');
      expect(text('.alert'), receivability).toBe(en[key]);
    }
  });

  it('explains a key that no longer signs for the wallet', async () => {
    await open({ signerAuthorized: false });
    await typeAddress();
    await type('#signature', 'c2lnbmVk');
    await submit();
    expect(text('.alert')).toBe(en['receive.signerNotAuthorized']);
  });

  it('goes back to the wallet choice from the address, but not from the proof', async () => {
    await open();
    await choose('other');
    await submit();
    const back = find('.text-button');
    expect(back.getAttribute('aria-label')).toBe('Back to your wallet');
    back.click();
    await settle();
    expect(widget.currentStep).toBe('wallet');
    await typeAddress();
    expect(root().querySelector('.chrome .text-button')).toBeNull();
  });
});

describe('events and focus', () => {
  it('reports every step change, with its place in the line', async () => {
    await open();
    const seen: StepChangeDetail[] = [];
    widget.addEventListener(STEP_CHANGE_EVENT, (event) => {
      seen.push((event as CustomEvent<StepChangeDetail>).detail);
    });
    await typeAddress();
    await type('#signature', 'c2lnbmVk');
    await submit();
    expect(seen).toEqual([
      { step: 'address', position: 2, total: 3 },
      { step: 'prove', position: 3, total: 3 },
      { step: 'done', position: 0, total: 3 },
    ]);
  });

  it('moves focus to the new question, so a screen reader reads it', async () => {
    await open();
    await choose('other');
    await submit();
    expect(root().activeElement?.textContent.trim()).toBe(en['destination.wallet.heading']);
  });

  it('keeps focus on the proof heading once the message to sign arrives', async () => {
    await open();
    await typeAddress();
    expect(text('.sign-text')).toContain('confirm your payout address');
    expect(root().activeElement).toBe(find('.heading'));
    expect(text('.heading')).toBe(en['prove.heading']);
  });

  it('keeps focus on the proof heading when the message comes after a retry', async () => {
    const client = await open();
    const real = client.createWalletChallenge.bind(client);
    let offline = true;
    client.createWalletChallenge = (recipientId, methodId) =>
      offline ? Promise.reject(new Error('offline')) : real(recipientId, methodId);
    await typeAddress();
    expect(text('.alert')).toBe(en['widget.loadFailed']);
    expect(root().activeElement).toBe(find('.heading'));
    offline = false;
    // The person presses Try again, which is gone once the message is there.
    find('.primary').focus();
    expect(root().activeElement).toBe(find('.primary'));
    await submit();
    expect(text('.sign-text')).toContain('confirm your payout address');
    expect(root().activeElement).toBe(find('.heading'));
  });

  it('leaves focus alone when the person has moved it elsewhere on the page', async () => {
    const outside = document.createElement('button');
    await open();
    document.body.append(outside);
    const client = widget.client;
    if (client === undefined) throw new Error('no client');
    const real = client.createWalletChallenge.bind(client);
    let release = (): void => undefined;
    client.createWalletChallenge = (recipientId, methodId) =>
      new Promise((resolve, reject) => {
        release = () => {
          real(recipientId, methodId).then(resolve, reject);
        };
      });
    await typeAddress();
    outside.focus();
    release();
    await settle();
    expect(text('.sign-text')).toContain('confirm your payout address');
    expect(document.activeElement).toBe(outside);
  });

  it('starts again with nothing filled in on reset', async () => {
    await open();
    await typeAddress();
    widget.reset();
    await settle();
    expect(widget.currentStep).toBe('wallet');
    expect(widget.currentAnswers).toEqual({ wallet: '', destination: '', memo: '' });
  });
});

describe('when it cannot start', () => {
  it('says the link is not complete without a token', async () => {
    widget = document.createElement(TAG_NAME);
    document.body.replaceChildren(widget);
    await settle();
    expect(text('.alert')).toBe(en['widget.notReady']);
    expect(root().querySelector('form')).toBeNull();
  });

  it('builds its client from the token and the API address', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'EMBED_TOKEN_INVALID' } }), { status: 401 }),
      );
    });
    widget = document.createElement(TAG_NAME);
    widget.setAttribute('token', 'ujes_test_abc');
    widget.setAttribute('api-base', 'https://api.example');
    document.body.replaceChildren(widget);
    await settle();
    vi.unstubAllGlobals();
    expect(calls[0]?.url).toBe('https://api.example/v1/embed/onboarding');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer ujes_test_abc');
    expect(text('.alert')).toBe(en['widget.expired']);
  });

  it('says so when UJIRA cannot be reached, and tries again when asked', async () => {
    const client = fakeClient();
    let fail = true;
    widget = document.createElement(TAG_NAME);
    widget.client = {
      ...client,
      session: () => (fail ? Promise.reject(new Error('offline')) : client.session()),
    };
    document.body.replaceChildren(widget);
    await settle();
    expect(text('.alert')).toBe(en['widget.loadFailed']);
    fail = false;
    await submit();
    expect(widget.currentStep).toBe('wallet');
    expect(root().querySelector('.choice')).not.toBeNull();
  });

  it('says the link has expired when the token is refused mid flow', async () => {
    const client = fakeClient();
    widget = document.createElement(TAG_NAME);
    widget.client = {
      ...client,
      addMethod: () => Promise.reject(new ApiProblem({ status: 401, code: 'EMBED_TOKEN_EXPIRED' })),
    };
    document.body.replaceChildren(widget);
    await settle();
    await typeAddress();
    expect(text('.alert')).toBe(en['widget.expired']);
    expect(root().querySelector('.primary')).toBeNull();
  });

  it('says wallet payouts are not open when the session does not offer them', async () => {
    await open({ methods: ['bank'] });
    expect(text('.alert')).toBe(en['widget.closed']);
    expect(root().querySelector('form')).toBeNull();
  });
});

describe('the default API address', () => {
  it('is the origin the script came from, and nothing for a file or a bad address', () => {
    expect(originOf('https://ujira.co/embed/v1/ujira-embed.js')).toBe('https://ujira.co');
    expect(originOf('http://127.0.0.1:4178/ujira-embed.js')).toBe('http://127.0.0.1:4178');
    expect(originOf('file:///tmp/ujira-embed.js')).toBe('');
    expect(originOf('not a url')).toBe('');
  });
});
