// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The wallets the widget can sign with.
//
// Freighter it connects to itself, through Freighter's own library: the
// person picks it, Freighter shares the address, and later signs the proof.
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
