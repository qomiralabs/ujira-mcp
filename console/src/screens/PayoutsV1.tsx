// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every payout in the open project on /v1. The filters, the sort and the open
// payout live in the URL, so a reload or a shared link shows the same view.
// The whole filtered set is read so the sort and the CSV cover all of it.

import { useCallback, useId, useMemo } from 'react';

import { useApp } from '../app/context';
import { replaceSearch, useAllPages, useResource, useSearch } from '../app/hooks';
import { Link } from '../components/Link';
import { PayoutSheet } from '../components/PayoutSheet';
import { PayoutTable } from '../components/PayoutTable';
import { Empty, ErrorNotice, Icon, Notice, Skeleton, SoonRow } from '../components/ui';
import { saveText } from '../lib/download';
import { mandateName } from '../lib/mandateV1';
import {
  STATUS_FILTERS,
  csvFileName,
  isFiltered,
  parseView,
  payoutsCsv,
  serverQuery,
  sortPayouts,
  viewSearch,
  type PayoutView,
  type SortDir,
  type SortKey,
  type StatusFilter,
} from '../lib/payoutsV1';
import type { V1Api } from '../lib/v1';
import type { PayoutDetail } from '../lib/v1Schemas';

const PAGE_LIMIT = 200;
/** The most rows read for one view; past it the person narrows the filters. */
export const PAYOUT_CAP = 10_000;
const POLL_MS = 15_000;
// Refreshing a very large set every few seconds costs more than it shows.
const POLL_UP_TO = 1_000;
const LIST_LIMIT = 200;

const FIRST_DIR: Record<SortKey, SortDir> = {
  created: 'desc',
  settled: 'desc',
  amount: 'desc',
  recipient: 'asc',
  status: 'asc',
};

function count(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number): string {
  return n === 1 ? '1 payout' : `${count(n)} payouts`;
}

function update(patch: Partial<PayoutView>): void {
  const now = parseView(location.search);
  replaceSearch(viewSearch({ ...now, ...patch }, location.search));
}

function Filters({
  view,
  mandates,
  recipients,
}: {
  view: PayoutView;
  mandates: { readonly id: string; readonly label: string }[] | null;
  recipients: { readonly id: string; readonly label: string }[] | null;
}) {
  const id = useId();
  const pick = (
    list: { readonly id: string; readonly label: string }[] | null,
    chosen: string | null,
  ) => {
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
        <label htmlFor={`${id}-status`}>Status</label>
        <select
          id={`${id}-status`}
          value={view.status}
          onChange={(e) => {
            const value = STATUS_FILTERS.find((f) => f.value === e.target.value)?.value ?? '';
            update({ status: value satisfies StatusFilter, open: null });
          }}
        >
          {STATUS_FILTERS.map((f) => (
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

function clearFilters(): void {
  update({ status: '', mandateId: null, recipientId: null, from: null, to: null, open: null });
}

/** Every payout in the open project, filtered and sorted as the URL says. */
export function PayoutsV1({
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
  const view = useMemo(() => parseView(search), [search]);
  const query = serverQuery(view);
  const queryKey = JSON.stringify(query);

  const list = useAllPages(
    `v1:payouts:${projectId}:${queryKey}`,
    (cursor) => v1.payouts({ ...query, cursor, limit: PAGE_LIMIT }),
    { cap: PAYOUT_CAP, pollMs: POLL_MS, pollUpTo: POLL_UP_TO },
  );
  const mandates = useResource(`v1:payout-mandates:${projectId}`, () =>
    v1.mandates({ limit: LIST_LIMIT }),
  );
  const recipients = useResource(`v1:payout-recipients:${projectId}`, () =>
    v1.recipients({ limit: LIST_LIMIT }),
  );

  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of mandates.data?.items ?? []) byId.set(m.id, mandateName(m));
    return byId;
  }, [mandates.data]);
  const mandateLabel = useCallback(
    (p: PayoutDetail) =>
      names.get(p.mandate.id) ?? mandateName({ name: null, contractId: p.mandate.contractId }),
    [names],
  );

  const items = list.items;
  const rows = useMemo(
    () => sortPayouts(items ?? [], view.sort, view.dir),
    [items, view.sort, view.dir],
  );

  const onSort = useCallback((key: SortKey) => {
    const now = parseView(location.search);
    if (now.sort === key) update({ dir: now.dir === 'asc' ? 'desc' : 'asc' });
    else update({ sort: key, dir: FIRST_DIR[key] });
  }, []);
  const onOpen = useCallback((id: string) => {
    update({ open: id });
  }, []);
  const onClose = useCallback(() => {
    const id = parseView(location.search).open;
    update({ open: null });
    // Back to the row that opened it, when it is still drawn.
    setTimeout(() => {
      const opener = id === null ? null : document.querySelector(`[data-payout="${id}"]`);
      if (opener instanceof HTMLElement) opener.focus();
    }, 0);
  }, []);

  const filtered = isFiltered(view);
  const ready = list.complete && rows.length > 0;
  const exportCsv = () => {
    save(csvFileName(), payoutsCsv(rows, mandateLabel));
    notify(`Saved ${plural(rows.length)} as CSV.`);
  };

  return (
    <div className="stack">
      {list.error !== null && items !== undefined ? (
        list.complete ? (
          <Notice tone="waiting">
            <p>Could not refresh: {list.error} Showing the last known state.</p>
          </Notice>
        ) : (
          <ErrorNotice
            error={`Could not load every payout. ${list.error}`}
            onRetry={list.reload}
            requestId={list.errorRequestId}
          />
        )
      ) : null}
      <section className="card card-flush" aria-labelledby="payouts-title">
        <div className="card-head">
          <h2 id="payouts-title" className="card-title">
            Payouts
            {items === undefined ? null : (
              <span className="title-count" aria-live="polite">
                {list.complete ? plural(rows.length) : `${count(rows.length)} so far`}
              </span>
            )}
          </h2>
          <div className="actions">
            {filtered ? (
              <button type="button" className="btn btn-ghost btn-small" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
            <button type="button" className="btn btn-small" disabled={!ready} onClick={exportCsv}>
              <Icon name="download" size={16} />
              Export CSV
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
            <p>Showing the newest {count(PAYOUT_CAP)}. Narrow the filters to see the rest.</p>
          </Notice>
        ) : null}
        {list.loading ? (
          <Skeleton lines={4} label="Loading payouts" />
        ) : items === undefined ? (
          <ErrorNotice
            error={list.error ?? 'Not loaded.'}
            onRetry={list.reload}
            requestId={list.errorRequestId}
          />
        ) : rows.length === 0 ? (
          filtered ? (
            <Empty
              text="No payouts match these filters."
              action={
                <button type="button" className="btn btn-small" onClick={clearFilters}>
                  Clear filters
                </button>
              }
            />
          ) : (
            <Empty
              text="No payouts yet."
              action={
                <Link to="/developers" className="btn btn-small">
                  Connect an agent
                </Link>
              }
            />
          )
        ) : (
          <PayoutTable
            rows={rows}
            sort={view.sort}
            dir={view.dir}
            openId={view.open}
            onSort={onSort}
            onOpen={onOpen}
            mandateLabel={mandateLabel}
          />
        )}
      </section>
      <SoonRow title="Payouts next" items={['Send from here', 'Split payouts', 'Saved views']} />
      {view.open === null ? null : (
        <PayoutSheet
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
