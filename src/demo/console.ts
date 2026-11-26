// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the demo adds to the console: test XLM from friendbot, a USDC
// trustline to sign, test USDC from a treasury, throwaway test recipients,
// and the SDP rail. All of it pays from keys and accounts UJIRA holds, which
// is fine for test money and never for a person's funds, so it lives here.
//
// It is public and has no login, so every route is bounded by a rate limit
// and checks its body against a strict schema before anything else.

import { z } from 'zod';

import type { MandateContract, TxSigner } from '../chain/adapter.js';
import { randomKeypair, type Keypair } from '../chain/stellar/keys.js';
import type { Account } from '../chain/stellar/network.js';
import { paymentTx, trustlineTx } from '../chain/stellar/txbuild.js';
import type { ConsoleChain } from '../console/chain.js';
import { ApiError } from '../console/errors.js';
import type { ApiRoute, ConsoleExtension } from '../console/extension.js';
import type { FaucetClaim } from '../console/registry.js';
import { jsonBody, parse, take } from '../console/request.js';
import type { ConsoleSettings } from '../console/settings.js';
import { accountAddress } from '../ids.js';
import { WindowLimiter, type HttpSettings } from '../mcp/public.js';
import { formatUnits } from '../money.js';
import type { PayoutRail } from '../rails/rail.js';
import { SdpRail, type SdpClient } from './sdp.js';
import type { DemoSettings } from './settings.js';
import type { TestWalletStore } from './wallets.js';

const HOUR = 3_600_000;

/** The SDP the console's mandates may pay through. */
export interface DemoSdp {
  readonly client: SdpClient;
  readonly distributionAccount: string;
  readonly assetIssuer: string;
}

/** Where faucet top ups are remembered, so a cooldown survives a restart. */
export interface FaucetLedger {
  faucetClaim(address: string): FaucetClaim | undefined;
  recordFaucet(claim: FaucetClaim): Promise<void>;
}

export interface DemoConsoleOptions {
  readonly demo: DemoSettings;
  readonly console: Pick<ConsoleSettings, 'usdc'>;
  readonly http: Pick<HttpSettings, 'maxBodyBytes'>;
  readonly chain: ConsoleChain;
  readonly ledger: FaucetLedger;
  /** Signs the mandate's leg to the SDP distribution account. */
  readonly executor: TxSigner;
  readonly sdp?: DemoSdp;
  /** Where test recipients' keys are kept for recycling; without it they are discarded. */
  readonly wallets?: TestWalletStore;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** For tests: the keypair a test recipient gets. */
  readonly newKeypair?: () => Keypair;
}

const addressBody = z.object({ address: accountAddress }).strict();
const emptyBody = z.object({}).strict();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** A wait in words: "45 seconds", "1 minute", "7 minutes". */
export function waitWords(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? '1 second' : `${String(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

export function demoConsole(o: DemoConsoleOptions): ConsoleExtension {
  const { demo: settings, chain, ledger } = o;
  const usdc = o.console.usdc;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  const newKeypair = o.newKeypair ?? randomKeypair;
  const lim = settings.limits;
  const limiters = {
    faucet: new WindowLimiter(lim.faucetPerHour, HOUR, now),
    recipients: new WindowLimiter(lim.testRecipientsPerHour, HOUR, now),
    friendbot: new WindowLimiter(lim.friendbotPerHour, HOUR, now),
  };
  const faucetBusy = new Set<string>();

  async function onboardXlm(raw: unknown, client: string) {
    const { address: addr } = parse(addressBody, raw);
    const view = await chain.account(addr, usdc);
    if (view.exists) return { ok: true };
    take(limiters.friendbot, client, 'test XLM requests from your address');
    await chain.friendbot(addr);
    return { ok: true };
  }

  async function onboardTrustline(raw: unknown) {
    const { address: addr } = parse(addressBody, raw);
    const tx = trustlineTx(await chain.loadAccount(addr), usdc);
    return {
      xdr: tx.toXdr(),
      description: `Add a USDC trustline (issuer ${usdc.issuer}) so this wallet can hold test USDC`,
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
    if (faucetBusy.has(addr)) {
      throw new ApiError(409, 'faucet_busy', 'Test USDC for this wallet is already on its way');
    }
    // Checked before any network call, so a caller hammering one wallet costs nothing.
    const last = ledger.faucetClaim(addr);
    const waitMs =
      last === undefined ? 0 : Date.parse(last.at) + settings.faucetCooldownSeconds * 1000 - now();
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      throw new ApiError(
        429,
        'faucet_cooldown',
        `This wallet was topped up a moment ago; try again in ${waitWords(seconds)}`,
        { retryAfterSeconds: seconds },
      );
    }
    const target = settings.faucetAmount;
    faucetBusy.add(addr);
    try {
      const wallet = await chain.account(addr, usdc);
      if (!wallet.exists) {
        throw new ApiError(400, 'account_not_found', 'Get test XLM first, so the wallet exists');
      }
      if (wallet.usdc === null) {
        throw new ApiError(400, 'trustline_missing', 'Add the USDC trustline first');
      }
      if (wallet.usdc >= target) {
        throw new ApiError(
          409,
          'faucet_not_needed',
          `This wallet already holds ${formatUnits(wallet.usdc)} USDC, at or above the ${formatUnits(target)} USDC the faucet tops up to`,
        );
      }
      const amount = target - wallet.usdc;
      const held = (await chain.account(treasury.publicKey, usdc)).usdc ?? 0n;
      if (held < settings.faucetFloor + amount) {
        throw new ApiError(503, 'faucet_empty', 'The test USDC faucet is empty for now');
      }
      take(limiters.faucet, client, 'faucet top ups from your address');
      const tx = paymentTx(await chain.loadAccount(treasury.publicKey), {
        destination: addr,
        asset: usdc,
        amount,
        timeoutSeconds: 60,
      });
      treasury.sign(tx);
      const sent = await chain.submit(tx);
      if (sent.status !== 'SUCCESS') {
        throw new ApiError(502, 'faucet_failed', `The faucet payment failed (${sent.hash})`);
      }
      await ledger.recordFaucet({
        address: addr,
        hash: sent.hash,
        at: new Date(now()).toISOString(),
      });
      return {
        hash: sent.hash,
        amount: amount.toString(),
        balance: target.toString(),
        target: target.toString(),
        cooldownSeconds: settings.faucetCooldownSeconds,
      };
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
    const tx = trustlineTx(await loadWithRetry(addr), usdc);
    tx.sign(keypair);
    const sent = await chain.submit(tx);
    if (sent.status !== 'SUCCESS') {
      throw new ApiError(
        502,
        'recipient_failed',
        `The test wallet's trustline failed (${sent.hash})`,
      );
    }
    // Kept only so the recycler can send what this wallet is paid back to the
    // faucet. Without a store the key goes out of scope here, never written.
    if (o.wallets !== undefined) {
      await o.wallets.add(keypair, new Date(now()).toISOString());
      log(`test recipient ${addr} created, recycled to the faucet`);
    }
    return { address: addr, hash: sent.hash };
  }

  type Handler = Exclude<ApiRoute, 'wrong_method' | undefined>;
  const body = (req: Parameters<Handler>[0]) => jsonBody(req, o.http.maxBodyBytes);
  const routes: Readonly<Record<string, Handler>> = {
    '/api/onboard/xlm': async (req, client) => onboardXlm(await body(req), client),
    '/api/onboard/trustline': async (req) => onboardTrustline(await body(req)),
    '/api/onboard/usdc': async (req, client) => faucet(await body(req), client),
    '/api/recipients/test': async (req, client) => testRecipient(await body(req), client),
  };

  const sdp = o.sdp;
  return {
    route(method: string, path: string): ApiRoute {
      const handler = Object.hasOwn(routes, path) ? routes[path] : undefined;
      if (handler === undefined) return undefined;
      return method === 'POST' ? handler : 'wrong_method';
    },
    config() {
      return {
        sdpAvailable: sdp !== undefined,
        sdpProofUrl: settings.sdpProofUrl,
        faucet: {
          // amount is kept for pages built before top ups; it is the target.
          amount: settings.faucetAmount.toString(),
          target: settings.faucetAmount.toString(),
          cooldownSeconds: settings.faucetCooldownSeconds,
          enabled: settings.treasury !== undefined,
        },
      };
    },
    rails(mandate: MandateContract, recipients: Readonly<Record<string, string>>): PayoutRail[] {
      if (sdp === undefined) return [];
      return [
        new SdpRail({
          client: sdp.client,
          distributionAccount: sdp.distributionAccount,
          asset: { code: 'USDC', issuer: sdp.assetIssuer },
          recipients,
          payToDistribution: (p) => mandate.execute(o.executor, p.payoutId),
        }),
      ];
    },
    sharedDestinations: sdp === undefined ? [] : [sdp.distributionAccount],
  };
}
