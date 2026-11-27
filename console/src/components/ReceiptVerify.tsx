// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Checks a receipt against Stellar through the verify route. The answer is
// shown only once the server has read the transaction: matched, or the field
// that differs, with the transaction one click away on the explorer.

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { explorerTx, useApp } from '../app/context';
import { errorMessage, errorRequestId } from '../lib/api';
import { verifyWords } from '../lib/receiptsV1';
import type { V1Api } from '../lib/v1';
import type { ReceiptVerification, V1Receipt } from '../lib/v1Schemas';
import { ErrorNotice, Icon, Notice, Spinner } from './ui';

type Check =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'done'; readonly result: ReceiptVerification }
  | { readonly kind: 'failed'; readonly error: string; readonly requestId: string | null };

/**
 * The actions row of a receipt, led by Verify, with the answer under it.
 * `children` are the other actions in the row. Mount it keyed by the receipt.
 */
export function ReceiptActions({
  v1,
  receipt,
  children,
}: {
  v1: V1Api;
  receipt: V1Receipt;
  children?: ReactNode;
}) {
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const checking = check.kind === 'checking';
  const verify = () => {
    if (checking) return;
    setCheck({ kind: 'checking' });
    v1.verifyReceipt(receipt.id).then(
      (result) => {
        if (live.current) setCheck({ kind: 'done', result });
      },
      (e: unknown) => {
        if (live.current) {
          setCheck({ kind: 'failed', error: errorMessage(e), requestId: errorRequestId(e) });
        }
      },
    );
  };

  return (
    <div className="stack-sm">
      <div className="actions receipt-actions">
        {receipt.txHash === null ? (
          <span className="muted small">No transaction to verify</span>
        ) : (
          <button type="button" className="btn btn-small" disabled={checking} onClick={verify}>
            {checking ? <Spinner /> : <Icon name="proof" size={16} />}
            {checking ? 'Checking Stellar' : 'Verify'}
          </button>
        )}
        {children}
      </div>
      <Answer check={check} receipt={receipt} onRetry={verify} />
    </div>
  );
}

function Answer({
  check,
  receipt,
  onRetry,
}: {
  check: Check;
  receipt: V1Receipt;
  onRetry: () => void;
}) {
  const { config } = useApp();
  if (check.kind === 'idle' || check.kind === 'checking') return null;
  if (check.kind === 'failed') {
    return <ErrorNotice error={check.error} onRetry={onRetry} requestId={check.requestId} />;
  }
  const words = verifyWords(check.result);
  const hash = check.result.txHash ?? receipt.txHash;
  return (
    <Notice tone={words.matched ? 'paid' : 'blocked'} title={words.title}>
      {words.text === '' ? null : <p>{words.text}</p>}
      {hash === null ? null : (
        <p>
          <a
            className="verify-link"
            href={explorerTx(config, hash)}
            target="_blank"
            rel="noreferrer"
            title={hash}
          >
            See it on Stellar Expert
            <Icon name="external" size={14} />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}
    </Notice>
  );
}
