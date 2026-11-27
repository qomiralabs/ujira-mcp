// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The mandate store on Postgres, through the repository layer. Each call is
// one tenant transaction, so the row policies decide what it reaches.

import {
  agentKeys,
  mandates,
  payoutMethods,
  payouts,
  recipients,
  signingRequests,
  type AccountParser,
  type Database,
  type Mandate,
  type ProjectContext,
} from '../db/index.js';
import { MandateTakenError, type MandateStore, type RecipientWallet } from './mandate-store.js';

type Tx = Parameters<Parameters<ReturnType<Database['tenant']>['transaction']>[0]>[0];

/** A unique constraint refused the row: here, a contract another row already holds. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

async function withWallet(
  tx: Tx,
  r: {
    id: string;
    mandateId: string;
    label: string;
    recipientRef: string;
    status: string;
  },
): Promise<RecipientWallet> {
  // The wallet rail has one method per recipient today; the first is the one paid.
  const methods = await payoutMethods.list(tx, r.id, { limit: 1 });
  return {
    id: r.id,
    mandateId: r.mandateId,
    label: r.label,
    recipientRef: r.recipientRef,
    status: r.status,
    destination: methods.items[0]?.destination ?? null,
  };
}

export function postgresMandateStore(db: Database, accounts: AccountParser): MandateStore {
  const inTenant = <T>(t: ProjectContext, work: (tx: Tx) => Promise<T>) =>
    db.tenant({ principalId: t.principalId, projectId: t.projectId }).transaction(work);

  async function attached(
    t: ProjectContext,
    network: string,
    contract: string,
  ): Promise<Mandate | undefined> {
    return inTenant(t, (tx) => mandates.findByContract(tx, network, contract));
  }

  return {
    activeAgentKey: async (t, network) => {
      const key = await inTenant(t, (tx) => agentKeys.active(tx, network));
      return key === undefined ? undefined : { id: key.id, publicKey: key.publicKey };
    },
    mandate: (t, id) => inTenant(t, (tx) => mandates.get(tx, id)),
    mandates: (t, page) => inTenant(t, (tx) => mandates.list(tx, page)),
    addMandate: async (t, input) => {
      try {
        return await inTenant(t, async (tx) => {
          const existing = await mandates.findByContract(tx, input.network, input.contractAddress);
          if (existing !== undefined) return { mandate: existing, created: false };
          return { mandate: await mandates.create(tx, input, accounts), created: true };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Either a request of this project won the race, or the contract is another's.
        const existing = await attached(t, input.network, input.contractAddress);
        if (existing === undefined) throw new MandateTakenError();
        return { mandate: existing, created: false };
      }
    },
    recipients: (t, ids) =>
      inTenant(t, async (tx) => {
        const found: RecipientWallet[] = [];
        for (const id of ids) {
          const r = await recipients.get(tx, id);
          if (r !== undefined) found.push(await withWallet(tx, r));
        }
        return found;
      }),
    payout: async (t, id) => {
      const found = await inTenant(t, (tx) => payouts.get(tx, id));
      return found === undefined
        ? undefined
        : { mandateId: found.mandateId, onchainPayoutId: found.onchainPayoutId };
    },
    mandateRecipients: (t, mandateId, limit) =>
      inTenant(t, async (tx) => {
        const page = await recipients.list(tx, mandateId, { limit });
        const out: RecipientWallet[] = [];
        for (const r of page.items) out.push(await withWallet(tx, r));
        return out;
      }),
    createSigningRequest: (t, input) =>
      inTenant(t, (tx) => signingRequests.create(tx, input, accounts)),
    signingRequest: (t, id) => inTenant(t, (tx) => signingRequests.get(tx, id)),
    markSubmitted: (t, id, txHash) =>
      inTenant(t, (tx) => signingRequests.markSubmitted(tx, id, txHash)),
    recordCreated: async (t, requestId, txHash, input) => {
      try {
        return await inTenant(t, async (tx) => {
          await signingRequests.markSubmitted(tx, requestId, txHash);
          const existing = await mandates.findByContract(tx, input.network, input.contractAddress);
          return existing ?? (await mandates.create(tx, input, accounts));
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await attached(t, input.network, input.contractAddress);
        if (existing === undefined) throw new MandateTakenError();
        return existing;
      }
    },
  };
}
