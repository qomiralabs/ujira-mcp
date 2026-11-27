// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The people a mandate pays. Adding one with a wallet asks the chain two
// things first: can that wallet take the mandate's asset, and what exactly
// must the principal sign to put it on the mandate's allowlist. Both answers
// arrive before anything is written, so an outage leaves no half made
// recipient behind, and the recipient, its email, its destination and the
// signing request land in one transaction or not at all.
//
// A wallet that cannot receive yet is still saved, with the reason, because
// its owner can fix it. It reads as not payable until the chain says it can
// receive, and the payout path asks the chain again before it requests money.

import { randomBytes } from 'node:crypto';

import {
  callOptions,
  ChainError,
  type ChainAdapter,
  type SigningRequest,
} from '../chain/adapter.js';
import {
  constraintViolation,
  mandates,
  payoutMethods,
  recipientPii,
  recipients,
  signingRequests,
  type Database,
  type DestinationStatus,
  type Mandate,
  type NewSigningRequest,
  type PayoutMethod,
  type ProjectContext,
  type Recipient,
  type StorableCheck,
  type StoredSigningRequest,
} from '../db/index.js';
import type { Sealer } from '../keys/sealer.js';

export type RecipientErrorCode =
  | 'MANDATE_NOT_FOUND'
  | 'RECIPIENT_NOT_FOUND'
  | 'LABEL_TAKEN'
  | 'ADDRESS_INVALID'
  | 'DESTINATION_NEEDS_MEMO'
  | 'MANDATE_REFUSED'
  | 'CHAIN_UNAVAILABLE';

export class RecipientError extends Error {
  override readonly name = 'RecipientError';
  // The mandate spec's name for a refusal, such as MANDATE_REVOKED.
  readonly specError: string | undefined;

  constructor(
    readonly code: RecipientErrorCode,
    message: string,
    options: { specError?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.specError = options.specError;
  }
}

// What a caller can be told about paying a recipient, most urgent first.
export type RecipientPayStatus =
  'active' | 'suspended' | 'needs_wallet' | 'no_account' | 'no_trustline' | 'unchecked';

export interface RecipientView {
  readonly recipient: Recipient;
  // The oldest wallet on file, which is the one a payout goes to.
  readonly method: PayoutMethod | null;
}

export interface RecipientDetail extends RecipientView {
  readonly email: string | null;
}

export interface CreatedRecipient {
  readonly view: RecipientDetail;
  // Null when there is no wallet to allow yet.
  readonly signingRequest: StoredSigningRequest | null;
}

export interface NewRecipientInput {
  readonly mandateId: string;
  readonly label: string;
  readonly address?: string | undefined;
  readonly email?: string | undefined;
}

export interface RecipientListQuery {
  readonly mandateId?: string | undefined;
  readonly after?: string | undefined;
  readonly limit: number;
}

export interface RecipientPage {
  readonly items: readonly RecipientView[];
  readonly next: string | null;
}

export interface RecipientService {
  create(
    context: ProjectContext,
    input: NewRecipientInput,
    correlationId: string,
  ): Promise<CreatedRecipient>;
  get(context: ProjectContext, id: string, correlationId: string): Promise<RecipientDetail>;
  list(context: ProjectContext, query: RecipientListQuery): Promise<RecipientPage>;
}

export interface RecipientServiceOptions {
  readonly db: Database;
  readonly chain: ChainAdapter;
  readonly sealer: Sealer;
  // The asset a mandate pays, in the form the adapter's destination check
  // takes it, such as CODE:ISSUER on Stellar. Config, so no chain detail is
  // written down here.
  readonly destinationAsset: (mandate: Mandate) => string;
  // Bounds each chain call; the adapter's default when absent.
  readonly chainTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

// Bound into every sealed email, so a ciphertext copied to another recipient,
// project or principal does not open there.
export function emailAssociatedData(context: ProjectContext, recipientId: string): string {
  return `ujira/recipient-email/v1:${context.principalId}:${context.projectId}:${recipientId}`;
}

export function payStatus(view: RecipientView): RecipientPayStatus {
  if (view.recipient.status === 'suspended') return 'suspended';
  if (view.method === null) return 'needs_wallet';
  return payStatusOf(view.method.destinationStatus);
}

function payStatusOf(status: DestinationStatus): RecipientPayStatus {
  return status === 'receivable' ? 'active' : status;
}

export function isPayable(view: RecipientView): boolean {
  return payStatus(view) === 'active';
}

// Enough of an address for a person to recognise it, as wallets show them.
export function maskAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// Chain failures as this service's own errors. Anything else is a bug in how
// the request was built and is left to surface as one.
function fromChain(error: unknown): unknown {
  if (!(error instanceof ChainError)) return error;
  switch (error.code) {
    case 'TIMEOUT':
    case 'UNAVAILABLE':
      return new RecipientError('CHAIN_UNAVAILABLE', 'the chain did not answer in time', {
        cause: error,
      });
    case 'INVALID_ADDRESS':
      return new RecipientError('ADDRESS_INVALID', 'the address is not an account address', {
        cause: error,
      });
    case 'CONTRACT_REFUSED':
      return new RecipientError('MANDATE_REFUSED', 'the mandate refused the change', {
        ...(error.specError === undefined ? {} : { specError: error.specError }),
        cause: error,
      });
    default:
      return error;
  }
}

async function onChain<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw fromChain(error);
  }
}

// Null for a destination that needs a memo, which is never stored.
function storableCheck(
  check: Awaited<ReturnType<ChainAdapter['checkDestination']>>,
): StorableCheck | null {
  if (check.receivable) return check;
  if (check.reason === 'NEEDS_MEMO') return null;
  return { receivable: false, reason: check.reason };
}

function firstByRecipient(methods: readonly PayoutMethod[]): Map<string, PayoutMethod> {
  const first = new Map<string, PayoutMethod>();
  for (const method of methods) {
    if (!first.has(method.recipientId)) first.set(method.recipientId, method);
  }
  return first;
}

function storedRequest(mandateId: string, request: SigningRequest): NewSigningRequest {
  return {
    mandateId,
    action: request.action,
    network: request.network,
    signer: request.signer,
    envelope: request.xdr,
    summary: request.summary,
    expiresAt: new Date(request.expiresAt),
  };
}

const LABEL_CONSTRAINT = 'recipients_label_per_mandate';

export function createRecipientService(o: RecipientServiceOptions): RecipientService {
  const log = o.log ?? (() => undefined);
  const call = (correlationId: string) => callOptions(correlationId, o.chainTimeoutMs);

  function parseAddress(raw: string): string {
    try {
      return o.chain.parseAccount(raw);
    } catch (error) {
      throw fromChain(error);
    }
  }

  // A destination still waiting on its owner is asked about again whenever
  // someone looks at it, so a fixed wallet becomes payable without anyone
  // re-entering it. The stored answer stands when the chain does not reply.
  async function refreshed(
    context: ProjectContext,
    mandate: Mandate,
    method: PayoutMethod,
    correlationId: string,
  ): Promise<PayoutMethod> {
    if (method.destinationStatus === 'receivable') return method;
    let check: Awaited<ReturnType<ChainAdapter['checkDestination']>>;
    try {
      check = await o.chain.checkDestination(
        method.destination,
        o.destinationAsset(mandate),
        call(correlationId),
      );
    } catch (error) {
      if (!(error instanceof ChainError)) throw error;
      log(
        `event=recipient_destination_recheck_failed correlationId=${correlationId} code=${error.code}`,
      );
      return method;
    }
    const storable = storableCheck(check);
    if (storable === null) {
      // Never stored as payable; the payout path refuses it on its own check.
      log(`event=recipient_destination_needs_memo correlationId=${correlationId}`);
      return method;
    }
    return o.db.tenant(context).transaction(async (tx) => {
      await payoutMethods.recordCheck(tx, method.id, storable);
      const [again] = await payoutMethods.forRecipients(tx, [method.recipientId]);
      return again ?? method;
    });
  }

  return {
    async create(context, input, correlationId) {
      const destination = input.address === undefined ? null : parseAddress(input.address);
      // Read first and refuse early, so a request that cannot succeed costs
      // no chain call. The label is checked again by the unique index below.
      const mandate = await o.db.tenant(context).transaction(async (tx) => {
        const found = await mandates.get(tx, input.mandateId);
        if (found === undefined) {
          throw new RecipientError('MANDATE_NOT_FOUND', 'no such mandate in this project');
        }
        if ((await recipients.findByLabel(tx, found.id, input.label)) !== undefined) {
          throw new RecipientError('LABEL_TAKEN', 'a recipient on this mandate has that label');
        }
        return found;
      });
      if (mandate.network !== o.chain.network) {
        throw new RecipientError('MANDATE_REFUSED', 'the mandate is on a network not served here');
      }
      // Who the person is to the chain. Random, so it says nothing about them
      // and stays the same whichever wallet they are paid at later.
      const recipientRef = randomBytes(32).toString('hex');
      let check: StorableCheck | null = null;
      let request: SigningRequest | null = null;
      if (destination !== null) {
        const answer = await onChain(() =>
          o.chain.checkDestination(destination, o.destinationAsset(mandate), call(correlationId)),
        );
        check = storableCheck(answer);
        if (check === null) {
          throw new RecipientError(
            'DESTINATION_NEEDS_MEMO',
            'the destination asks for a memo, which a wallet payout does not send',
          );
        }
        request = await onChain(() =>
          o.chain.prepareMandateAction(
            mandate.contractAddress,
            { kind: 'allow_recipients', entries: [{ recipientRef, destination }] },
            call(correlationId),
          ),
        );
      }
      try {
        return await o.db.tenant(context).transaction(async (tx) => {
          const recipient = await recipients.create(tx, {
            mandateId: mandate.id,
            label: input.label,
            recipientRef,
          });
          if (input.email !== undefined) {
            await recipientPii.setEmail(
              tx,
              recipient.id,
              o.sealer.seal(
                Buffer.from(input.email, 'utf8'),
                emailAssociatedData(context, recipient.id),
              ),
            );
          }
          const method =
            destination === null || check === null
              ? null
              : await payoutMethods.addWallet(
                  tx,
                  {
                    recipientId: recipient.id,
                    destination,
                    destinationCheck: check,
                    verified: false,
                  },
                  o.chain,
                );
          const signingRequest =
            request === null
              ? null
              : await signingRequests.create(tx, storedRequest(mandate.id, request), o.chain);
          return { view: { recipient, method, email: input.email ?? null }, signingRequest };
        });
      } catch (error) {
        const violation = constraintViolation(error);
        if (violation?.kind === 'unique' && violation.constraint === LABEL_CONSTRAINT) {
          throw new RecipientError('LABEL_TAKEN', 'a recipient on this mandate has that label', {
            cause: error,
          });
        }
        throw error;
      }
    },

    async get(context, id, correlationId) {
      const found = await o.db.tenant(context).transaction(async (tx) => {
        const recipient = await recipients.get(tx, id);
        if (recipient === undefined) return undefined;
        const [method] = await payoutMethods.forRecipients(tx, [recipient.id]);
        return {
          recipient,
          method: method ?? null,
          sealed: await recipientPii.email(tx, recipient.id),
          // Only needed to ask the chain about a wallet that cannot receive yet.
          mandate:
            method === undefined || method.destinationStatus === 'receivable'
              ? undefined
              : await mandates.get(tx, recipient.mandateId),
        };
      });
      if (found === undefined) {
        throw new RecipientError('RECIPIENT_NOT_FOUND', 'no such recipient in this project');
      }
      const email =
        found.sealed === undefined
          ? null
          : o.sealer.open(found.sealed, emailAssociatedData(context, id)).toString('utf8');
      const method =
        found.method === null || found.mandate === undefined
          ? found.method
          : await refreshed(context, found.mandate, found.method, correlationId);
      return { recipient: found.recipient, method, email };
    },

    async list(context, query) {
      const page = {
        limit: query.limit,
        ...(query.after === undefined ? {} : { after: query.after }),
      };
      return o.db.tenant(context).transaction(async (tx) => {
        const found =
          query.mandateId === undefined
            ? await recipients.listInProject(tx, page)
            : await recipients.list(tx, query.mandateId, page);
        const first = firstByRecipient(
          await payoutMethods.forRecipients(
            tx,
            found.items.map((recipient) => recipient.id),
          ),
        );
        return {
          items: found.items.map((recipient) => ({
            recipient,
            method: first.get(recipient.id) ?? null,
          })),
          next: found.next,
        };
      });
    },
  };
}
