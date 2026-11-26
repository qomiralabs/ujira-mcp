// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// UJIRA_DEMO_FEATURES in every combination: off by default, on only with
// testnet, and what a server serves and runs either way.

import { join } from 'node:path';

import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MandateContract } from '../../src/chain/adapter.js';
import { demoFeatures, loadSettings } from '../../src/config.js';
import { ConsoleRegistry } from '../../src/console/registry.js';
import { createDemo } from '../../src/demo/index.js';
import { testWalletsPath } from '../../src/demo/settings.js';
import { TestWalletStore } from '../../src/demo/wallets.js';
import {
  FakeChain,
  api,
  consoleSettings,
  errorCode,
  httpSettings,
  keypair,
  owner,
  startConsole,
  stop,
  treasuryKey,
  type World,
} from '../console-helpers.js';
import { MANDATE, UNIT } from '../fake-rpc.js';

const open: World[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((w) => stop(w.server)));
});

async function start(options: Parameters<typeof startConsole>[0] = {}) {
  const w = await startConsole(options);
  open.push(w);
  return w;
}

/** A mandate the demo can name in a rail; no test here makes a call reach it. */
const mandate = { contractId: MANDATE } as unknown as MandateContract;

const DEMO_ROUTES = [
  '/api/onboard/xlm',
  '/api/onboard/trustline',
  '/api/onboard/usdc',
  '/api/recipients/test',
];

describe('UJIRA_DEMO_FEATURES', () => {
  it('is off unless set to on', () => {
    expect(demoFeatures({})).toBe(false);
    expect(demoFeatures({ UJIRA_DEMO_FEATURES: '' })).toBe(false);
    expect(demoFeatures({ UJIRA_DEMO_FEATURES: 'off', UJIRA_NETWORK: 'pubnet' })).toBe(false);
  });

  it('is on with testnet', () => {
    expect(demoFeatures({ UJIRA_DEMO_FEATURES: 'on', UJIRA_NETWORK: 'testnet' })).toBe(true);
  });

  it.each([
    [{ UJIRA_DEMO_FEATURES: 'on', UJIRA_NETWORK: 'pubnet' }, /only with UJIRA_NETWORK=testnet/],
    [{ UJIRA_DEMO_FEATURES: 'on', UJIRA_NETWORK: 'mainnet' }, /only with UJIRA_NETWORK=testnet/],
    // Unset is not testnet: the demo is never on by accident on a network named later.
    [{ UJIRA_DEMO_FEATURES: 'on' }, /only with UJIRA_NETWORK=testnet/],
    [{ UJIRA_DEMO_FEATURES: 'yes', UJIRA_NETWORK: 'testnet' }, /must be on or off/],
    [{ UJIRA_DEMO_FEATURES: 'ON', UJIRA_NETWORK: 'testnet' }, /must be on or off/],
  ])('refuses to start with %o', (env, message) => {
    expect(() => demoFeatures(env)).toThrow(message);
  });
});

describe('a server with the demo off', () => {
  it('has no faucet, test recipient or onboarding routes', async () => {
    const { base, chain } = await start({ demo: false });
    for (const path of DEMO_ROUTES) {
      const res = await api(base, path, { address: owner.publicKey() });
      expect(res.status, path).toBe(404);
      expect(errorCode(res.json), path).toBe('not_found');
    }
    expect(chain.funded).toEqual([]);
    expect(chain.submitted).toEqual([]);
  });

  it('has no public demo MCP, and keeps the console and its mandate MCP', async () => {
    const { base } = await start({ demo: false });
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(mcp.status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await api(base, `/api/mandates/${MANDATE}`)).status).toBe(200);
    const mandateMcp = await fetch(`${base}/m/${MANDATE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mandateMcp.status).not.toBe(404);
  });

  it('tells the dashboard the faucet and SDP are off', async () => {
    const { base } = await start({ demo: false });
    const { json } = await api(base, '/api/config');
    expect(json['sdpAvailable']).toBe(false);
    expect(json['faucet']).toEqual({ amount: '0', enabled: false });
    expect(json).not.toHaveProperty('sdpProofUrl');
  });

  it('pays only through the wallet rail', async () => {
    const { base } = await start({ demo: false });
    const sdp = await api(base, `/api/mandates/${MANDATE}/agent/quote`, {
      recipient: owner.publicKey(),
      amount: '1',
      rail: 'sdp',
    });
    expect(sdp.status).toBe(400);
    expect(errorCode(sdp.json)).toBe('rail_unavailable');
  });

  it('never recycles test wallets, even ones left on disk', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const settings = consoleSettings();
    const left = TestWalletStore.open(testWalletsPath(settings));
    await left.add(keypair('left-behind'), '2026-11-14T10:00:00Z');
    const { chain } = await start({ settings, demo: false });
    chain.accounts.set(keypair('left-behind').publicKey(), {
      exists: true,
      xlm: '1',
      usdc: 5n * UNIT,
    });
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(chain.submitted).toEqual([]);
  });
});

describe('a server with the demo on', () => {
  const kp = Keypair.random();
  const base = loadSettings({ UJIRA_MANDATE_ID: MANDATE, UJIRA_AGENT_SECRET: kp.secret() });
  const env = { UJIRA_TREASURY_SECRET: treasuryKey.secret() };

  function parts(over: Partial<ReturnType<typeof consoleSettings>> = {}) {
    const settings = consoleSettings(over);
    return {
      settings,
      http: httpSettings(),
      chain: new FakeChain(),
      registry: ConsoleRegistry.open(join(settings.dataDir, 'console-registry.json')),
    };
  }

  it('serves the demo routes through the console', async () => {
    const { base: url } = await start();
    for (const path of DEMO_ROUTES) {
      expect((await fetch(`${url}${path}`)).status, path).toBe(405);
    }
    expect((await api(url, '/api/config')).json['faucet']).toMatchObject({ enabled: true });
  });

  it('runs the recycler on its interval once the console is built, until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const demo = createDemo({ base, env, log: () => undefined });
    const p = parts();
    let looked = 0;
    p.chain.account = () => {
      looked++;
      return Promise.resolve({ exists: true, xlm: '1', usdc: 0n });
    };
    await TestWalletStore.open(testWalletsPath(p.settings)).add(keypair('kept'), 'now');
    demo.console(p);
    expect(demo.summary()).toBe('demo on: faucet on, sdp off, recycler every 300s');
    demo.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(looked).toBe(1);
    demo.stop();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(looked).toBe(1);
  });

  it('keeps no recycler and no wallet file without a treasury', () => {
    const demo = createDemo({ base, env: {}, log: () => undefined });
    const p = parts();
    demo.console(p);
    demo.start();
    demo.stop();
    expect(demo.summary()).toBe('demo on: faucet off, sdp off, recycler off');
    expect(demo.rails(mandate)).toEqual([]);
  });

  it('adds the SDP rail only when SDP is set up, and checks its issuer', () => {
    const dist = keypair('dist').publicKey();
    const sdpEnv = {
      UJIRA_SDP_URL: 'http://localhost:8000',
      UJIRA_SDP_API_KEY: 'SDP_id.secret',
      UJIRA_SDP_DISTRIBUTION: dist,
      UJIRA_SDP_ASSET_ISSUER: dist,
    };
    const demo = createDemo({ base, env: sdpEnv, log: () => undefined });
    expect(demo.rails(mandate).map((r) => r.name)).toEqual(['demo.sdp']);
    expect(demo.summary()).toContain('sdp on');
    expect(() => demo.console(parts())).toThrow(/SDP asset issuer/);
    const matching = createDemo({
      base,
      env: { ...sdpEnv, UJIRA_SDP_ASSET_ISSUER: parts().settings.usdc.issuer },
      log: () => undefined,
    });
    const extension = matching.console(parts());
    expect(extension.sharedDestinations).toEqual([dist]);
    expect(extension.config()).toMatchObject({ sdpAvailable: true });
  });
});
