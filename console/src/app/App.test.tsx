// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The whole reviewer story against the mock API: connect, set up, create a
// mandate with three signatures, then pay, need approval, get blocked, pause.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ApiError, type ConsoleApi } from '../lib/api';
import { createMockApi } from '../lib/mock';
import { App } from './App';

const LONG = { timeout: 4000 };

async function connectAndSetUp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Connect Demo wallet/ }));
  await user.click(await screen.findByRole('button', { name: 'Get test XLM' }));
  await user.click(await screen.findByRole('button', { name: 'Add USDC' }, LONG));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: TOP_UP })).toHaveProperty('disabled', false);
  });
  await user.click(screen.getByRole('button', { name: TOP_UP }));
  await screen.findByText('50.00 USDC in your wallet', undefined, LONG);
}

const TOP_UP = 'Top up to 50 test USDC';

async function createWithTestRecipient(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('link', { name: 'Create a mandate' }));
  await user.click(await screen.findByRole('button', { name: 'Add a test recipient' }));
  await screen.findByDisplayValue('Ada');
  await user.click(screen.getByRole('button', { name: 'Review and sign' }));
  for (let i = 0; i < 3; i++) {
    await user.click(await screen.findByRole('button', { name: 'Sign in Demo wallet' }));
    await waitFor(() => {
      expect(screen.queryByText(/Waiting for your wallet/)).toBeNull();
    });
  }
  await user.click(await screen.findByRole('link', { name: 'Open your mandate' }));
}

describe('the console in mock mode', () => {
  it('explains UJIRA before anything is connected', async () => {
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    expect(await screen.findByRole('heading', { name: 'How UJIRA works' })).toBeTruthy();
    for (const step of [
      'You set the rules',
      'The agent asks',
      'The contract decides',
      'A person approves big payouts',
      'Every payment gets a receipt',
    ]) {
      expect(screen.getByRole('heading', { name: step })).toBeTruthy();
    }
    expect(screen.getByText('Stellar testnet. Test money only.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect Freighter/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect Albedo/ })).toBeTruthy();
    expect(screen.getAllByText('Soon')).toHaveLength(2);
  });

  it('runs the whole story from setup to receipts', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await connectAndSetUp(user);

    await user.click(screen.getByRole('link', { name: 'Create a mandate' }));
    await screen.findByRole('heading', { name: 'Create a mandate', level: 1 });
    await user.click(screen.getByRole('button', { name: 'Add a test recipient' }));
    await screen.findByDisplayValue('Ada');
    await user.click(screen.getByRole('button', { name: 'Review and sign' }));

    for (const n of [1, 2, 3]) {
      await screen.findByRole('heading', { name: `Sign step ${n} of 3` });
      await user.click(await screen.findByRole('button', { name: 'Sign in Demo wallet' }));
    }
    await screen.findByRole('heading', { name: 'Your mandate is live' });
    const signing = within(screen.getByRole('region', { name: 'Your mandate is live' }));
    expect(signing.getAllByRole('link', { name: /opens Stellar Expert/ })).toHaveLength(3);
    await user.click(screen.getByRole('link', { name: 'Open your mandate' }));

    await screen.findByRole('heading', { name: 'The rules' }, LONG);
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('15.00 USDC')).toBeTruthy();

    const agent = within(screen.getByRole('region', { name: /Act as the AI agent/ }));
    const amount = agent.getByLabelText('Amount');

    // Below the approval amount: paid at once.
    await user.click(agent.getByRole('button', { name: 'Request payout' }));
    await agent.findByText('Paid 1.00 USDC to Ada');

    // At or above it: waits for the owner.
    await user.clear(amount);
    await user.type(amount, '12');
    await user.click(agent.getByRole('button', { name: 'Request payout' }));
    await agent.findByText('Waiting for your approval');

    const approvals = within(screen.getByRole('region', { name: /Approvals/ }));
    await user.click(await approvals.findByRole('button', { name: 'Approve' }, LONG));
    await user.click(await approvals.findByRole('button', { name: 'Pay now' }, LONG));
    await approvals.findByText('Paid 12.00 USDC to Ada');

    // Over the max per payment: blocked with a reason.
    await user.clear(amount);
    await user.type(amount, '20');
    await user.click(agent.getByRole('button', { name: 'Quote' }));
    await agent.findByText('Over the max per payment.');

    // Paused: every request is blocked.
    await user.click(screen.getByRole('button', { name: /Pause payouts/ }));
    await screen.findByText('Paused', undefined, LONG);
    await user.clear(amount);
    await user.type(amount, '1');
    await user.click(agent.getByRole('button', { name: 'Request payout' }));
    await agent.findByText('The mandate is paused. Resume it to pay again.');

    const receipts = within(screen.getByRole('region', { name: /Receipts/ }));
    await waitFor(() => {
      expect(receipts.getAllByRole('row')).toHaveLength(4);
    }, LONG);
    expect(receipts.getAllByText('Paid')).toHaveLength(1);
    expect(receipts.getByText('Approved, paid')).toBeTruthy();
    expect(receipts.getByText('Blocked')).toBeTruthy();

    const claude = within(screen.getByRole('region', { name: 'Connect Claude' }));
    const url = claude.getByLabelText<HTMLInputElement>('MCP address for this mandate').value;
    expect(url).toMatch(/\/m\/C[A-Z2-7]{55}\/mcp$/);
  });

  it('keeps the top up usable after setup and explains the cooldown', async () => {
    const user = userEvent.setup();
    let clock = 1_800_000_000_000;
    render(<App api={createMockApi({ delayMs: 0, now: () => clock })} mock />);
    await connectAndSetUp(user);
    const setup = within(screen.getByRole('region', { name: 'Get your wallet ready' }));
    await setup.findByText(/Sent 50\.00 test USDC to your wallet/);

    // The step is done, yet the button stays: asking again explains the wait in words.
    const again = setup.getByRole('button', { name: TOP_UP });
    expect(again).toHaveProperty('disabled', false);
    await user.click(again);
    await setup.findByText(/You can top up again in about 10 minutes\./);
    expect(setup.queryByText('That did not work')).toBeNull();

    // Past the cooldown, a full wallet is told there is nothing to top up.
    clock += 601_000;
    await user.click(setup.getByRole('button', { name: TOP_UP }));
    await setup.findByText(/nothing to top up/);
  });

  it('says how often the faucet works before the first top up', async () => {
    const user = userEvent.setup();
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await user.click(await screen.findByRole('button', { name: /Connect Demo wallet/ }));
    expect(
      await screen.findByText(
        /Use it whenever you run low, once every 10 minutes\./,
        undefined,
        LONG,
      ),
    ).toBeTruthy();
  });

  it('offers a top up when the wallet cannot fund the mandate', async () => {
    const user = userEvent.setup();
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await connectAndSetUp(user);
    await user.click(screen.getByRole('link', { name: 'Create a mandate' }));
    const fund = await screen.findByLabelText(/Fund it with/);
    expect(screen.queryByText(/does not hold enough test USDC to fund this/)).toBeNull();
    await user.clear(fund);
    await user.type(fund, '60');
    expect(await screen.findByText(/does not hold enough test USDC to fund this/)).toBeTruthy();
    expect(screen.getByRole('button', { name: TOP_UP })).toBeTruthy();
    // Test recipients are explained as recycled back to the faucet.
    expect(screen.getByText(/send the USDC they receive back to our faucet/)).toBeTruthy();
  });

  it('lets the owner top up from the mandate page', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    let clock = Date.now();
    render(<App api={createMockApi({ delayMs: 0, now: () => clock })} mock />);
    await connectAndSetUp(user);
    await createWithTestRecipient(user);
    const owner = within(await screen.findByRole('region', { name: 'Owner controls' }, LONG));
    expect(owner.getByText(/Wallet running low\?/)).toBeTruthy();
    clock += 601_000;
    await user.click(owner.getByRole('button', { name: TOP_UP }));
    await owner.findByText(/Sent 40\.00 test USDC to your wallet/);
  });

  it('asks before revoking, then signs revoke and sweep', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await connectAndSetUp(user);
    await createWithTestRecipient(user);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }, LONG));
    expect(
      await screen.findByText(/Moves the 40.00 USDC it holds back to your wallet/),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Active')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Revoke and return funds' }));
    await screen.findByText('Revoked', undefined, LONG);
    await screen.findByText(/Step 2 of 2: the funds are back in your wallet/, undefined, LONG);
    expect(screen.queryByRole('button', { name: 'Return the funds' })).toBeNull();
  });

  it('shows the API sentence when a step fails', async () => {
    const base = createMockApi({ delayMs: 0 });
    const api: ConsoleApi = {
      ...base,
      onboardXlm: () =>
        Promise.reject(
          new ApiError('friendbot_down', 'Friendbot is not answering. Try again in a minute.', 503),
        ),
    };
    const user = userEvent.setup();
    render(<App api={api} mock />);
    await user.click(await screen.findByRole('button', { name: /Connect Demo wallet/ }));
    await user.click(await screen.findByRole('button', { name: 'Get test XLM' }));
    expect(
      await screen.findByText('Friendbot is not answering. Try again in a minute.'),
    ).toBeTruthy();
  });

  it('says so when the server cannot be reached at all', async () => {
    const api: ConsoleApi = {
      ...createMockApi({ delayMs: 0 }),
      config: () =>
        Promise.reject(new ApiError('network', 'We could not reach the UJIRA server.', 0)),
    };
    render(<App api={api} mock={false} />);
    expect(await screen.findByText('We could not reach the UJIRA server.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
