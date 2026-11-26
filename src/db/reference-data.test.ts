// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The reference rows are written into a migration by hand, and the money
// model's tables live in src/money. Two copies drift unless something
// compares them, so this does, row for row.

import { FIAT_CURRENCIES, MAX_SCALE, SETTLEMENT_TOKENS } from '../money/index.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

async function rows<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe('reference data', () => {
  it('seeded rows equal the src/money tables', async () => {
    const chains = [...new Set(SETTLEMENT_TOKENS.map((token) => token.chain))].sort(byText);
    expect(await rows('select code from ujira.chains order by code')).toEqual(
      chains.map((code) => ({ code })),
    );

    const currencies = FIAT_CURRENCIES.map((currency) => ({
      code: currency.code,
      minor_units: currency.minorUnits,
    })).sort((a, b) => byText(a.code, b.code));
    expect(await rows('select code, minor_units from ujira.currencies order by code')).toEqual(
      currencies,
    );

    // A fiat amount may be held at its minor units or any finer scale up to
    // the model's limit, and never coarser.
    const scales = currencies.flatMap((currency) =>
      Array.from({ length: MAX_SCALE - currency.minor_units + 1 }, (_, offset) => ({
        currency: currency.code,
        scale: currency.minor_units + offset,
      })),
    );
    expect(
      await rows('select currency, scale from ujira.currency_scales order by currency, scale'),
    ).toEqual(scales);

    const tokens = SETTLEMENT_TOKENS.map((token) => ({
      asset: token.asset,
      chain: token.chain,
      token_scale: token.tokenScale,
      display_scale: token.displayScale,
    })).sort((a, b) => byText(`${a.asset}/${a.chain}`, `${b.asset}/${b.chain}`));
    expect(
      await rows(
        'select asset, chain, token_scale, display_scale from ujira.settlement_tokens order by asset, chain',
      ),
    ).toEqual(tokens);
  });

  it('holds USDC on stellar at 7 places, shown at 2', async () => {
    expect(
      await rows(
        "select token_scale, display_scale from ujira.settlement_tokens where asset = 'USDC' and chain = 'stellar'",
      ),
    ).toEqual([{ token_scale: 7, display_scale: 2 }]);
  });

  // Each table adds its own machine, so this holds however many have landed.
  it('moves no status to itself in any status machine', async () => {
    expect(
      await rows('select * from ujira.status_transitions where from_status = to_status'),
    ).toEqual([]);
  });
});
