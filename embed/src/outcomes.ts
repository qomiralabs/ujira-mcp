// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the widget does when UJIRA refuses an answer: which step the person
// lands on and the words they read there. Pure, so every refusal the API can
// give is tested without a browser.

import { isExpiry, problemOf } from './api/client.js';
import {
  isReceivabilityReason,
  MEMO_UNSUPPORTED,
  type ReceivabilityReason,
} from './api/contract.js';
import type { MessageKey } from './i18n/catalogue.js';

/** The embed token is no longer good, so nothing more can be saved. */
export interface Expired {
  kind: 'expired';
}

export interface Shown {
  kind: 'message';
  key: MessageKey;
  /** The field the words are about. */
  field: 'answer' | 'memo';
}

const EXPIRED: Expired = { kind: 'expired' };

function shown(key: MessageKey, field: 'answer' | 'memo' = 'answer'): Shown {
  return { kind: 'message', key, field };
}

/** A refused save keeps the person on the address step, with the reason. */
export function afterSaveFailed(error: unknown): Expired | Shown {
  if (isExpiry(error)) return EXPIRED;
  const problem = problemOf(error);
  if (problem?.code === 'DESTINATION_INVALID') {
    return problem.reason === MEMO_UNSUPPORTED
      ? shown('destination.memo.unsupported', 'memo')
      : shown('destination.refused');
  }
  return shown('widget.saveFailed');
}

const NOT_RECEIVABLE: Readonly<Record<ReceivabilityReason, MessageKey>> = {
  ACCOUNT_NOT_FOUND: 'receive.accountNotFound',
  DESTINATION_IS_ISSUER: 'destination.wallet.unpayable',
  NO_TRUSTLINE: 'receive.noTrustline',
  TRUSTLINE_NOT_AUTHORIZED: 'receive.notAuthorized',
  TRUSTLINE_LIMIT: 'receive.limit',
};

export function receivabilityMessage(reason: ReceivabilityReason): MessageKey {
  return NOT_RECEIVABLE[reason];
}

/** Where a refused wallet proof leaves the person: on the same step, told why. */
export function afterProofFailed(error: unknown): Expired | Shown {
  if (isExpiry(error)) return EXPIRED;
  const problem = problemOf(error);
  switch (problem?.code) {
    case 'DESTINATION_NOT_RECEIVABLE': {
      const reason = problem.reason;
      return shown(isReceivabilityReason(reason) ? NOT_RECEIVABLE[reason] : 'destination.refused');
    }
    case 'WALLET_SIGNER_NOT_AUTHORIZED':
      return shown('receive.signerNotAuthorized');
    case 'WALLET_PROOF_INVALID':
      return shown('prove.invalid');
    case 'WALLET_PROOF_EXPIRED':
      return shown('prove.expired');
    default:
      return shown('widget.saveFailed');
  }
}
