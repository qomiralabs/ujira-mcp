// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The dashboard around the console: the sidebar, path routing under /app, and
// the pages that look across every mandate the wallet owns.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createMockApi } from '../lib/mock';
import { App } from './App';

const LONG = { timeout: 4000 };
type User = ReturnType<typeof userEvent.setup>;

function nav() {
  return within(screen.getByRole('navigation', { name: 'Dashboard' }));
}

async function connectReadyWallet(user: User) {
  await user.click(await screen.findByRole('button', { name: /Connect Demo wallet/ }));
  await user.click(await screen.findByRole('button', { name: 'Get test XLM' }));
  await user.click(await screen.findByRole('button', { name: 'Add USDC' }, LONG));
  const topUp = 'Top up to 50 test USDC';
  await waitFor(() => {
    expect(screen.getByRole('button', { name: topUp })).toHaveProperty('disabled', false);
  });
  await user.click(screen.getByRole('button', { name: topUp }));
  await screen.findByText('50.00 USDC in your wallet', undefined, LONG);
}

async function createMandate(user: User) {
  await user.click(screen.getByRole('link', { name: 'Create a mandate' }));
  expect(location.pathname).toBe('/app/mandates/new');
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
  await screen.findByRole('heading', { name: 'The rules' }, LONG);
  expect(location.pathname).toMatch(/^\/app\/mandates\/C[A-Z2-7]{55}$/);
}

async function openPage(user: User, name: string, title = name) {
  await user.click(nav().getByRole('link', { name: new RegExp(`^${name}`) }));
  await screen.findByRole('heading', { level: 1, name: title });
}

describe('the dashboard', () => {
  it('has one sidebar with every page under /app, and the logo goes home', async () => {
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    const links: [RegExp, string][] = [
      [/^Overview/, '/app'],
      [/^Mandates/, '/app/mandates'],
      [/^Payouts/, '/app/payouts'],
      [/^Approvals/, '/app/approvals'],
      [/^Receipts/, '/app/receipts'],
      [/^Recipients/, '/app/recipients'],
      [/^Developers/, '/app/developers'],
      [/^Local currency/, '/app/local-currency'],
      [/^Team and keys/, '/app/team'],
      [/^Wallet activity/, '/app/activity'],
      [/^Testnet proof/, '/instaward'],
    ];
    for (const [name, href] of links) {
      expect(nav().getByRole('link', { name }).getAttribute('href')).toBe(href);
    }
    expect(
      nav()
        .getByRole('link', { name: /^Overview/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(nav().getAllByText('Soon')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'UJIRA home page' }).getAttribute('href')).toBe('/');
    expect(screen.getByText('Testnet')).toBeTruthy();
  });

  it('keeps mock mode in every link', async () => {
    history.replaceState(null, '', '/app?mock=1');
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(
      nav()
        .getByRole('link', { name: /^Approvals/ })
        .getAttribute('href'),
    ).toBe('/app/approvals?mock=1');
  });

  it('opens a deep link and asks for a wallet where one is needed', async () => {
    history.replaceState(null, '', '/app/approvals');
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await screen.findByRole('heading', { level: 1, name: 'Approvals' });
    expect(
      screen.getByRole('heading', { name: 'Connect a wallet to see what waits for your approval' }),
    ).toBeTruthy();
    expect(
      nav()
        .getByRole('link', { name: /^Approvals/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('moves between pages without a reload and follows the back button', async () => {
    const user = userEvent.setup();
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await openPage(user, 'Receipts');
    expect(location.pathname).toBe('/app/receipts');
    await openPage(user, 'Developers');
    expect(location.pathname).toBe('/app/developers');
    history.back();
    await screen.findByRole('heading', { level: 1, name: 'Receipts' });
  });

  it.each([
    ['/app/local-currency', 'Local currency', 'Local currency payouts'],
    ['/app/team', 'Team and keys', 'Team and keys'],
    ['/app/activity', 'Wallet activity', 'Wallet activity'],
  ])('shows %s as in progress, never hidden', async (path, title, card) => {
    history.replaceState(null, '', path);
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await screen.findByRole('heading', { level: 1, name: title });
    const region = within(screen.getByRole('region', { name: card }));
    expect(region.getByText('In progress')).toBeTruthy();
    expect(region.getAllByText('Soon').length).toBeGreaterThan(0);
  });

  it('says so for an address that is not a page', async () => {
    history.replaceState(null, '', '/app/nowhere');
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await screen.findByRole('heading', { level: 1, name: 'Page not found' });
    expect(screen.getByRole('link', { name: 'Go to the overview' }).getAttribute('href')).toBe(
      '/app',
    );
  });

  it(
    'pays, approves and lists across mandates from the sidebar pages',
    { timeout: 40_000 },
    async () => {
      const user = userEvent.setup();
      render(<App api={createMockApi({ delayMs: 0 })} mock />);
      await connectReadyWallet(user);
      await createMandate(user);

      // Mandates: the new one is listed.
      await openPage(user, 'Mandates');
      const list = within(screen.getByRole('region', { name: 'Your mandates' }));
      expect(await list.findByText('Active')).toBeTruthy();

      // Payouts: act as the agent from here, once paid and once over the approval amount.
      await openPage(user, 'Payouts');
      const agent = within(
        await screen.findByRole('region', { name: /Act as the AI agent/ }, LONG),
      );
      await user.click(agent.getByRole('button', { name: 'Request payout' }));
      await agent.findByText('Paid 1.00 USDC to Ada');
      const amount = agent.getByLabelText('Amount');
      await user.clear(amount);
      await user.type(amount, '12');
      await user.click(agent.getByRole('button', { name: 'Request payout' }));
      await agent.findByText('Waiting for your approval');
      const payouts = within(screen.getByRole('region', { name: 'Every payout' }));
      await waitFor(() => {
        expect(payouts.getAllByRole('row')).toHaveLength(3);
      }, LONG);
      await waitFor(() => {
        expect(nav().getByRole('link', { name: /^Approvals/ }).textContent).toBe(
          'Approvals1 waiting',
        );
      }, LONG);

      // Approvals: approve in the wallet, then pay.
      await openPage(user, 'Approvals');
      const card = within(await screen.findByRole('region', { name: /^Mandate C/ }, LONG));
      await user.click(card.getByRole('button', { name: 'Approve' }));
      await user.click(await card.findByRole('button', { name: 'Pay now' }, LONG));
      await screen.findByText('Paid 12.00 USDC to Ada', undefined, LONG);
      await screen.findByRole('heading', { name: 'Nothing waiting' }, LONG);

      // Receipts: both payouts, each with its mandate.
      await openPage(user, 'Receipts');
      const receipts = within(screen.getByRole('region', { name: 'All receipts' }));
      await waitFor(() => {
        expect(receipts.getAllByRole('row')).toHaveLength(3);
      }, LONG);
      expect(receipts.getByText('Approved, paid')).toBeTruthy();
      expect(receipts.getAllByRole('link', { name: /open the mandate/ })).toHaveLength(2);

      // Recipients: allow one more wallet on the same mandate.
      await openPage(user, 'Recipients');
      const people = within(await screen.findByRole('region', { name: /^Mandate C/ }));
      expect(people.getByText('Ada')).toBeTruthy();
      await user.click(people.getByRole('button', { name: 'Use a test wallet' }));
      await people.findByText('Test wallet made by UJIRA, ready to receive USDC');
      await user.click(people.getByRole('button', { name: 'Allow and sign' }));
      await people.findByText('Kofi', undefined, LONG);
      expect(people.getByText(/Added to the list/)).toBeTruthy();

      // Developers: the mandate's own MCP address.
      await openPage(user, 'Developers');
      const claude = within(screen.getByRole('region', { name: /^Connect Claude to mandate/ }));
      const url = claude.getByLabelText<HTMLInputElement>('MCP address for this mandate').value;
      expect(url).toMatch(/\/m\/C[A-Z2-7]{55}\/mcp$/);
      expect(screen.getByText('request_payout')).toBeTruthy();

      // Overview: the figures add up.
      await openPage(user, 'Overview');
      expect(await screen.findByRole('region', { name: 'Recent payouts' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Get your wallet ready' })).toBeNull();
    },
  );

  it('blocks a recipient that is already on the list', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    render(<App api={createMockApi({ delayMs: 0 })} mock />);
    await connectReadyWallet(user);
    await createMandate(user);
    await openPage(user, 'Recipients');
    const people = within(await screen.findByRole('region', { name: /^Mandate C/ }, LONG));
    const ada = people.getByRole('link', { name: /opens Stellar Expert/ });
    const address = ada.textContent.replace(' (opens Stellar Expert)', '');
    await user.type(people.getByLabelText('Stellar address'), address);
    await user.click(people.getByRole('button', { name: 'Allow and sign' }));
    expect(await people.findByText('This wallet is already on the list.')).toBeTruthy();
  });
});
