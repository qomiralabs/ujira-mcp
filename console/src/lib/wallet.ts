// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The two wallets a reviewer can bring: Freighter (browser extension) and
// Albedo (a web signer, nothing to install). Both only ever see transactions
// the server built and the person approves; the console never holds a key.
// Each wallet library is loaded on first use so the first screen stays light.

import { encodeAddress } from './strkey';

export type WalletKind = 'freighter' | 'albedo' | 'mock';

export interface Wallet {
  readonly kind: WalletKind;
  readonly address: string;
  /** Returns the signed envelope; throws WalletError when the person declines. */
  sign: (
    xdr: string,
    options: { networkPassphrase: string; description?: string },
  ) => Promise<string>;
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

export const WALLET_NAMES: Record<WalletKind, string> = {
  freighter: 'Freighter',
  albedo: 'Albedo',
  mock: 'Demo wallet',
};

const DECLINED = 'You closed the wallet without signing. Nothing was sent.';

function declined(message: string | undefined): boolean {
  return message !== undefined && /declin|reject|cancel|denied|clos/i.test(message);
}

function freighterMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return 'Freighter returned an error.';
}

type FreighterApi = typeof import('@stellar/freighter-api');
type AlbedoApi = (typeof import('@albedo-link/intent'))['default'];

function freighterWallet(api: FreighterApi, address: string): Wallet {
  return {
    kind: 'freighter',
    address,
    async sign(xdr, { networkPassphrase }) {
      const res = await api.signTransaction(xdr, { networkPassphrase, address });
      const message = freighterMessage(res.error);
      if (message !== undefined) throw new WalletError(declined(message) ? DECLINED : message);
      if (res.signedTxXdr === '') throw new WalletError(DECLINED);
      return res.signedTxXdr;
    },
  };
}

export async function connectFreighter(expectedPassphrase: string): Promise<Wallet> {
  const api = await import('@stellar/freighter-api');
  const connected = await api.isConnected();
  if (!connected.isConnected) {
    throw new WalletError(
      'Freighter is not installed in this browser. Install it from freighter.app, or use Albedo, which needs no install.',
    );
  }
  const access = await api.requestAccess();
  const accessError = freighterMessage(access.error);
  if (accessError !== undefined || access.address === '') {
    throw new WalletError(
      declined(accessError) || accessError === undefined
        ? 'Freighter did not share an address. Open Freighter, unlock it and try again.'
        : accessError,
    );
  }
  const network = await api.getNetworkDetails();
  if (network.networkPassphrase !== expectedPassphrase) {
    throw new WalletError(
      'Freighter is on a different network. Open Freighter, switch the network to Testnet, then connect again.',
    );
  }
  return freighterWallet(api, access.address);
}

function albedoFailure(error: unknown): WalletError {
  const message =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : undefined;
  if (message === undefined || declined(message)) return new WalletError(DECLINED);
  return new WalletError(`Albedo: ${message}`);
}

function albedoWallet(albedo: AlbedoApi, address: string): Wallet {
  return {
    kind: 'albedo',
    address,
    async sign(xdr, { description }) {
      try {
        const res = await albedo.tx({
          xdr,
          pubkey: address,
          network: 'testnet',
          submit: false,
          ...(description === undefined ? {} : { description }),
        });
        return res.signed_envelope_xdr;
      } catch (error) {
        throw albedoFailure(error);
      }
    },
  };
}

export async function connectAlbedo(): Promise<Wallet> {
  const { default: albedo } = await import('@albedo-link/intent');
  let pubkey: string;
  try {
    pubkey = (await albedo.publicKey({})).pubkey;
  } catch (error) {
    throw albedoFailure(error);
  }
  return albedoWallet(albedo, pubkey);
}

/** The demo wallet's address in mock mode, fixed so it stays the same across reloads. */
export const MOCK_WALLET = encodeAddress('account', new Uint8Array(32).fill(7));

/** True when the page was opened with ?mock=1 or built with VITE_MOCK=1. */
export function mockRequested(search: string = location.search): boolean {
  return new URLSearchParams(search).get('mock') === '1' || import.meta.env.VITE_MOCK === '1';
}

/** For the mock mode only: signs nothing and hands the envelope straight back. */
export function mockWallet(address: string): Wallet {
  return {
    kind: 'mock',
    address,
    sign: (xdr) => Promise.resolve(xdr),
  };
}

const STORE_KEY = 'ujira.console.wallet';

export interface RememberedWallet {
  readonly kind: WalletKind;
  readonly address: string;
}

export function rememberWallet(w: RememberedWallet | null): void {
  try {
    if (w === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify({ kind: w.kind, address: w.address }));
  } catch {
    // Storage can be off in private windows; the person simply connects again.
  }
}

export function rememberedWallet(): RememberedWallet | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      'address' in value &&
      (value.kind === 'freighter' || value.kind === 'albedo' || value.kind === 'mock') &&
      typeof value.address === 'string'
    ) {
      return { kind: value.kind, address: value.address };
    }
  } catch {
    // A damaged entry is the same as none.
  }
  return null;
}

/**
 * A wallet restored from a previous visit. Freighter reconnects silently when
 * the site is still allowed; Albedo needs no session, it asks on each signature.
 */
export async function restoreWallet(
  saved: RememberedWallet,
  expectedPassphrase: string,
): Promise<Wallet | null> {
  if (saved.kind === 'mock') return mockWallet(saved.address);
  if (saved.kind === 'albedo') {
    const { default: albedo } = await import('@albedo-link/intent');
    return albedoWallet(albedo, saved.address);
  }
  const api = await import('@stellar/freighter-api');
  const allowed = await api.isAllowed();
  if (!allowed.isAllowed) return null;
  const current = await api.getAddress();
  if (current.address !== saved.address) return null;
  const network = await api.getNetworkDetails();
  if (network.networkPassphrase !== expectedPassphrase) return null;
  return freighterWallet(api, saved.address);
}
