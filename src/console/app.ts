// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The console API: what a person with their own testnet wallet needs to try
// UJIRA end to end without a terminal. The server builds unsigned
// transactions for the wallet, relays the signed ones it built, pays test
// USDC from a treasury, and acts as the agent on mandates the console
// created, through the same engine, rails and receipts as the demo.
//
// It is public and has no login, so every write is either signed by the
// caller's own wallet or bounded by a rate limit, and every body is checked
// against a strict schema before anything else looks at it.

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  scValToNative,
  type Account,
  type Transaction,
} from '@stellar/stellar-sdk';
import { z } from 'zod';

import { accountAddress, defaultRecipientRef, taskId } from '../ids.js';
import { MandateClient } from '../mandate/client.js';
import { address, bytes32, encodeAllowEntries, i128 } from '../mandate/codec.js';
import { BodyTooLarge, readBody, send, type ExtraRoutes, type McpBinding } from '../mcp/http.js';
import { WindowLimiter, type HttpSettings } from '../mcp/public.js';
import { TOOLS, type GuardAnswer, type ToolGuard, type ToolName } from '../mcp/server.js';
import { formatUnits } from '../money.js';
import { RAIL_NAMES } from '../rails/rail.js';
import type { ReceiptLog } from '../receipts/log.js';
import { TESTNET_PASSPHRASE, type SorobanGateway, type TxSigner } from '../stellar/gateway.js';
import { allowEntriesOf, classify, parseEnvelope, type AllowedTx } from './allowlist.js';
import type { ConsoleChain } from './chain.js';
import { ApiError, toApiError } from './errors.js';
import {
  engineFor,
  mandateView,
  payoutsOf,
  type ConsoleSdp,
  type MandateServices,
} from './mandates.js';
import { defaultLabel, type ConsoleRegistry, type MandateEntry } from './registry.js';
import type { ConsoleSettings } from './settings.js';
import { createStatic } from './static.js';
import {
  INCLUSION_FEE,
  MAX_ALLOW_ENTRIES,
  checkCreateParams,
  createArgs,
  describe,
  describeCreate,
  invokeTx,
  issues,
  parseBuildRequest,
  trustlineTx,
  type BuildRequest,
} from './txbuild.js';

export const EXPLORER_TX = 'https://stellar.expert/explorer/testnet/tx/';
const EXPLORER_CONTRACT = 'https://stellar.expert/explorer/testnet/contract/';
const HOUR = 3_600_000;

export interface ConsoleOptions {
  readonly settings: ConsoleSettings;
  readonly http: HttpSettings;
  readonly agent: TxSigner;
  readonly executor: TxSigner;
  readonly gateway: SorobanGateway;
  readonly receipts: ReceiptLog;
  readonly registry: ConsoleRegistry;
  readonly chain: ConsoleChain;
  readonly sdp?: ConsoleSdp;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** For tests: the keypair a test recipient gets. */
  readonly newKeypair?: () => Keypair;
}

const addressBody = z.object({ address: accountAddress }).strict();
const emptyBody = z.object({}).strict();
const submitBody = z.object({ xdr: z.string().min(1).max(60_000) }).strict();
const recipientField = z.string().min(1).max(256);
const quoteBody = z
  .object({
    recipient: recipientField,
    amount: z.string().min(1).max(40),
    rail: z.enum(RAIL_NAMES).default('usdc'),
    taskId: taskId.optional(),
  })
  .strict();
const requestBody = quoteBody.extend({ taskId });

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', `The request was refused: ${issues(parsed.error)}`);
  }
  return parsed.data;
}

/** A contract's return value as one string, for display. */
function returnText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function createConsole(o: ConsoleOptions): ExtraRoutes {
  const { settings, registry, chain } = o;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  const newKeypair = o.newKeypair ?? (() => Keypair.random());
  const lim = settings.limits;
  const limiters = {
    api: new WindowLimiter(lim.apiCallsPerMinute, 60_000, now),
    faucet: new WindowLimiter(lim.faucetPerHour, HOUR, now),
    recipients: new WindowLimiter(lim.testRecipientsPerHour, HOUR, now),
    friendbot: new WindowLimiter(lim.friendbotPerHour, HOUR, now),
    payouts: new WindowLimiter(lim.mandatePayoutsPerHour, HOUR, now),
    toolCalls: new WindowLimiter(o.http.limits.toolCallsPerMinute, 60_000, now),
  };
  const services: MandateServices = {
    gateway: o.gateway,
    receipts: o.receipts,
    agent: o.agent,
    executor: o.executor,
    ...(o.sdp === undefined ? {} : { sdp: o.sdp }),
    now: () => new Date(now()),
  };
  const serveStatic = createStatic(settings.consoleDir);
  /** Labels typed for an allow_recipients transaction that has not landed yet. */
  const pendingLabels = new Map<string, Map<string, string>>();
  const faucetBusy = new Set<string>();
  const allowCtx = {
    factory: settings.factory,
    usdc: settings.usdc,
    agent: o.agent.publicKey,
    executor: o.executor.publicKey,
    isRegistered: (id: string) => registry.mandate(id) !== undefined,
  };

  function take(limiter: WindowLimiter, key: string, what: string): void {
    const hit = limiter.take(key);
    if (!hit.ok) {
      const minutes = Math.max(1, Math.ceil(hit.retryAfterMs / 60_000));
      throw new ApiError(429, 'rate_limited', `Too many ${what}; try again in ${minutes} minutes`);
    }
  }

  function origin(req: IncomingMessage): string {
    if (settings.publicOrigin !== undefined) return settings.publicOrigin;
    const host = req.headers.host ?? '';
    const safeHost = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? host : 'localhost';
    const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      ?.trim();
    const proto =
      o.http.clientIp.trustProxy && (forwarded === 'https' || forwarded === 'http')
        ? forwarded
        : 'http';
    return `${proto}://${safeHost}`;
  }

  function mandateOr404(id: string): MandateEntry {
    const entry = registry.mandate(id);
    if (entry === undefined) {
      throw new ApiError(404, 'mandate_not_found', 'This server did not create that mandate');
    }
    return entry;
  }

  async function body(req: IncomingMessage): Promise<unknown> {
    let raw: Buffer;
    try {
      raw = await readBody(req, o.http.maxBodyBytes);
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) throw error;
      req.resume();
      throw new ApiError(413, 'body_too_large', 'The request body is too large');
    }
    if (raw.length === 0) return {};
    try {
      return JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON');
    }
  }

  // Routes.

  function config() {
    return {
      network: 'testnet',
      networkPassphrase: TESTNET_PASSPHRASE,
      rpcUrl: settings.publicRpcUrl,
      horizonUrl: settings.horizonUrl,
      explorerTxBase: EXPLORER_TX,
      factory: settings.factory,
      asset: {
        code: settings.usdc.code,
        issuer: settings.usdc.issuer,
        contract: settings.usdc.contract,
        decimals: 7,
      },
      agent: o.agent.publicKey,
      executor: o.executor.publicKey,
      sdpAvailable: o.sdp !== undefined,
      sdpProofUrl: settings.sdpProofUrl,
      faucet: {
        amount: settings.faucetAmount.toString(),
        enabled: settings.treasury !== undefined,
      },
    };
  }

  async function account(addr: string) {
    const valid = parse(accountAddress, addr);
    const view = await chain.account(valid, settings.usdc);
    return {
      address: valid,
      exists: view.exists,
      xlm: view.xlm,
      usdc: view.usdc === null ? null : view.usdc.toString(),
    };
  }

  async function onboardXlm(raw: unknown, client: string) {
    const { address: addr } = parse(addressBody, raw);
    const view = await chain.account(addr, settings.usdc);
    if (view.exists) return { ok: true };
    take(limiters.friendbot, client, 'test XLM requests from your address');
    await chain.friendbot(addr);
    return { ok: true };
  }

  async function onboardTrustline(raw: unknown) {
    const { address: addr } = parse(addressBody, raw);
    const tx = trustlineTx(await chain.loadAccount(addr), settings.usdc);
    return {
      xdr: tx.toXdr(),
      description: `Add a USDC trustline (issuer ${settings.usdc.issuer}) so this wallet can hold test USDC`,
    };
  }

  async function faucet(raw: unknown, client: string) {
    const treasury = settings.treasury;
    if (treasury === undefined) {
      throw new ApiError(
        503,
        'faucet_disabled',
        'The test USDC faucet is not set up on this server',
      );
    }
    const { address: addr } = parse(addressBody, raw);
    if (registry.faucetClaim(addr) !== undefined) {
      throw new ApiError(409, 'faucet_used', 'This wallet already received test USDC');
    }
    if (faucetBusy.has(addr)) {
      throw new ApiError(409, 'faucet_busy', 'Test USDC for this wallet is already on its way');
    }
    faucetBusy.add(addr);
    try {
      const target = await chain.account(addr, settings.usdc);
      if (!target.exists) {
        throw new ApiError(400, 'account_not_found', 'Get test XLM first, so the wallet exists');
      }
      if (target.usdc === null) {
        throw new ApiError(400, 'trustline_missing', 'Add the USDC trustline first');
      }
      const held = (await chain.account(treasury.publicKey, settings.usdc)).usdc ?? 0n;
      if (held < settings.faucetFloor + settings.faucetAmount) {
        throw new ApiError(503, 'faucet_empty', 'The test USDC faucet is empty for now');
      }
      take(limiters.faucet, client, 'faucet claims from your address');
      const tx = new TransactionBuilder(await chain.loadAccount(treasury.publicKey), {
        fee: INCLUSION_FEE,
        networkPassphrase: TESTNET_PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: addr,
            asset: new Asset(settings.usdc.code, settings.usdc.issuer),
            amount: formatUnits(settings.faucetAmount),
          }),
        )
        .setTimeout(60)
        .build();
      treasury.sign(tx);
      const sent = await chain.submit(tx);
      if (sent.status !== 'SUCCESS') {
        throw new ApiError(502, 'faucet_failed', `The faucet payment failed (${sent.hash})`);
      }
      await registry.recordFaucet({
        address: addr,
        hash: sent.hash,
        at: new Date(now()).toISOString(),
      });
      return { hash: sent.hash, amount: settings.faucetAmount.toString() };
    } finally {
      faucetBusy.delete(addr);
    }
  }

  async function loadWithRetry(addr: string): Promise<Account> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await chain.loadAccount(addr);
      } catch (error) {
        // RPC can trail friendbot by a ledger.
        if (attempt >= 4 || !(error instanceof ApiError && error.code === 'account_not_found')) {
          throw error;
        }
        await sleep(2_000);
      }
    }
  }

  async function testRecipient(raw: unknown, client: string) {
    parse(emptyBody, raw);
    take(limiters.recipients, client, 'test recipients from your address');
    const keypair = newKeypair();
    const addr = keypair.publicKey();
    await chain.friendbot(addr);
    const tx = trustlineTx(await loadWithRetry(addr), settings.usdc);
    tx.sign(keypair);
    // The secret goes out of scope here and is never stored: the wallet only ever receives.
    const sent = await chain.submit(tx);
    if (sent.status !== 'SUCCESS') {
      throw new ApiError(
        502,
        'recipient_failed',
        `The test wallet's trustline failed (${sent.hash})`,
      );
    }
    return { address: addr, hash: sent.hash };
  }

  /** The allowlist entries to send, after dropping pairs already on chain. */
  async function allowEntries(req: Extract<BuildRequest, { action: 'allow_recipients' }>) {
    const entry = mandateOr404(req.params.mandate);
    if (req.source !== entry.principal) {
      throw new ApiError(
        403,
        'not_owner',
        'Only the wallet that owns this mandate can add recipients',
      );
    }
    const list = req.params.recipients;
    const labels = new Set<string>();
    const addresses = new Set<string>();
    for (const r of list) {
      if (labels.has(r.label) || addresses.has(r.address)) {
        throw new ApiError(
          400,
          'duplicate_recipient',
          'Each recipient and each name may appear once',
        );
      }
      labels.add(r.label);
      addresses.add(r.address);
      const taken = entry.recipients.find((e) => e.label === r.label && e.address !== r.address);
      if (taken !== undefined) {
        throw new ApiError(
          409,
          'label_taken',
          `The name ${r.label} is already used for another wallet`,
        );
      }
    }
    const destinations = (addr: string) =>
      o.sdp === undefined ? [addr] : [addr, o.sdp.distributionAccount];
    const wanted = list.flatMap((r) =>
      destinations(r.address).map((destination) => ({
        recipientRef: defaultRecipientRef(r.address),
        destination,
        label: r.label,
        address: r.address,
      })),
    );
    const client = new MandateClient(o.gateway, entry.id);
    const allowed = await Promise.all(
      wanted.map((w) => client.isAllowed(w.recipientRef, w.destination)),
    );
    const missing = wanted.filter((_, i) => allowed[i] !== true);
    const done = list.filter((r) => !missing.some((m) => m.address === r.address));
    // Already on chain: the new name applies now, with nothing to sign.
    if (done.length > 0) {
      await registry.upsertRecipients(
        entry.id,
        done.map((r) => ({
          label: r.label,
          address: r.address,
          recipientRef: defaultRecipientRef(r.address),
        })),
      );
    }
    if (missing.length === 0) {
      throw new ApiError(
        409,
        'already_allowed',
        'Every one of these recipients is already allowed',
      );
    }
    if (missing.length > MAX_ALLOW_ENTRIES) {
      throw new ApiError(
        400,
        'too_many_recipients',
        `Add at most ${o.sdp === undefined ? MAX_ALLOW_ENTRIES : MAX_ALLOW_ENTRIES / 2} recipients at a time`,
      );
    }
    const pending = pendingLabels.get(entry.id) ?? new Map<string, string>();
    for (const m of missing) pending.set(m.address, m.label);
    if (pendingLabels.size > 10_000) pendingLabels.clear();
    pendingLabels.set(entry.id, pending);
    return missing;
  }

  async function build(raw: unknown) {
    const req = parseBuildRequest(raw);
    if (req.action === 'create_mandate') {
      const ctx = {
        principal: req.source,
        agent: o.agent.publicKey,
        executor: o.executor.publicKey,
        asset: settings.usdc.contract,
        now: Math.floor(now() / 1000),
      };
      checkCreateParams(req.params, ctx);
      const tx = invokeTx(
        await chain.loadAccount(req.source),
        settings.factory,
        'create',
        createArgs(req.params, ctx),
      );
      const prepared = await chain.prepare(tx);
      return { xdr: prepared.toXdr(), description: describeCreate(req.params, o.agent.publicKey) };
    }
    const mandate = req.params.mandate;
    mandateOr404(mandate);
    let tx: (account: Account) => Transaction;
    const source = address(req.source);
    switch (req.action) {
      case 'allow_recipients': {
        const entries = await allowEntries(req);
        tx = (a) => invokeTx(a, mandate, 'allow_recipients', [encodeAllowEntries(entries)]);
        break;
      }
      case 'fund_mandate':
        tx = (a) =>
          invokeTx(a, settings.usdc.contract, 'transfer', [
            source,
            address(mandate),
            i128(req.params.amount),
          ]);
        break;
      case 'pause':
      case 'sweep':
        tx = (a) => invokeTx(a, mandate, req.action, [source]);
        break;
      case 'resume':
      case 'revoke':
        tx = (a) => invokeTx(a, mandate, req.action, []);
        break;
      case 'approve':
      case 'reject': {
        const id = bytes32(req.params.payoutId);
        tx = (a) => invokeTx(a, mandate, req.action, [source, id]);
        break;
      }
      case 'withdraw':
        tx = (a) => invokeTx(a, mandate, 'withdraw', [i128(req.params.amount)]);
        break;
    }
    const prepared = await chain.prepare(tx(await chain.loadAccount(req.source)));
    return { xdr: prepared.toXdr(), description: describe(req) };
  }

  async function afterSuccess(kind: AllowedTx, value: unknown, hash: string) {
    if (kind.kind === 'create') {
      if (typeof value !== 'string') return undefined;
      await registry.addMandate({
        id: value,
        principal: kind.principal,
        createdAt: new Date(now()).toISOString(),
        createTx: hash,
      });
      log('console mandate created');
      return value;
    }
    if (kind.kind === 'mandate' && kind.method === 'allow_recipients') {
      const entry = registry.mandate(kind.mandate);
      if (entry === undefined) return undefined;
      const pending = pendingLabels.get(kind.mandate);
      const people = allowEntriesOf(kind.args).filter(
        (e) => e.ref === defaultRecipientRef(e.destination),
      );
      await registry.upsertRecipients(
        kind.mandate,
        people.map((e) => ({
          label: pending?.get(e.destination) ?? defaultLabel(entry.recipients, e.destination),
          address: e.destination,
          recipientRef: e.ref,
        })),
      );
      for (const e of people) pending?.delete(e.destination);
    }
    return undefined;
  }

  async function submit(raw: unknown) {
    const { xdr: envelope } = parse(submitBody, raw);
    const tx = parseEnvelope(envelope);
    const kind = classify(tx, allowCtx);
    if (tx.signatures.length === 0) {
      throw new ApiError(
        400,
        'unsigned',
        'The transaction has no signature; sign it in your wallet',
      );
    }
    const sent = await chain.submit(tx);
    const value: unknown =
      sent.returnValue === undefined ? undefined : scValToNative(sent.returnValue);
    const mandate =
      sent.status === 'SUCCESS' ? await afterSuccess(kind, value, sent.hash) : undefined;
    return {
      hash: sent.hash,
      status: sent.status,
      returnValue: returnText(value),
      ...(mandate === undefined ? {} : { mandate }),
      ...(sent.reason === undefined ? {} : { reason: sent.reason }),
    };
  }

  function mandates(url: URL) {
    const principal = parse(accountAddress, url.searchParams.get('principal') ?? '');
    return {
      mandates: registry
        .mandatesOf(principal)
        .map((m) => ({ id: m.id, createdAt: m.createdAt, createTx: m.createTx })),
    };
  }

  async function mandate(id: string, req: IncomingMessage) {
    const entry = mandateOr404(id);
    const view = await mandateView(entry, o.gateway);
    return {
      ...view,
      mcpUrl: `${origin(req)}/m/${id}/mcp`,
      sdpAvailable: o.sdp !== undefined,
      explorerContractUrl: `${EXPLORER_CONTRACT}${id}`,
    };
  }

  async function tool(name: ToolName, entry: MandateEntry, args: Record<string, unknown>) {
    const t = TOOLS.find((x) => x.name === name);
    if (t === undefined) throw new ApiError(500, 'internal_error', 'Missing tool');
    return t.run(engineFor(entry, services), args);
  }

  async function agent(id: string, which: 'quote' | 'request', raw: unknown) {
    const entry = mandateOr404(id);
    if (which === 'quote') {
      const b = parse(quoteBody, raw);
      return tool('quote_payout', entry, {
        recipient: b.recipient,
        amount: b.amount,
        rail: b.rail,
        ...(b.taskId === undefined ? {} : { task_id: b.taskId }),
      });
    }
    const b = parse(requestBody, raw);
    take(limiters.payouts, id, 'payout requests on this mandate');
    return tool('request_payout', entry, {
      recipient: b.recipient,
      amount: b.amount,
      rail: b.rail,
      task_id: b.taskId,
    });
  }

  type Handler = (req: IncomingMessage, client: string, url: URL) => Promise<unknown>;

  function routeOf(method: string, path: string): Handler | 'wrong_method' | undefined {
    const one = (m: string, h: Handler) => (method === m ? h : 'wrong_method');
    const fixed: Record<string, () => Handler | 'wrong_method'> = {
      '/api/config': () => one('GET', () => Promise.resolve(config())),
      '/api/onboard/xlm': () =>
        one('POST', async (req, client) => onboardXlm(await body(req), client)),
      '/api/onboard/trustline': () => one('POST', async (req) => onboardTrustline(await body(req))),
      '/api/onboard/usdc': () =>
        one('POST', async (req, client) => faucet(await body(req), client)),
      '/api/recipients/test': () =>
        one('POST', async (req, client) => testRecipient(await body(req), client)),
      '/api/tx/build': () => one('POST', async (req) => build(await body(req))),
      '/api/tx/submit': () => one('POST', async (req) => submit(await body(req))),
      '/api/mandates': () => one('GET', (_req, _client, url) => Promise.resolve(mandates(url))),
    };
    const exact = fixed[path];
    if (exact !== undefined) return exact();
    const acct = /^\/api\/accounts\/([^/]+)$/.exec(path)?.[1];
    if (acct !== undefined) return one('GET', () => account(acct));
    const m = /^\/api\/mandates\/(C[A-Z2-7]{55})(\/[a-z/]+)?$/.exec(path);
    if (m?.[1] === undefined) return undefined;
    const id = m[1];
    switch (m[2]) {
      case undefined:
        return one('GET', (req) => mandate(id, req));
      case '/payouts':
        return one('GET', async () => ({ payouts: await payoutsOf(mandateOr404(id), services) }));
      case '/receipts':
        return one('GET', async () => tool('list_receipts', mandateOr404(id), {}));
      case '/agent/quote':
        return one('POST', async (req) => agent(id, 'quote', await body(req)));
      case '/agent/request':
        return one('POST', async (req) => agent(id, 'request', await body(req)));
      default:
        return undefined;
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, client: string) {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    try {
      take(limiters.api, client, 'requests from your address');
      const handler = routeOf(req.method ?? 'GET', path);
      if (handler === undefined) throw new ApiError(404, 'not_found', 'There is no such API route');
      if (handler === 'wrong_method') {
        throw new ApiError(405, 'method_not_allowed', 'That method is not allowed on this route');
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      send(res, 200, await handler(req, client, url), headers);
    } catch (error) {
      const e = toApiError(error);
      if (e.status >= 500) log(`api error ${e.code}`);
      send(res, e.status, { error: { code: e.code, message: e.message } }, headers);
    }
  }

  const refuse = (message: string): GuardAnswer => ({ answer: message, isError: true });

  function guardFor(id: string): ToolGuard {
    return (name) => {
      if (!limiters.toolCalls.take('all').ok) {
        return refuse(
          'rate_limited: this server is answering too many calls right now; try again in a minute',
        );
      }
      if (name === 'request_payout' && !limiters.payouts.take(id).ok) {
        return refuse(
          `rate_limited: this mandate takes at most ${lim.mandatePayoutsPerHour} payout requests an hour; try again later`,
        );
      }
      return undefined;
    };
  }

  function notesFor(entry: MandateEntry) {
    const names =
      entry.recipients.length === 0
        ? 'This mandate has no named recipients yet.'
        : `Recipients on this mandate, by name: ${entry.recipients
            .map((r) => `${r.label} (${r.address})`)
            .join(', ')}. Pass the name or the address as recipient.`;
    const shared = `This is mandate ${entry.id} on Stellar testnet; its owner set the rules on chain and approves larger payouts in their own wallet. Test money only.`;
    return {
      notes: {
        quote_payout: names,
        request_payout: `${shared} ${names}`,
      } as Partial<Record<ToolName, string>>,
      instructions: `UJIRA mandate. ${shared} ${names} Task IDs and receipts on this mandate are visible to anyone with its URL, so never put personal data in them.`,
    };
  }

  return {
    mandateMcp(id: string): McpBinding | undefined {
      const entry = registry.mandate(id);
      if (entry === undefined) return undefined;
      return {
        engine: engineFor(entry, services),
        options: { guard: guardFor(id), ...notesFor(entry) },
      };
    },
    async handle(req, res, path, client) {
      if (path === '/api' || path.startsWith('/api/')) {
        await api(req, res, path, client);
        return true;
      }
      return serveStatic(req, res, path);
    },
  };
}
