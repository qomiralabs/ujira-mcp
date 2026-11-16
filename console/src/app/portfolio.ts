// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Everything the connected wallet owns, in one place: its mandates with their
// payouts and receipts. The API answers per mandate, so the dashboard asks
// for each one and joins the answers here.

import { createContext, useContext } from 'react';

import { errorMessage, type ConsoleApi } from '../lib/api';
import { addMinor } from '../lib/money';
import type { Mandate, MandateSummary, Payout, Receipt } from '../lib/schemas';
import { mandateStatus } from '../lib/words';
import type { Resource } from './hooks';

export interface MandateBundle {
  readonly summary: MandateSummary;
  /** Null when this one mandate could not be read; `error` then says why. */
  readonly mandate: Mandate | null;
  readonly payouts: readonly Payout[];
  readonly receipts: readonly Receipt[];
  readonly error: string | null;
}

export type Portfolio = Resource<readonly MandateBundle[]>;

/** How often the dashboard looks for new payouts and approvals. */
export const PORTFOLIO_POLL_MS = 15_000;

export async function loadPortfolio(api: ConsoleApi, principal: string): Promise<MandateBundle[]> {
  const list = await api.mandates(principal);
  return Promise.all(
    list.map(async (summary): Promise<MandateBundle> => {
      try {
        const [mandate, payouts, receipts] = await Promise.all([
          api.mandate(summary.id),
          api.payouts(summary.id),
          api.receipts(summary.id),
        ]);
        return { summary, mandate, payouts, receipts, error: null };
      } catch (e) {
        return { summary, mandate: null, payouts: [], receipts: [], error: errorMessage(e) };
      }
    }),
  );
}

export const PortfolioContext = createContext<Portfolio | null>(null);

/** The wallet's mandates and their activity; null while no wallet is connected. */
export function usePortfolio(): Portfolio | null {
  return useContext(PortfolioContext);
}

export interface Loaded {
  readonly mandate: Mandate;
  readonly bundle: MandateBundle;
}

export function loaded(bundles: readonly MandateBundle[]): Loaded[] {
  const out: Loaded[] = [];
  for (const b of bundles) if (b.mandate !== null) out.push({ mandate: b.mandate, bundle: b });
  return out;
}

/** Mandates that can still pay, so the ones worth acting on come first. */
export function usable(bundles: readonly MandateBundle[]): Mandate[] {
  return loaded(bundles)
    .map((l) => l.mandate)
    .filter((m) => {
      const s = mandateStatus(m.state);
      return s === 'active' || s === 'paused';
    });
}

export function isWaiting(p: Payout): boolean {
  return p.status === 'pending_approval' || p.status === 'approved';
}

export interface PayoutRow {
  readonly mandate: Mandate;
  readonly payout: Payout;
}

export interface ReceiptRow {
  readonly mandate: Mandate;
  readonly receipt: Receipt;
}

const newestFirst = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

export function allPayouts(bundles: readonly MandateBundle[]): PayoutRow[] {
  return loaded(bundles)
    .flatMap(({ mandate, bundle }) => bundle.payouts.map((payout) => ({ mandate, payout })))
    .sort((x, y) => newestFirst(x.payout.at ?? '', y.payout.at ?? ''));
}

export function waitingPayouts(bundles: readonly MandateBundle[]): PayoutRow[] {
  return allPayouts(bundles).filter((r) => isWaiting(r.payout));
}

export function receiptTime(r: Receipt): string {
  return r.updated_at ?? r.created_at ?? '';
}

export function allReceipts(bundles: readonly MandateBundle[]): ReceiptRow[] {
  return loaded(bundles)
    .flatMap(({ mandate, bundle }) => bundle.receipts.map((receipt) => ({ mandate, receipt })))
    .sort((x, y) => newestFirst(receiptTime(x.receipt), receiptTime(y.receipt)));
}

/** What all the wallet's mandates hold right now, in minor units. */
export function heldTotal(bundles: readonly MandateBundle[]): string {
  return loaded(bundles).reduce((sum, l) => addMinor(sum, l.mandate.state.balance), '0');
}

/** What all the wallet's mandates have paid out, in minor units. */
export function paidTotal(bundles: readonly MandateBundle[]): string {
  return loaded(bundles).reduce((sum, l) => addMinor(sum, l.mandate.state.spent), '0');
}
