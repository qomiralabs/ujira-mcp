// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import {
  I128_MAX,
  I128_MIN,
  InvalidAmountError,
  InvalidScaleError,
  MoneyOverflowError,
  ScaleMismatchError,
  UnknownCurrencyError,
  equals,
  moneyAt,
  tokenAmount,
  type Money,
  type TokenAmount,
} from '../money/index.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { amountParam, fiatFromRow, tokenFromRow } from './money-mapper.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

const adminUrl = inject('dbAdminUrl');

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase(adminUrl, import.meta.url);
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  await client.query(`
    create table public.fiat_money (
      id bigint generated always as identity primary key,
      amount ujira.amount not null,
      currency text not null,
      scale ujira.scale not null,
      foreign key (currency, scale) references ujira.currency_scales (currency, scale)
    );
    create table public.token_money (
      id bigint generated always as identity primary key,
      amount ujira.amount not null,
      asset text not null,
      chain text not null,
      scale ujira.scale not null,
      foreign key (asset, chain, scale)
        references ujira.settlement_tokens (asset, chain, token_scale)
    );
  `);
});

afterAll(async () => {
  await client.end();
  await database.drop();
});

async function roundTripFiat(value: Money): Promise<Money> {
  const inserted = await client.query<{ amount: string; currency: string; scale: number }>(
    `insert into public.fiat_money (amount, currency, scale) values ($1, $2, $3)
     returning amount, currency, scale`,
    [amountParam(value), value.currency, value.scale],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('the insert returned no row');
  // pg hands numeric back as text, never as a number.
  expect(typeof row.amount).toBe('string');
  return fiatFromRow(row);
}

async function roundTripToken(value: TokenAmount): Promise<TokenAmount> {
  const inserted = await client.query<{
    amount: string;
    asset: string;
    chain: string;
    scale: number;
  }>(
    `insert into public.token_money (amount, asset, chain, scale) values ($1, $2, $3, $4)
     returning amount, asset, chain, scale`,
    [amountParam(value), value.asset, value.chain, value.scale],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('the insert returned no row');
  return tokenFromRow(row);
}

describe('money mapper', () => {
  // USDm is not a settlement token: it was the Celo dollar, and Celo is no
  // longer a chain here. Its 18 places are still the finest scale the money
  // model allows, so that width is proved with a fiat amount held at 18.
  it('both i128 bounds and USDm at scale 18 round trip', async () => {
    for (const value of [
      moneyAt(I128_MIN, 'USD', 2),
      moneyAt(I128_MAX, 'USD', 2),
      moneyAt(I128_MAX, 'USD', 18),
      moneyAt(I128_MIN, 'NGN', 18),
      moneyAt('1', 'USD', 18),
    ]) {
      const back = await roundTripFiat(value);
      expect(equals(back, value)).toBe(true);
      expect(back.scale).toBe(value.scale);
    }
    for (const value of [
      tokenAmount(I128_MIN, 'USDC', 'stellar'),
      tokenAmount(I128_MAX, 'USDC', 'stellar'),
    ]) {
      expect(equals(await roundTripToken(value), value)).toBe(true);
    }
  });

  it('sends the exact decimal text of the bigint', () => {
    expect(amountParam(moneyAt(I128_MIN, 'USD', 2))).toBe(
      '-170141183460469231731687303715884105728',
    );
    expect(amountParam(tokenAmount(12345678n, 'USDC', 'stellar'))).toBe('12345678');
  });

  it('refuses a row the money model would refuse', () => {
    expect(() => fiatFromRow({ amount: '1', currency: 'XXX', scale: 2 })).toThrow(
      UnknownCurrencyError,
    );
    expect(() => fiatFromRow({ amount: '1', currency: 'USD', scale: 1 })).toThrow(
      InvalidScaleError,
    );
    expect(() => fiatFromRow({ amount: '1.5', currency: 'USD', scale: 2 })).toThrow(
      InvalidAmountError,
    );
    expect(() =>
      fiatFromRow({ amount: (I128_MAX + 1n).toString(), currency: 'USD', scale: 2 }),
    ).toThrow(MoneyOverflowError);
    expect(() => tokenFromRow({ amount: '1', asset: 'USDC', chain: 'celo', scale: 7 })).toThrow(
      UnknownCurrencyError,
    );
    expect(() => tokenFromRow({ amount: '1', asset: 'USDC', chain: 'stellar', scale: 6 })).toThrow(
      ScaleMismatchError,
    );
  });
});
