// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The wallets the widget can sign with.
//
// Freighter and Albedo it connects to itself, through each one's own
// library: the person picks one, it shares the address, and later signs the
// proof. Albedo needs nothing installed; it opens its own window.
// Any other wallet the person uses, the widget cannot reach, so they paste
// the address and sign the message in their own wallet app. A page that
// already holds a wallet connection can hand it over as `wallet`, and then
// that path signs with one press too.

import { isConnected, requestAccess, signMessage } from '@stellar/freighter-api';

import type { MessageKey } from './i18n/catalogue.js';

export interface SignedMessage {
  /** Base64 signature over the message, as SEP-53 defines it. */
  signature: string;
  /** The key that signed, when it is not the account's own. */
  signer?: string;
}

/** A wallet the page already holds a connection to. */
export interface WalletConnector {
  /** Signs a text message with the key for `address`. */
  signMessage(message: string, address: string): Promise<SignedMessage>;
}

/** Why a wallet did not do what was asked, in words the person can act on. */
export class WalletRefused extends Error {
  override readonly name = 'WalletRefused';
  readonly key: MessageKey;

  constructor(key: MessageKey) {
    super(key);
    this.key = key;
  }
}

/** The parts of Freighter's library the widget uses, so a test can stand in for it. */
export interface FreighterApi {
  isConnected: typeof isConnected;
  requestAccess: typeof requestAccess;
  signMessage: typeof signMessage;
}

export const FREIGHTER: FreighterApi = { isConnected, requestAccess, signMessage };

function base64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** Asks Freighter for the address it holds. Throws WalletRefused when it will not say. */
export async function freighterAddress(api: FreighterApi = FREIGHTER): Promise<string> {
  const present = await api.isConnected().catch(() => ({ isConnected: false }));
  if (!present.isConnected) throw new WalletRefused('connect.missing');
  const access = await api.requestAccess().catch(() => ({ address: '', error: 'failed' }));
  if (access.error !== undefined || access.address === '') {
    throw new WalletRefused('connect.declined');
  }
  return access.address;
}

/**
 * Has Freighter sign the message for `address`. Older releases hand the
 * signature back as bytes and newer ones as base64; both arrive as base64.
 */
export async function freighterSign(
  message: string,
  address: string,
  api: FreighterApi = FREIGHTER,
): Promise<SignedMessage> {
  const signed = await api.signMessage(message, { address }).catch(() => undefined);
  const value = signed?.error === undefined ? signed?.signedMessage : undefined;
  if (value === undefined || value === null || value.length === 0) {
    throw new WalletRefused('prove.declined');
  }
  const signature = typeof value === 'string' ? value : base64(value);
  const signer = signed?.signerAddress;
  return signer === undefined || signer === '' || signer === address
    ? { signature }
    : { signature, signer };
}

/** The parts of Albedo's library the widget uses, so a test can stand in for it. */
export interface AlbedoApi {
  publicKey(params: { token?: string }): Promise<{ pubkey: string }>;
  signMessage(params: { message: string; pubkey?: string }): Promise<unknown>;
}

/**
 * Loads Albedo's library, as its own file, only once someone picks Albedo.
 * On load it starts watching every click on the page for web+stellar links,
 * which is no business of a page whose visitor never chose Albedo.
 */
export async function loadAlbedo(): Promise<AlbedoApi> {
  const { default: albedo } = await import('@albedo-link/intent');
  return albedo;
}

async function albedoLibrary(load: () => Promise<AlbedoApi>): Promise<AlbedoApi> {
  try {
    return await load();
  } catch {
    throw new WalletRefused('widget.loadFailed');
  }
}

const SIGNATURE_HEX = /^[0-9a-f]{128}$/i;

/**
 * The SEP-53 signature in an Albedo answer, as base64: Albedo sends it as
 * `signedMessage`, 64 bytes in hex. Its `message_signature` is an older
 * scheme the server refuses, so it is never read.
 */
export function albedoSignature(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null || !('signedMessage' in answer)) {
    return undefined;
  }
  const hex = answer.signedMessage;
  if (typeof hex !== 'string' || !SIGNATURE_HEX.test(hex)) return undefined;
  const bytes = new Uint8Array(64);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return base64(bytes);
}

/** Asks Albedo for the address the person picks. Throws WalletRefused when it will not say. */
export async function albedoAddress(load: () => Promise<AlbedoApi> = loadAlbedo): Promise<string> {
  const api = await albedoLibrary(load);
  const shared = await api.publicKey({}).catch(() => undefined);
  const address = shared?.pubkey ?? '';
  if (address === '') throw new WalletRefused('connect.albedo.declined');
  return address;
}

/** Has Albedo sign the message with the account saved for payouts. */
export async function albedoSign(
  message: string,
  address: string,
  load: () => Promise<AlbedoApi> = loadAlbedo,
): Promise<SignedMessage> {
  const api = await albedoLibrary(load);
  const answer = await api.signMessage({ message, pubkey: address }).catch(() => undefined);
  if (typeof answer !== 'object' || answer === null) throw new WalletRefused('prove.declined');
  const pubkey = 'pubkey' in answer ? answer.pubkey : undefined;
  if (pubkey !== address) throw new WalletRefused('prove.albedo.otherAccount');
  const signature = albedoSignature(answer);
  if (signature === undefined) throw new WalletRefused('prove.albedo.unusable');
  return { signature };
}
