// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Pays through the Stellar Disbursement Platform (SDP). The mandate pays the
// approved amount to the SDP distribution account, then SDP pays the person
// from there, so every payout is two transactions and the settlement keeps
// both hashes.
//
// The order matters. The disbursement is created and loaded before the
// mandate moves any money, so an SDP that is down or refuses the recipient
// fails the payout while the funds are still in the mandate. Once the mandate
// has paid, every failure carries the mandate transaction hash and the SDP
// IDs, and `resume` finishes the same disbursement instead of paying twice.
//
// One payout is one disbursement, named after the payout ID. SDP refuses a
// second disbursement with the same name, which is what keeps a retry from
// paying the person twice even if the engine loses track of a first attempt.

import { z } from 'zod';

import { EngineError, type EngineErrorCode } from '../errors.js';
import { accountAddress } from '../ids.js';
import { formatUnits, STELLAR_DECIMALS } from '../money.js';
import {
  PartialSettlementError,
  type PayoutRail,
  type RailPayment,
  type RailSettlement,
  type SettlementProgress,
} from './rail.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 180_000;
/** SDP caps external payment IDs at 64 characters. */
const MAX_EXTERNAL_PAYMENT_ID = 64;

export type SdpAuth =
  | { readonly kind: 'api_key'; readonly apiKey: string }
  | { readonly kind: 'password'; readonly email: string; readonly password: string };

export interface SdpClientOptions {
  /** The SDP API root, such as http://localhost:8000. */
  readonly baseUrl: string;
  readonly auth: SdpAuth;
  /** The tenant name on a multi tenant SDP. A single tenant SDP needs none. */
  readonly tenant?: string;
  readonly requestTimeoutMs?: number;
  /** For tests. */
  readonly fetch?: typeof fetch;
}

/** A failed SDP call. The message never carries a credential or a response body. */
export class SdpError extends EngineError {
  /** The HTTP status, when SDP answered at all. */
  readonly httpStatus: number | undefined;
  /** SDP's own error text, kept apart from the message so callers choose whether to show it. */
  readonly sdpMessage: string | undefined;

  constructor(
    code: EngineErrorCode,
    message: string,
    options: { httpStatus?: number; sdpMessage?: string; cause?: unknown } = {},
  ) {
    super(code, message, { cause: options.cause });
    this.name = 'SdpError';
    this.httpStatus = options.httpStatus;
    this.sdpMessage = options.sdpMessage;
  }
}

const loginResponse = z.object({ token: z.string().min(1) });
const sdpAsset = z.object({ id: z.string().min(1), code: z.string(), issuer: z.string() });
const sdpDisbursement = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: z.string(),
});
const sdpPayment = z.object({
  id: z.string().min(1),
  amount: z.string(),
  status: z.string(),
  stellar_transaction_id: z.string().default(''),
  external_payment_id: z.string().optional(),
  status_history: z
    .array(z.object({ status: z.string(), status_message: z.string().optional() }))
    .optional(),
});
const sdpDisbursementReceiver = z.object({
  receiver_wallet: z.object({ stellar_address: z.string() }).nullish(),
  payment: sdpPayment.nullish(),
});
const errorBody = z.object({ error: z.string() });

export type SdpDisbursement = z.infer<typeof sdpDisbursement>;
export type SdpPayment = z.infer<typeof sdpPayment>;

export interface SdpPaymentLine {
  readonly payment: SdpPayment;
  /** The wallet SDP will pay, as SDP recorded it. */
  readonly wallet: string | undefined;
}

interface SdpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** A thin client for the parts of the SDP API a single payout needs. */
export class SdpClient {
  private readonly baseUrl: string;
  private readonly auth: SdpAuth;
  private readonly tenant: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private token: string | undefined;

  constructor(options: SdpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.auth = options.auth;
    this.tenant = options.tenant;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  /**
   * Logs in when the client uses a dashboard user. An API key needs no login;
   * SDP checks it on every call.
   */
  async authenticate(): Promise<void> {
    if (this.auth.kind === 'api_key' || this.token !== undefined) return;
    const res = await this.send('POST', '/login', 'log in', {
      json: { email: this.auth.email, password: this.auth.password },
      authorize: false,
    });
    this.token = expectOk(res, 'log in', loginResponse).token;
  }

  async findAssetId(code: string, issuer: string): Promise<string> {
    const res = await this.call('GET', '/assets', 'list assets');
    const assets = expectOk(res, 'list assets', z.array(sdpAsset));
    const found = assets.find((a) => a.code === code && a.issuer === issuer);
    if (found === undefined) {
      throw new SdpError('config_invalid', `SDP has no asset ${code} issued by ${issuer}`);
    }
    return found.id;
  }

  async findDisbursementByName(name: string): Promise<SdpDisbursement | null> {
    const res = await this.call(
      'GET',
      `/disbursements?q=${encodeURIComponent(name)}`,
      'search disbursements',
    );
    // The search is a substring match, so only an exact name counts.
    const page = expectOk(
      res,
      'search disbursements',
      z.object({ data: z.array(sdpDisbursement) }),
    );
    return page.data.find((d) => d.name === name) ?? null;
  }

  /** Creates a disbursement that pays wallets SDP is told about, with no registration step. */
  async createDisbursement(name: string, assetId: string): Promise<SdpDisbursement> {
    const res = await this.call('POST', '/disbursements', 'create a disbursement', {
      json: {
        name,
        asset_id: assetId,
        registration_contact_type: 'EMAIL_AND_WALLET_ADDRESS',
      },
    });
    if (res.status === 409) {
      // A concurrent attempt for the same payout got there first; use its disbursement.
      const existing = await this.findDisbursementByName(name);
      if (existing !== null) return existing;
    }
    return expectOk(res, 'create a disbursement', sdpDisbursement);
  }

  async uploadInstructions(disbursementId: string, csv: string): Promise<void> {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), `${disbursementId}.csv`);
    const res = await this.call(
      'POST',
      `/disbursements/${encodeURIComponent(disbursementId)}/instructions`,
      'upload the payment instructions',
      { form },
    );
    expectOk(res, 'upload the payment instructions', z.unknown());
  }

  async getDisbursement(disbursementId: string): Promise<SdpDisbursement> {
    const res = await this.call(
      'GET',
      `/disbursements/${encodeURIComponent(disbursementId)}`,
      'read the disbursement',
    );
    return expectOk(res, 'read the disbursement', sdpDisbursement);
  }

  /**
   * Asks SDP to start paying. Returns false when SDP refused because the
   * distribution account does not hold enough yet, which is expected for a
   * moment after the mandate paid while Horizon catches up.
   */
  async startDisbursement(disbursementId: string): Promise<boolean> {
    const res = await this.call(
      'PATCH',
      `/disbursements/${encodeURIComponent(disbursementId)}/status`,
      'start the disbursement',
      { json: { status: 'STARTED' } },
    );
    if (res.status === 409) return false;
    expectOk(res, 'start the disbursement', z.unknown());
    return true;
  }

  /** The one payment line of a single recipient disbursement, or null before instructions land. */
  async disbursementPayment(disbursementId: string): Promise<SdpPaymentLine | null> {
    const res = await this.call(
      'GET',
      `/disbursements/${encodeURIComponent(disbursementId)}/receivers`,
      'read the disbursement receivers',
    );
    const page = expectOk(
      res,
      'read the disbursement receivers',
      z.object({ data: z.array(sdpDisbursementReceiver) }),
    );
    if (page.data.length > 1) {
      throw new SdpError(
        'task_conflict',
        `SDP disbursement ${disbursementId} pays ${page.data.length} receivers, expected one`,
      );
    }
    const line = page.data[0];
    if (line?.payment == null) return null;
    return { payment: line.payment, wallet: line.receiver_wallet?.stellar_address };
  }

  async getPayment(paymentId: string): Promise<SdpPayment> {
    const res = await this.call(
      'GET',
      `/payments/${encodeURIComponent(paymentId)}`,
      'read the payment',
    );
    return expectOk(res, 'read the payment', sdpPayment);
  }

  /** An authorized call. A dashboard session that expired is renewed once. */
  private async call(
    method: string,
    path: string,
    what: string,
    body: { json?: unknown; form?: FormData } = {},
  ): Promise<SdpResponse> {
    await this.authenticate();
    const res = await this.send(method, path, what, { ...body, authorize: true });
    if (res.status === 401 && this.auth.kind === 'password') {
      this.token = undefined;
      await this.authenticate();
      return this.send(method, path, what, { ...body, authorize: true });
    }
    return res;
  }

  private async send(
    method: string,
    path: string,
    what: string,
    options: { json?: unknown; form?: FormData; authorize: boolean },
  ): Promise<SdpResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.tenant !== undefined) headers['SDP-Tenant-Name'] = this.tenant;
    if (options.authorize) {
      headers['Authorization'] =
        this.auth.kind === 'api_key' ? this.auth.apiKey : `Bearer ${this.token ?? ''}`;
    }
    let body: string | FormData | null = null;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      body = options.form;
    }

    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      return { status: res.status, body: parseJson(text) };
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new SdpError(
          'rail_unavailable',
          `SDP did not answer within ${this.timeoutMs} ms when trying to ${what}`,
          {
            cause: err,
          },
        );
      }
      throw new SdpError('rail_unavailable', `SDP could not be reached to ${what}`, { cause: err });
    }
  }
}

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function expectOk<T extends z.ZodType>(res: SdpResponse, what: string, schema: T): z.output<T> {
  if (res.status < 200 || res.status >= 300) {
    const parsed = errorBody.safeParse(res.body);
    const sdpMessage = parsed.success ? parsed.data.error : undefined;
    const code: EngineErrorCode =
      res.status === 401 || res.status === 403
        ? 'config_invalid'
        : res.status === 400 || res.status === 422
          ? 'input_invalid'
          : 'rail_unavailable';
    throw new SdpError(code, `SDP refused to ${what} (HTTP ${res.status})`, {
      httpStatus: res.status,
      ...(sdpMessage === undefined ? {} : { sdpMessage }),
    });
  }
  const parsed = schema.safeParse(res.body);
  if (!parsed.success) {
    throw new SdpError('rail_unavailable', `SDP answered ${what} in an unexpected shape`, {
      httpStatus: res.status,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * The SDP rail failed. When `progress.mandateTxHash` is set the money already
 * left the mandate and sits with SDP; call `resume` with it rather than
 * settling again.
 */
export class SdpRailError extends PartialSettlementError {
  /** The last payment status SDP reported, when it got that far. */
  readonly paymentStatus: string | undefined;

  constructor(
    code: EngineErrorCode,
    message: string,
    progress: SettlementProgress,
    options: { paymentStatus?: string; cause?: unknown } = {},
  ) {
    super(code, message, progress, { cause: options.cause });
    this.name = 'SdpRailError';
    this.paymentStatus = options.paymentStatus;
  }
}

export interface SdpSettlement extends RailSettlement {
  readonly sdpDisbursementId: string;
  readonly sdpPaymentId: string;
  /** The transaction in which SDP paid the person. */
  readonly sdpTxHash: string;
}

export interface SdpRailOptions {
  readonly client: SdpClient;
  /**
   * Moves the approved payout out of the mandate to the distribution account,
   * normally the mandate's execute signed by the executor key.
   */
  readonly payToDistribution: (payment: RailPayment) => Promise<{ readonly txHash: string }>;
  /** The SDP distribution account (G...), the only destination the mandate pays on this rail. */
  readonly distributionAccount: string;
  readonly asset: { readonly code: string; readonly issuer: string };
  /**
   * The people this rail may pay, by handle. The caller names a handle and the
   * wallet comes from here, so a request can never point SDP at a wallet the
   * operator did not list. A listed wallet address also works as a handle.
   */
  readonly recipients: Readonly<Record<string, string>>;
  readonly decimals?: number;
  readonly pollIntervalMs?: number;
  /** How long to wait for SDP to pay before reporting the outcome as unknown. */
  readonly settleTimeoutMs?: number;
  /** For tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const PAYMENT_FAILED = new Set(['FAILED', 'CANCELED']);
const DISBURSEMENT_RUNNING = new Set(['STARTED', 'COMPLETED']);

export class SdpRail implements PayoutRail {
  readonly name = 'sdp' as const;
  private readonly client: SdpClient;
  private readonly payToDistribution: SdpRailOptions['payToDistribution'];
  private readonly distributionAccount: string;
  private readonly asset: SdpRailOptions['asset'];
  private readonly wallets: ReadonlyMap<string, string>;
  private readonly decimals: number;
  private readonly pollIntervalMs: number;
  private readonly settleTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: SdpRailOptions) {
    if (!accountAddress.safeParse(options.distributionAccount).success) {
      throw new EngineError(
        'config_invalid',
        'the SDP distribution account must be a G... address',
      );
    }
    const wallets = new Map<string, string>();
    for (const [handle, wallet] of Object.entries(options.recipients)) {
      if (!accountAddress.safeParse(wallet).success) {
        throw new EngineError(
          'config_invalid',
          `SDP recipient ${handle} has no valid Stellar account`,
        );
      }
      wallets.set(handle, wallet);
      wallets.set(wallet, wallet);
    }
    this.client = options.client;
    this.payToDistribution = options.payToDistribution;
    this.distributionAccount = options.distributionAccount;
    this.asset = options.asset;
    this.wallets = wallets;
    this.decimals = options.decimals ?? STELLAR_DECIMALS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  destinationFor(recipient: string): string {
    this.walletFor(recipient);
    return this.distributionAccount;
  }

  payee(recipient: string): string {
    return this.walletFor(recipient);
  }

  /** The wallet SDP pays for a recipient handle. */
  walletFor(recipient: string): string {
    const wallet = this.wallets.get(recipient);
    if (wallet === undefined) {
      throw new EngineError(
        'input_invalid',
        'the sdp rail pays only recipients listed in its configuration',
      );
    }
    return wallet;
  }

  async settle(payment: RailPayment): Promise<SdpSettlement> {
    const wallet = this.check(payment);
    const disbursementId = await this.prepare(payment, wallet);
    // If this throws, nothing moved: the prepared disbursement waits, unstarted, for a retry.
    const { txHash: mandateTxHash } = await this.payToDistribution(payment);
    return this.complete(payment, wallet, disbursementId, mandateTxHash);
  }

  /**
   * Finishes a payout whose mandate leg already landed, after a failure or a
   * timeout. Safe to call more than once: it never starts a second payment.
   */
  async resume(payment: RailPayment, mandateTxHash: string): Promise<SdpSettlement> {
    const wallet = this.check(payment);
    let disbursementId: string;
    try {
      disbursementId = await this.prepare(payment, wallet);
    } catch (err) {
      throw asRailError(err, { mandateTxHash });
    }
    return this.complete(payment, wallet, disbursementId, mandateTxHash);
  }

  private check(payment: RailPayment): string {
    const wallet = this.walletFor(payment.recipient);
    if (payment.destination !== this.distributionAccount) {
      throw new EngineError('input_invalid', 'an sdp payout must pay the SDP distribution account');
    }
    if (payment.asset !== this.asset.code) {
      throw new EngineError(
        'input_invalid',
        `the sdp rail pays ${this.asset.code}, not ${payment.asset}`,
      );
    }
    if (payment.amount <= 0n) {
      throw new EngineError('input_invalid', 'the amount must be positive');
    }
    return wallet;
  }

  /** Creates and loads the disbursement, or finds the one an earlier attempt made. No money moves. */
  private async prepare(payment: RailPayment, wallet: string): Promise<string> {
    const name = disbursementName(payment.payoutId);
    let disbursement = await this.client.findDisbursementByName(name);
    if (disbursement === null) {
      const assetId = await this.client.findAssetId(this.asset.code, this.asset.issuer);
      disbursement = await this.client.createDisbursement(name, assetId);
    }
    if (disbursement.status === 'DRAFT') {
      await this.client.uploadInstructions(
        disbursement.id,
        instructionsCsv(
          wallet,
          formatUnits(payment.amount, this.decimals),
          externalPaymentId(payment),
        ),
      );
    }
    const line = await this.client.disbursementPayment(disbursement.id);
    if (line !== null) this.assertMatches(payment, wallet, disbursement.id, line);
    return disbursement.id;
  }

  private async complete(
    payment: RailPayment,
    wallet: string,
    disbursementId: string,
    mandateTxHash: string,
  ): Promise<SdpSettlement> {
    const progress: { mandateTxHash: string; sdpDisbursementId: string; sdpPaymentId?: string } = {
      mandateTxHash,
      sdpDisbursementId: disbursementId,
    };
    const deadline = this.now() + this.settleTimeoutMs;
    try {
      await this.start(disbursementId, deadline);
      const line = await this.client.disbursementPayment(disbursementId);
      if (line === null) {
        throw new SdpError('rail_unavailable', `SDP disbursement ${disbursementId} has no payment`);
      }
      this.assertMatches(payment, wallet, disbursementId, line);
      progress.sdpPaymentId = line.payment.id;

      let current = line.payment;
      // A slow start can use up the whole wait, so the payment is always read
      // at least once after starting before the outcome is called unknown.
      let polled = false;
      for (;;) {
        if (current.status === 'SUCCESS' && current.stellar_transaction_id !== '') {
          return {
            txHash: mandateTxHash,
            sdpDisbursementId: disbursementId,
            sdpPaymentId: current.id,
            sdpTxHash: current.stellar_transaction_id,
          };
        }
        if (PAYMENT_FAILED.has(current.status)) {
          throw new SdpRailError(
            'tx_failed',
            `SDP payment ${current.id} ended ${current.status}${failureReason(current)}`,
            progress,
            { paymentStatus: current.status },
          );
        }
        if (polled && this.now() >= deadline) {
          throw new SdpRailError(
            'submission_unknown',
            `SDP payment ${current.id} was still ${current.status} after ${this.settleTimeoutMs} ms; resume it rather than paying again`,
            progress,
            { paymentStatus: current.status },
          );
        }
        await this.sleep(this.pollIntervalMs);
        current = await this.client.getPayment(current.id);
        polled = true;
      }
    } catch (err) {
      throw asRailError(err, progress);
    }
  }

  /** Starts the disbursement unless an earlier attempt already did. */
  private async start(disbursementId: string, deadline: number): Promise<void> {
    for (;;) {
      const disbursement = await this.client.getDisbursement(disbursementId);
      if (DISBURSEMENT_RUNNING.has(disbursement.status)) return;
      if (disbursement.status !== 'READY') {
        throw new SdpError(
          'tx_failed',
          `SDP disbursement ${disbursementId} is ${disbursement.status} and cannot be started`,
        );
      }
      if (await this.client.startDisbursement(disbursementId)) return;
      if (this.now() >= deadline) {
        throw new SdpError(
          'submission_unknown',
          `SDP did not see the funds for disbursement ${disbursementId} within ${this.settleTimeoutMs} ms`,
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** A disbursement found by name must be this payout, never a different one under the same name. */
  private assertMatches(
    payment: RailPayment,
    wallet: string,
    disbursementId: string,
    line: SdpPaymentLine,
  ): void {
    const amount = parseUnits(line.payment.amount, this.decimals);
    if (amount !== payment.amount || (line.wallet !== undefined && line.wallet !== wallet)) {
      throw new SdpError(
        'task_conflict',
        `SDP disbursement ${disbursementId} does not match this payout's amount and recipient`,
      );
    }
  }
}

function asRailError(err: unknown, progress: SettlementProgress): SdpRailError {
  if (err instanceof SdpRailError) return err;
  if (err instanceof EngineError) {
    return new SdpRailError(err.code, err.message, progress, { cause: err });
  }
  return new SdpRailError('rail_unavailable', 'the SDP leg failed unexpectedly', progress, {
    cause: err,
  });
}

function failureReason(payment: SdpPayment): string {
  const last = payment.status_history?.at(-1)?.status_message;
  return last === undefined || last === '' ? '' : `: ${last.slice(0, 200)}`;
}

/** The disbursement name for a payout. SDP names are unique, which is what makes retries safe. */
export function disbursementName(payoutId: string): string {
  return `ujira-${payoutId}`;
}

function externalPaymentId(payment: RailPayment): string {
  return payment.taskId.length <= MAX_EXTERNAL_PAYMENT_ID ? payment.taskId : payment.payoutId;
}

/**
 * One CSV line for SDP. SDP wants a contact for every receiver, but people
 * here are known only by wallet, so the contact is derived from the wallet on
 * the reserved .invalid domain: no message can reach anyone and no personal
 * data goes to SDP.
 */
export function instructionsCsv(wallet: string, amount: string, paymentId: string): string {
  const email = `${wallet.toLowerCase()}@wallet.invalid`;
  const row = [email, wallet, amount, wallet, paymentId].map(csvField).join(',');
  return `email,id,amount,walletAddress,paymentID\n${row}\n`;
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** SDP's decimal amount string back to minor units. */
export function parseUnits(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null)
    throw new SdpError('rail_unavailable', 'SDP reported an amount that is not a number');
  const whole = match[1] ?? '0';
  const frac = (match[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) {
    throw new SdpError('rail_unavailable', 'SDP reported more decimals than the asset has');
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}
