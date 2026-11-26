// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { createContext, useContext } from 'react';

import type { ConsoleApi } from '../lib/api';
import type { Config } from '../lib/schemas';
import type { V1Api } from '../lib/v1';
import type { Wallet } from '../lib/wallet';
import type { V1Screen } from './switch';

export interface AppState {
  readonly api: ConsoleApi;
  /** The /v1 client; null when the console runs without one. */
  readonly v1: V1Api | null;
  /** The screens this build moved to /v1; see useV1. */
  readonly v1Screens: ReadonlySet<V1Screen>;
  readonly config: Config;
  readonly mock: boolean;
  readonly wallet: Wallet | null;
  setWallet: (wallet: Wallet | null) => void;
  /** A short message read out by screen readers and shown at the bottom. */
  notify: (message: string) => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const app = useContext(AppContext);
  if (app === null) throw new Error('useApp needs the AppContext provider');
  return app;
}

export function explorerTx(config: Config, hash: string): string {
  return `${config.explorerTxBase}${hash}`;
}

export function explorerAccount(config: Config, address: string): string {
  return config.explorerTxBase.replace(/\/tx\/?$/, `/account/${address}`);
}

export function explorerContract(config: Config, id: string): string {
  return config.explorerTxBase.replace(/\/tx\/?$/, `/contract/${id}`);
}
