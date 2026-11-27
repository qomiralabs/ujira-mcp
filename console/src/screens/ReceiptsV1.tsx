// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every receipt in the open project on /v1. The filters and the open receipt
// live in the URL, so a reload or a shared link shows the same view. The CSV
// comes from the server's export of the same filtered set.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useApp } from '../app/context';
import { replaceSearch, useAllPages, useResource, useSearch } from '../app/hooks';
import { Link } from '../components/Link';
import { ReceiptSheet } from '../components/ReceiptSheet';
import { ReceiptTable } from '../components/ReceiptTable';
import { Empty, ErrorNotice, Icon, Notice, Skeleton, SoonRow, Spinner } from '../components/ui';
import { errorMessage, errorRequestId } from '../lib/api';
import { saveText } from '../lib/download';
import { mandateName } from '../lib/mandateV1';
import {
  OUTCOME_FILTERS,
  isReceiptFiltered,
  parseReceiptView,
  receiptCount,
  receiptServerQuery,
  receiptViewSearch,
  receiptsCsvName,
  sortReceipts,
  type ReceiptView,
} from '../lib/receiptsV1';
import type { V1Api } from '../lib/v1';
import type { V1Receipt } from '../lib/v1Schemas';

const PAGE_LIMIT = 200;
/** The most rows read for one view; past it the person narrows the filters. */
export const RECEIPT_CAP = 10_000;
const POLL_MS = 15_000;
const POLL_UP_TO = 1_000;
const LIST_LIMIT = 200;
// The recipient route takes at most 100 a page.
const RECIPIENT_LIMIT = 100;

type Option = { readonly id: string; readonly label: string };

function update(patch: Partial<ReceiptView>): void {
  const now = parseReceiptView(location.search);
  replaceSearch(receiptViewSearch({ ...now, ...patch }, location.search));
}

function clearFilters(): void {
  update({ outcome: '', mandateId: null, recipientId: null, from: null, to: null, open: null });
}

function Filters({
  view,
  mandates,
  recipients,
}: {
  view: ReceiptView;
  mandates: Option[] | null;
  recipients: Option[] | null;
}) {
  const id = useId();
  const pick = (list: Option[] | null, chosen: string | null) => {
    const options = list ?? [];
    // A shared link can name one this list does not have; it stays chosen and visible.
    if (chosen !== null && !options.some((o) => o.id === chosen)) {
      return [...options, { id: chosen, label: chosen.slice(0, 8) }];
    }
    return options;
  };
  return (
    <div className="payout-filters" role="group" aria-label="Filters">
      <div className="pf">
        <label htmlFor={`${id}-outcome`}>Outcome</label>
        <select
          id={`${id}-outcome`}
          value={view.outcome}
          onChange={(e) => {
            const value = OUTCOME_FILTERS.find((f) => f.value === e.target.value)?.value ?? '';
            update({ outcome: value, open: null });
          }}
        >
          {OUTCOME_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <div className="pf">
        <label htmlFor={`${id}-mandate`}>Mandate</label>
        <select
          id={`${id}-mandate`}
          value={view.mandateId ?? ''}
          disabled={mandates === null && view.mandateId === null}
          onChange={(e) => {
            update({ mandateId: e.target.value === '' ? null : e.target.value, open: null });
          }}
        >
          <option value="">Any mandate</option>
          {pick(mandates, view.mandateId).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="pf">
        <label htmlFor={`${id}-recipient`}>Recipient</label>
        <select
          id={`${id}-recipient`}
          value={view.recipientId ?? ''}
          disabled={recipients === null && view.recipientId === null}
          onChange={(e) => {
            update({ recipientId: e.target.value === '' ? null : e.target.value, open: null });
          }}
        >
          <option value="">Anyone</option>
          {pick(recipients, view.recipientId).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="pf">
        <label htmlFor={`${id}-from`}>From</label>
        <input
          id={`${id}-from`}
          type="date"
          value={view.from ?? ''}
          max={view.to ?? undefined}
          onChange={(e) => {
            update({ from: e.target.value === '' ? null : e.target.value, open: null });
          }}
        />
      </div>
      <div className="pf">
        <label htmlFor={`${id}-to`}>To</label>
        <input
          id={`${id}-to`}
          type="date"
          value={view.to ?? ''}
          min={view.from ?? undefined}
          onChange={(e) => {
            update({ to: e.target.value === '' ? null : e.target.value, open: null });
          }}
        />
      </div>
    </div>
  );
}

/** Every receipt in the open project, filtered as the URL says. */
export function ReceiptsV1({
  v1,
  projectId,
  save = saveText,
}: {
  v1: V1Api;
  projectId: string;
  /** Where the CSV goes; the browser's download unless a test listens. */
  save?: (name: string, text: string) => void;
}) {
  const { notify } = useApp();
  const search = useSearch();
  const view = useMemo(() => parseReceiptView(search), [search]);
  const query = useMemo(() => receiptServerQuery(view), [view]);
  const queryKey = JSON.stringify(query);

  const list = useAllPages(
    `v1:receipts:${projectId}:${queryKey}`,
    (cursor) => v1.receipts({ ...query, cursor, limit: PAGE_LIMIT }),
    { cap: RECEIPT_CAP, pollMs: POLL_MS, pollUpTo: POLL_UP_TO },
  );
  const mandates = useResource(`v1:receipt-mandates:${projectId}`, () =>
    v1.mandates({ limit: LIST_LIMIT }),
  );
  const recipients = useResource(`v1:receipt-recipients:${projectId}`, () =>
    v1.recipients({ limit: RECIPIENT_LIMIT }),
  );

  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of mandates.data?.items ?? []) byId.set(m.id, mandateName(m));
    return byId;
  }, [mandates.data]);
  const mandateLabel = useCallback(
    (r: V1Receipt) =>
      names.get(r.mandate.id) ?? mandateName({ name: null, contractId: r.mandate.contractId }),
    [names],
  );

  const items = list.items;
  const rows = useMemo(() => sortReceipts(items ?? []), [items]);

  const onOpen = useCallback((id: string) => {
    update({ open: id });
  }, []);
  const onClose = useCallback(() => {
    const id = parseReceiptView(location.search).open;
    update({ open: null });
    // Back to the row that opened it, when it is still drawn.
    setTimeout(() => {
      const opener = id === null ? null : document.querySelector(`[data-receipt="${id}"]`);
      if (opener instanceof HTMLElement) opener.focus();
    }, 0);
  }, []);

  // The export reads the server's CSV of this view; nothing is saved until it arrives.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<{
    message: string;
    requestId: string | null;
  } | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const exportCsv = () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    v1.receiptsCsv(query).then(
      (text) => {
        if (!live.current) return;
        setExporting(false);
        save(receiptsCsvName(), text);
        notify('Receipts saved as CSV.');
      },
      (e: unknown) => {
        if (!live.current) return;
        setExporting(false);
        setExportError({ message: errorMessage(e), requestId: errorRequestId(e) });
      },
    );
  };

  const filtered = isReceiptFiltered(view);
  const ready = list.complete && rows.length > 0;

  return (
    <div className="stack">
      {list.error !== null && items !== undefined ? (
        list.complete ? (
          <Notice tone="waiting">
            <p>Could not refresh: {list.error} Showing the last known state.</p>
          </Notice>
        ) : (
          <ErrorNotice
            error={`Could not load every receipt. ${list.error}`}
            onRetry={list.reload}
            requestId={list.errorRequestId}
          />
        )
      ) : null}
      {exportError === null ? null : (
        <ErrorNotice
          error={`Could not export. ${exportError.message}`}
          onRetry={exportCsv}
          requestId={exportError.requestId}
        />
      )}
      <section className="card card-flush" aria-labelledby="receipts-title">
        <div className="card-head">
          <h2 id="receipts-title" className="card-title">
            Receipts
            {items === undefined ? null : (
              <span className="title-count" aria-live="polite">
                {list.complete
                  ? receiptCount(rows.length)
                  : `${rows.length.toLocaleString('en-US')} so far`}
              </span>
            )}
          </h2>
          <div className="actions">
            {filtered ? (
              <button type="button" className="btn btn-ghost btn-small" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-small"
              disabled={!ready || exporting}
              onClick={exportCsv}
            >
              {exporting ? <Spinner /> : <Icon name="download" size={16} />}
              {exporting ? 'Exporting' : 'Export CSV'}
            </button>
          </div>
        </div>
        <Filters
          view={view}
          mandates={mandates.data?.items.map((m) => ({ id: m.id, label: mandateName(m) })) ?? null}
          recipients={recipients.data?.items.map((r) => ({ id: r.id, label: r.label })) ?? null}
        />
        {list.truncated ? (
          <Notice tone="info">
            <p>
              Showing the newest {RECEIPT_CAP.toLocaleString('en-US')}. Narrow the filters to see
              the rest.
            </p>
          </Notice>
        ) : null}
        {list.loading ? (
          <Skeleton lines={4} label="Loading receipts" />
        ) : items === undefined ? (
          <ErrorNotice
            error={list.error ?? 'Not loaded.'}
            onRetry={list.reload}
            requestId={list.errorRequestId}
          />
        ) : rows.length === 0 ? (
          filtered ? (
            <Empty
              text="No receipts match these filters."
              action={
                <button type="button" className="btn btn-small" onClick={clearFilters}>
                  Clear filters
                </button>
              }
            />
          ) : (
            <Empty
              text="No receipts yet. One is issued when a payout ends."
              action={
                <Link to="/payouts" className="btn btn-small">
                  See payouts
                </Link>
              }
            />
          )
        ) : (
          <ReceiptTable
            rows={rows}
            openId={view.open}
            onOpen={onOpen}
            mandateLabel={mandateLabel}
          />
        )}
      </section>
      <SoonRow
        title="Receipts you can hand on"
        items={['Signed receipts', 'PDF', 'A page per receipt']}
      />
      {view.open === null ? null : (
        <ReceiptSheet
          key={view.open}
          v1={v1}
          projectId={projectId}
          id={view.open}
          mandateLabel={mandateLabel}
          onClose={onClose}
        />
      )}
    </div>
  );
}
