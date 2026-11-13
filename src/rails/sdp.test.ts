// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { EngineError } from '../errors.js';
import type { RailPayment } from './rail.js';
import {
  disbursementName,
  instructionsCsv,
  parseUnits,
  SdpClient,
  SdpError,
  SdpRail,
  SdpRailError,
  type SdpAuth,
} from './sdp.js';

const DISTRIBUTION = 'GBOORJU2KRZUIV7RDAGM3U4JRO6S7N5SSKG7SW7HDNKFXAY7225RGEKW';
const WALLET = 'GDWQCLVZKFKKIQGXOSRZRLOBJ4V5J6UQ2L5D3RC4Y3IGEJXFZ4VJFPLX';
const OTHER_WALLET = 'GD3GVK2SYUMIAHMRCC5ZYEAMQW6LIKC4YJ57D7A474GXIVCYKPC6XRQ3';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const API_KEY = 'SDP_test-key.secret';
const PAYOUT_ID = 'ab'.repeat(32);
const MANDATE_TX = '11'.repeat(32);
const SDP_TX = '22'.repeat(32);

type Outcome = 'success' | 'fail' | 'hang';

interface FakePayment {
  id: string;
  amount: string;
  status: string;
  stellar_transaction_id: string;
  external_payment_id: string;
  status_history: { status: string; status_message: string }[];
}

interface FakeDisbursement {
  id: string;
  name: string;
  status: string;
  wallet?: string;
  payment?: FakePayment;
}

/** An in-memory SDP that speaks the handful of endpoints the rail uses. */
class FakeSdp {
  outcome: Outcome = 'success';
  /** How many start attempts SDP refuses for want of funds before it accepts. */
  insufficientStarts = 0;
  /** Polls that still report PENDING before the outcome shows. */
  pendingPolls = 1;
  /** Paths whose next request never gets an answer. */
  hangOn = new Set<string>();
  assets = [{ id: 'asset-usdc', code: 'USDC', issuer: USDC_ISSUER }];
  disbursements = new Map<string, FakeDisbursement>();
  uploads: string[] = [];
  calls: string[] = [];
  password = 'correct horse battery';
  tokens = new Set<string>();
  private seq = 0;
  private server: Server | undefined;

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server?.close(() => {
        resolve();
      }),
    );
  }

  expireTokens(): void {
    this.tokens.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    this.calls.push(route);
    if (this.hangOn.has(route)) return;

    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (route === 'POST /login') {
      const body = JSON.parse(raw) as { email: string; password: string };
      if (body.password !== this.password) {
        send(401, { error: 'wrong credentials' });
        return;
      }
      const token = `token-${++this.seq}`;
      this.tokens.add(token);
      send(200, { token });
      return;
    }

    const auth = req.headers.authorization ?? '';
    const authorized = auth === API_KEY || this.tokens.has(auth.replace(/^Bearer /, ''));
    if (!authorized) {
      send(401, { error: 'Not authorized.' });
      return;
    }

    if (route === 'GET /assets') {
      send(200, this.assets);
      return;
    }

    if (route === 'GET /disbursements') {
      const q = url.searchParams.get('q') ?? '';
      const data = [...this.disbursements.values()]
        .filter((d) => d.name.includes(q))
        .map((d) => this.view(d));
      send(200, { pagination: { pages: 1, total: data.length }, data });
      return;
    }

    if (route === 'POST /disbursements') {
      const body = JSON.parse(raw) as { name: string; registration_contact_type: string };
      if ([...this.disbursements.values()].some((d) => d.name === body.name)) {
        send(409, { error: 'disbursement already exists' });
        return;
      }
      if (body.registration_contact_type !== 'EMAIL_AND_WALLET_ADDRESS') {
        send(400, { error: 'bad contact type' });
        return;
      }
      const d: FakeDisbursement = { id: `d-${++this.seq}`, name: body.name, status: 'DRAFT' };
      this.disbursements.set(d.id, d);
      send(201, this.view(d));
      return;
    }

    const match = /^\/disbursements\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    const d = match?.[1] === undefined ? undefined : this.disbursements.get(match[1]);
    if (match !== null && d === undefined) {
      send(404, { error: 'disbursement not found' });
      return;
    }

    if (d !== undefined && req.method === 'POST' && match?.[2] === '/instructions') {
      const csv = /\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1] ?? '';
      this.uploads.push(csv);
      const [, line] = csv.trim().split('\n');
      const [, , amount, wallet, paymentId] = (line ?? '').split(',');
      d.wallet = wallet ?? '';
      d.payment = {
        id: `p-${++this.seq}`,
        amount: Number(amount).toFixed(7),
        status: 'DRAFT',
        stellar_transaction_id: '',
        external_payment_id: paymentId ?? '',
        status_history: [{ status: 'DRAFT', status_message: '' }],
      };
      d.status = 'READY';
      send(200, { message: 'File uploaded successfully' });
      return;
    }

    if (d !== undefined && req.method === 'PATCH' && match?.[2] === '/status') {
      if (d.status !== 'READY') {
        send(400, { error: 'invalid status transition' });
        return;
      }
      if (this.insufficientStarts > 0) {
        this.insufficientStarts--;
        send(409, { error: 'distribution account needs to be recharged' });
        return;
      }
      d.status = 'STARTED';
      if (d.payment !== undefined) d.payment.status = 'READY';
      send(200, { message: 'Disbursement started' });
      return;
    }

    if (d !== undefined && req.method === 'GET' && match?.[2] === '/receivers') {
      const data =
        d.payment === undefined
          ? []
          : [{ receiver_wallet: { stellar_address: d.wallet }, payment: d.payment }];
      send(200, { pagination: { pages: 1, total: data.length }, data });
      return;
    }

    if (d !== undefined && req.method === 'GET' && match?.[2] === undefined) {
      send(200, this.view(d));
      return;
    }

    const paymentMatch = /^\/payments\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && paymentMatch !== null) {
      const payment = [...this.disbursements.values()]
        .map((x) => x.payment)
        .find((p) => p?.id === paymentMatch[1]);
      if (payment === undefined) {
        send(404, { error: 'payment not found' });
        return;
      }
      this.advance(payment);
      send(200, payment);
      return;
    }

    send(404, { error: 'no such route' });
  }

  private advance(payment: FakePayment): void {
    if (payment.status === 'DRAFT') return;
    if (this.pendingPolls > 0 || this.outcome === 'hang') {
      this.pendingPolls--;
      payment.status = 'PENDING';
      return;
    }
    if (this.outcome === 'success') {
      payment.status = 'SUCCESS';
      payment.stellar_transaction_id = SDP_TX;
    } else {
      payment.status = 'FAILED';
      payment.status_history.push({ status: 'FAILED', status_message: 'op_no_trust' });
    }
  }

  private view(d: FakeDisbursement): Record<string, unknown> {
    return { id: d.id, name: d.name, status: d.status, asset: { id: 'asset-usdc' } };
  }
}

const servers: FakeSdp[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function fakeSdp(): Promise<{ sdp: FakeSdp; baseUrl: string }> {
  const sdp = new FakeSdp();
  servers.push(sdp);
  return { sdp, baseUrl: await sdp.listen() };
}

function payment(overrides: Partial<RailPayment> = {}): RailPayment {
  return {
    taskId: 'task-42',
    payoutId: PAYOUT_ID,
    recipient: 'recipient-1',
    destination: DISTRIBUTION,
    amount: 12_500_000n,
    asset: 'USDC',
    ...overrides,
  };
}

function rail(
  baseUrl: string,
  options: {
    auth?: SdpAuth;
    payToDistribution?: (p: RailPayment) => Promise<{ txHash: string }>;
    settleTimeoutMs?: number;
    requestTimeoutMs?: number;
  } = {},
): { rail: SdpRail; paid: RailPayment[] } {
  const paid: RailPayment[] = [];
  const client = new SdpClient({
    baseUrl: `${baseUrl}/`,
    auth: options.auth ?? { kind: 'api_key', apiKey: API_KEY },
    requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
  });
  const r = new SdpRail({
    client,
    distributionAccount: DISTRIBUTION,
    asset: { code: 'USDC', issuer: USDC_ISSUER },
    recipients: { 'recipient-1': WALLET },
    pollIntervalMs: 5,
    settleTimeoutMs: options.settleTimeoutMs ?? 2_000,
    payToDistribution:
      options.payToDistribution ??
      ((p) => {
        paid.push(p);
        return Promise.resolve({ txHash: MANDATE_TX });
      }),
  });
  return { rail: r, paid };
}

describe('SdpRail.settle', () => {
  it('pays the distribution account, then has SDP pay the wallet, and returns both hashes', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    const { rail: r, paid } = rail(baseUrl);

    const settlement = await r.settle(payment());

    expect(settlement).toEqual({
      txHash: MANDATE_TX,
      sdpDisbursementId: expect.stringMatching(/^d-/) as unknown,
      sdpPaymentId: expect.stringMatching(/^p-/) as unknown,
      sdpTxHash: SDP_TX,
    });
    expect(paid).toHaveLength(1);
    expect(sdp.uploads).toEqual([
      `email,id,amount,walletAddress,paymentID\n${WALLET.toLowerCase()}@wallet.invalid,${WALLET},1.25,${WALLET},task-42\n`,
    ]);
    const [d] = [...sdp.disbursements.values()];
    expect(d?.name).toBe(disbursementName(PAYOUT_ID));
    expect(d?.payment?.external_payment_id).toBe('task-42');
  });

  it('loads the disbursement before the mandate moves any money', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    let uploadsWhenPaid = -1;
    const { rail: r } = rail(baseUrl, {
      payToDistribution: () => {
        uploadsWhenPaid = sdp.uploads.length;
        return Promise.resolve({ txHash: MANDATE_TX });
      },
    });

    await r.settle(payment());

    expect(uploadsWhenPaid).toBe(1);
  });

  it('never calls the mandate when SDP is unreachable', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    await sdp.close();
    servers.splice(servers.indexOf(sdp), 1);
    const { rail: r, paid } = rail(baseUrl);

    await expect(r.settle(payment())).rejects.toMatchObject({ code: 'rail_unavailable' });
    expect(paid).toHaveLength(0);
  });

  it('reports a failed SDP payment with the mandate hash and SDP IDs', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    sdp.outcome = 'fail';
    const { rail: r } = rail(baseUrl);

    const err = await r.settle(payment()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SdpRailError);
    const railErr = err as SdpRailError;
    expect(railErr.code).toBe('tx_failed');
    expect(railErr.paymentStatus).toBe('FAILED');
    expect(railErr.message).toContain('op_no_trust');
    expect(railErr.progress).toEqual({
      mandateTxHash: MANDATE_TX,
      sdpDisbursementId: expect.stringMatching(/^d-/) as unknown,
      sdpPaymentId: expect.stringMatching(/^p-/) as unknown,
    });
  });

  it('gives up after the settle timeout and says the outcome is unknown', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    sdp.outcome = 'hang';
    const { rail: r } = rail(baseUrl, { settleTimeoutMs: 60 });

    const err = (await r.settle(payment()).catch((e: unknown) => e)) as SdpRailError;

    expect(err).toBeInstanceOf(SdpRailError);
    expect(err.code).toBe('submission_unknown');
    expect(err.paymentStatus).toBe('PENDING');
    expect(err.progress.mandateTxHash).toBe(MANDATE_TX);
  });

  it('times out a request SDP never answers', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    sdp.hangOn.add('GET /disbursements');
    const { rail: r, paid } = rail(baseUrl, { requestTimeoutMs: 50 });

    const err = (await r.settle(payment()).catch((e: unknown) => e)) as SdpError;

    expect(err).toBeInstanceOf(SdpError);
    expect(err.code).toBe('rail_unavailable');
    expect(err.message).toContain('did not answer within 50 ms');
    expect(paid).toHaveLength(0);
  });

  it('waits for SDP to see the funds before the disbursement starts', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    sdp.insufficientStarts = 2;
    const { rail: r } = rail(baseUrl);

    const settlement = await r.settle(payment());

    expect(settlement.sdpTxHash).toBe(SDP_TX);
    expect(sdp.calls.filter((c) => c.endsWith('/status'))).toHaveLength(3);
  });

  it('reports unknown when SDP never sees the funds', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    sdp.insufficientStarts = 1_000;
    const { rail: r } = rail(baseUrl, { settleTimeoutMs: 40 });

    await expect(r.settle(payment())).rejects.toMatchObject({
      code: 'submission_unknown',
      progress: { mandateTxHash: MANDATE_TX },
    });
  });

  it('refuses a disbursement that is canceled', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    const { rail: r } = rail(baseUrl, {
      payToDistribution: () => {
        for (const d of sdp.disbursements.values()) d.status = 'CANCELED';
        return Promise.resolve({ txHash: MANDATE_TX });
      },
    });

    await expect(r.settle(payment())).rejects.toMatchObject({ code: 'tx_failed' });
  });

  it('passes on a mandate failure untouched, before SDP is started', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    const refusal = new EngineError('contract_refused', 'refused');
    const { rail: r } = rail(baseUrl, { payToDistribution: () => Promise.reject(refusal) });

    await expect(r.settle(payment())).rejects.toBe(refusal);
    expect(sdp.calls.some((c) => c.endsWith('/status'))).toBe(false);
  });

  it('uses the payout ID as the SDP payment ID when the task ID is too long', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    const { rail: r } = rail(baseUrl);

    await r.settle(payment({ taskId: 't'.repeat(65) }));

    expect([...sdp.disbursements.values()][0]?.payment?.external_payment_id).toBe(PAYOUT_ID);
  });
});

describe('SdpRail retries', () => {
  it('resumes the same disbursement after a timeout and never creates a second one', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    sdp.outcome = 'hang';
    const { rail: r, paid } = rail(baseUrl, { settleTimeoutMs: 40 });
    const err = (await r.settle(payment()).catch((e: unknown) => e)) as SdpRailError;
    expect(err.code).toBe('submission_unknown');

    sdp.outcome = 'success';
    const settlement = await r.resume(payment(), err.progress.mandateTxHash ?? '');

    expect(settlement.txHash).toBe(MANDATE_TX);
    expect(settlement.sdpTxHash).toBe(SDP_TX);
    expect(settlement.sdpDisbursementId).toBe(err.progress.sdpDisbursementId);
    expect(sdp.disbursements.size).toBe(1);
    expect(sdp.uploads).toHaveLength(1);
    expect(paid).toHaveLength(1);
  });

  it('settling a payout again reuses its disbursement', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    const { rail: r } = rail(baseUrl);
    await r.settle(payment());

    await r.settle(payment());

    expect(sdp.disbursements.size).toBe(1);
    expect(sdp.uploads).toHaveLength(1);
  });

  it('refuses a disbursement under the same name that pays something else', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    const { rail: r, paid } = rail(baseUrl);
    await r.settle(payment());

    await expect(r.settle(payment({ amount: 99n }))).rejects.toMatchObject({
      code: 'task_conflict',
    });
    expect(paid).toHaveLength(1);
    expect(sdp.disbursements.size).toBe(1);
  });

  it('carries the mandate hash when resume cannot reach SDP', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    sdp.hangOn.add('GET /disbursements');
    const { rail: r } = rail(baseUrl, { requestTimeoutMs: 30 });

    await expect(r.resume(payment(), MANDATE_TX)).rejects.toMatchObject({
      code: 'rail_unavailable',
      progress: { mandateTxHash: MANDATE_TX },
    });
  });

  it('uses the disbursement a concurrent attempt created', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    const client = new SdpClient({ baseUrl, auth: { kind: 'api_key', apiKey: API_KEY } });
    const first = await client.createDisbursement('ujira-x', 'asset-usdc');

    const second = await client.createDisbursement('ujira-x', 'asset-usdc');

    expect(second.id).toBe(first.id);
    expect(sdp.disbursements.size).toBe(1);
  });
});

describe('SdpRail recipients', () => {
  it('pays the distribution account for a listed handle or wallet', async () => {
    const { baseUrl } = await fakeSdp();
    const { rail: r } = rail(baseUrl);

    expect(r.destinationFor('recipient-1')).toBe(DISTRIBUTION);
    expect(r.destinationFor(WALLET)).toBe(DISTRIBUTION);
    expect(r.walletFor('recipient-1')).toBe(WALLET);
  });

  it('refuses a recipient the configuration does not list', async () => {
    const { baseUrl } = await fakeSdp();
    const { rail: r } = rail(baseUrl);

    expect(() => r.destinationFor(OTHER_WALLET)).toThrow(EngineError);
    await expect(r.settle(payment({ recipient: OTHER_WALLET }))).rejects.toMatchObject({
      code: 'input_invalid',
    });
  });

  it('refuses a payment that does not pay the distribution account, the asset or a positive amount', async () => {
    const { baseUrl } = await fakeSdp();
    const { rail: r, paid } = rail(baseUrl);

    await expect(r.settle(payment({ destination: WALLET }))).rejects.toMatchObject({
      code: 'input_invalid',
    });
    await expect(r.settle(payment({ asset: 'EURC' }))).rejects.toMatchObject({
      code: 'input_invalid',
    });
    await expect(r.settle(payment({ amount: 0n }))).rejects.toMatchObject({
      code: 'input_invalid',
    });
    expect(paid).toHaveLength(0);
  });

  it('rejects a bad configuration', () => {
    const client = new SdpClient({ baseUrl: 'http://x', auth: { kind: 'api_key', apiKey: 'k' } });
    const base = {
      client,
      payToDistribution: () => Promise.resolve({ txHash: MANDATE_TX }),
      asset: { code: 'USDC', issuer: USDC_ISSUER },
    };
    expect(() => new SdpRail({ ...base, distributionAccount: 'nope', recipients: {} })).toThrow(
      /distribution account/,
    );
    expect(
      () => new SdpRail({ ...base, distributionAccount: DISTRIBUTION, recipients: { a: 'nope' } }),
    ).toThrow(/recipient a/);
  });
});

describe('SdpClient', () => {
  it('logs in with a dashboard user and logs in again when the session expires', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    const client = new SdpClient({
      baseUrl,
      auth: { kind: 'password', email: 'rail@example.test', password: sdp.password },
    });

    expect(await client.findAssetId('USDC', USDC_ISSUER)).toBe('asset-usdc');
    sdp.expireTokens();
    expect(await client.findAssetId('USDC', USDC_ISSUER)).toBe('asset-usdc');

    expect(sdp.calls.filter((c) => c === 'POST /login')).toHaveLength(2);
  });

  it('settles end to end with a dashboard user', async () => {
    const { sdp, baseUrl } = await fakeSdp();
    const { rail: r } = rail(baseUrl, {
      auth: { kind: 'password', email: 'rail@example.test', password: sdp.password },
    });

    await expect(r.settle(payment())).resolves.toMatchObject({ sdpTxHash: SDP_TX });
  });

  it('treats wrong credentials as a configuration error and keeps them out of the message', async () => {
    const { baseUrl } = await fakeSdp();
    const client = new SdpClient({
      baseUrl,
      auth: { kind: 'password', email: 'rail@example.test', password: 'not-it-at-all' },
    });

    const err = (await client.authenticate().catch((e: unknown) => e)) as SdpError;

    expect(err.code).toBe('config_invalid');
    expect(err.httpStatus).toBe(401);
    expect(err.sdpMessage).toBe('wrong credentials');
    expect(err.message).not.toContain('not-it-at-all');
  });

  it('treats a rejected API key as a configuration error', async () => {
    const { baseUrl } = await fakeSdp();
    const client = new SdpClient({ baseUrl, auth: { kind: 'api_key', apiKey: 'SDP_wrong.key' } });

    await expect(client.findAssetId('USDC', USDC_ISSUER)).rejects.toMatchObject({
      code: 'config_invalid',
      httpStatus: 401,
    });
  });

  it('sends the tenant name when one is set', async () => {
    const seen: (string | null)[] = [];
    const client = new SdpClient({
      baseUrl: 'http://sdp.test',
      tenant: 'bluecorp',
      auth: { kind: 'api_key', apiKey: API_KEY },
      fetch: (_input, init) => {
        seen.push(new Headers(init?.headers).get('SDP-Tenant-Name'));
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      },
    });

    await expect(client.findAssetId('USDC', USDC_ISSUER)).rejects.toMatchObject({
      code: 'config_invalid',
    });
    expect(seen).toEqual(['bluecorp']);
  });

  it('maps SDP answers to typed errors', async () => {
    const answers: [number, string, string][] = [
      [400, '{"error":"bad"}', 'input_invalid'],
      [500, 'oops', 'rail_unavailable'],
      [200, 'not json', 'rail_unavailable'],
      [200, '{"unexpected":true}', 'rail_unavailable'],
      [200, '', 'rail_unavailable'],
    ];
    for (const [status, body, code] of answers) {
      const client = new SdpClient({
        baseUrl: 'http://sdp.test',
        auth: { kind: 'api_key', apiKey: API_KEY },
        fetch: () => Promise.resolve(new Response(body, { status })),
      });
      await expect(client.getDisbursement('d-1')).rejects.toMatchObject({ code });
    }
  });

  it('refuses a disbursement with more than one receiver', async () => {
    const line = { receiver_wallet: null, payment: null };
    const client = new SdpClient({
      baseUrl: 'http://sdp.test',
      auth: { kind: 'api_key', apiKey: API_KEY },
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify({ data: [line, line] }), { status: 200 })),
    });

    await expect(client.disbursementPayment('d-1')).rejects.toMatchObject({
      code: 'task_conflict',
    });
  });

  it('reports an unreachable SDP without leaking the cause into the message', async () => {
    const client = new SdpClient({
      baseUrl: 'http://sdp.test',
      auth: { kind: 'api_key', apiKey: API_KEY },
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });

    await expect(client.getPayment('p-1')).rejects.toMatchObject({
      code: 'rail_unavailable',
      message: 'SDP could not be reached to read the payment',
    });
  });
});

describe('helpers', () => {
  it('builds one CSV line and quotes what needs quoting', () => {
    expect(instructionsCsv(WALLET, '1.5', 'a,"b"')).toBe(
      `email,id,amount,walletAddress,paymentID\n${WALLET.toLowerCase()}@wallet.invalid,${WALLET},1.5,${WALLET},"a,""b"""\n`,
    );
  });

  it('parses SDP amounts back to minor units exactly', () => {
    expect(parseUnits('1.2500000', 7)).toBe(12_500_000n);
    expect(parseUnits('3', 7)).toBe(30_000_000n);
    expect(parseUnits('0.0000001', 7)).toBe(1n);
    expect(() => parseUnits('1e3', 7)).toThrow(SdpError);
    expect(() => parseUnits('0.00000001', 7)).toThrow(/more decimals/);
  });
});
