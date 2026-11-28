// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Sign in in front of every page, against the fake /v1 routes: each step's
// loading, error and empty state, the first visit, the project switcher,
// sign out, and what is kept on the device.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ApiError, type ConsoleApi } from '../lib/api';
import type { AuthApi } from '../lib/auth';
import { createFakeAuthApi, type FakeAuthOptions } from '../lib/fakeAuth';
import { createMockApi } from '../lib/mock';
import { MOCK_WALLET } from '../lib/wallet';
import { App } from './App';

type User = ReturnType<typeof userEvent.setup>;

const SIGN_IN = 'Sign in with your wallet';
const DEMO = /Continue with Demo wallet/;
const ACME = { address: MOCK_WALLET, principals: [{ name: 'Acme Ltd', projects: ['Payouts'] }] };

/**
 * A promise the test settles by hand. It is marked handled from the start: a
 * test can reject it before the console has asked for it, and that is not an
 * unhandled rejection. The console still sees the rejection when it awaits.
 */
function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function setup(options: FakeAuthOptions = {}, override: Partial<AuthApi> = {}) {
  const fake = createFakeAuthApi({ delayMs: 0, ...options });
  const auth: AuthApi = { ...fake, ...override };
  const api = createMockApi({ delayMs: 0 });
  const user = userEvent.setup();
  render(<App api={api} auth={auth} mock />);
  return { fake, user };
}

async function signInDemo(user: User) {
  await user.click(await screen.findByRole('button', { name: DEMO }));
}

async function nameOrganisation(user: User, name: string) {
  await screen.findByRole('heading', { level: 1, name: 'Name your organisation' });
  await user.type(screen.getByLabelText('Organisation name'), name);
  await user.click(screen.getByRole('button', { name: 'Create organisation' }));
}

function switcher() {
  return screen.getByRole('button', { name: /Switch project or sign out/ });
}

describe('sign in', () => {
  it('shows the sign in screen on every page while signed out', async () => {
    for (const path of ['/app', '/app/receipts', '/app/mandates/new', '/app/nowhere']) {
      history.replaceState(null, '', `${path}?mock=1`);
      const { unmount } = render(
        <App api={createMockApi({ delayMs: 0 })} auth={createFakeAuthApi({ delayMs: 0 })} mock />,
      );
      expect(await screen.findByRole('heading', { level: 1, name: SIGN_IN })).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'Dashboard' })).toBeNull();
      // Arriving signed out is not a lost session.
      expect(screen.queryByText(/session has ended/)).toBeNull();
      expect(screen.getByRole('button', { name: /Continue with Freighter/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Continue with Albedo/ })).toBeTruthy();
      unmount();
    }
  });

  it('says it is checking before it knows', async () => {
    const me = deferred<never>();
    let asked = 0;
    setup(
      {},
      {
        me: () => {
          asked += 1;
          return me.promise;
        },
      },
    );
    expect(await screen.findByRole('status', { name: 'Checking your sign in' })).toBeTruthy();
    // The answer comes only once the console has asked for it.
    await waitFor(() => {
      expect(asked).toBe(1);
    });
    me.reject(new ApiError('SESSION_INVALID', 'gone', 401));
    expect(await screen.findByRole('heading', { level: 1, name: SIGN_IN })).toBeTruthy();
  });

  it('offers a retry when the check cannot reach the server', async () => {
    let fail = true;
    const fake = createFakeAuthApi({ delayMs: 0 });
    const { user } = setup(
      {},
      {
        me: () =>
          fail
            ? Promise.reject(new ApiError('network', 'We could not reach the UJIRA server.', 0))
            : fake.me(),
      },
    );
    expect(await screen.findByText('We could not reach the UJIRA server.')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: SIGN_IN })).toBeTruthy();
  });

  it('walks a first visit from wallet to organisation to the page asked for', async () => {
    history.replaceState(null, '', '/app/receipts?mock=1');
    const { user, fake } = setup();
    await signInDemo(user);
    await nameOrganisation(user, 'Acme Ltd');
    expect(await screen.findByRole('heading', { level: 1, name: 'Receipts' })).toBeTruthy();
    expect(location.pathname).toBe('/app/receipts');
    const button = switcher();
    expect(within(button).getByText('Acme Ltd')).toBeTruthy();
    expect(within(button).getByText('Main')).toBeTruthy();
    expect(fake.inspect().project).not.toBeNull();
  });

  it('shows each sign in step as it happens, in words', async () => {
    const challenge = deferred<Awaited<ReturnType<AuthApi['challenge']>>>();
    const session = deferred<Awaited<ReturnType<AuthApi['startSession']>>>();
    const fake = createFakeAuthApi({ delayMs: 0, seed: [ACME] });
    const { user } = setup(
      { seed: [ACME] },
      {
        me: fake.me,
        projects: fake.projects,
        challenge: () => challenge.promise,
        startSession: () => session.promise,
      },
    );
    await signInDemo(user);
    const steps = within(await screen.findByRole('list', { name: 'Sign in steps' }));
    expect(steps.getByText('Preparing the message')).toBeTruthy();
    expect(steps.getByText(/\(done\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Signing in with Demo wallet/ })).toHaveProperty(
      'disabled',
      true,
    );

    const real = await fake.challenge(MOCK_WALLET);
    challenge.resolve(real);
    expect(await steps.findByText('Signing you in')).toBeTruthy();
    expect(steps.getAllByText(/\(done\)/)).toHaveLength(2);

    session.resolve(
      await fake.startSession({
        challengeId: real.challengeId,
        address: MOCK_WALLET,
        signature: 'x',
      }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
  });

  it('says what went wrong at a step and tries again from the start', async () => {
    let refuse = true;
    const fake = createFakeAuthApi({ delayMs: 0, seed: [ACME] });
    const { user } = setup(
      { seed: [ACME] },
      {
        me: fake.me,
        projects: fake.projects,
        challenge: fake.challenge,
        startSession: (p) =>
          refuse
            ? Promise.reject(
                new ApiError('SIGNATURE_INVALID', 'The wallet signature did not match.', 401),
              )
            : fake.startSession(p),
      },
    );
    await signInDemo(user);
    expect(await screen.findByText('The wallet signature did not match.')).toBeTruthy();
    const steps = within(screen.getByRole('list', { name: 'Sign in steps' }));
    expect(steps.getByText(/\(stopped\)/)).toBeTruthy();
    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
  });

  it('asks again for an organisation name that is empty, and shows a refusal', async () => {
    let refuse = true;
    const fake = createFakeAuthApi({ delayMs: 0 });
    const { user } = setup(
      {},
      {
        ...fake,
        createPrincipal: (name) =>
          refuse
            ? Promise.reject(new ApiError('DB_UNAVAILABLE', 'UJIRA is busy for a moment.', 503))
            : fake.createPrincipal(name),
      },
    );
    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Name your organisation' });
    await user.click(screen.getByRole('button', { name: 'Create organisation' }));
    expect(screen.getByText('Enter your organisation name.')).toBeTruthy();
    expect(screen.getByLabelText('Organisation name').getAttribute('aria-invalid')).toBe('true');

    await user.type(screen.getByLabelText('Organisation name'), 'Acme Ltd');
    await user.click(screen.getByRole('button', { name: 'Create organisation' }));
    expect(await screen.findByText('UJIRA is busy for a moment.')).toBeTruthy();
    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Create organisation' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
  });

  it('lets a first visit use another wallet instead', async () => {
    const { user, fake } = setup();
    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Name your organisation' });
    await user.click(screen.getByRole('button', { name: 'Use another wallet' }));
    expect(await screen.findByRole('heading', { level: 1, name: SIGN_IN })).toBeTruthy();
    expect(fake.inspect().signedIn).toBe(false);
  });

  it('shows the projects loading, then an error with a retry', async () => {
    const first = deferred<never>();
    let calls = 0;
    const fake = createFakeAuthApi({ delayMs: 0, seed: [ACME] });
    const { user } = setup(
      { seed: [ACME] },
      {
        ...fake,
        projects: () => {
          calls += 1;
          return calls === 1 ? first.promise : fake.projects();
        },
      },
    );
    await signInDemo(user);
    expect(await screen.findByRole('status', { name: 'Loading your projects' })).toBeTruthy();
    first.reject(new ApiError('INTERNAL', 'The UJIRA server had a problem.', 500));
    expect(await screen.findByText('The UJIRA server had a problem.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
  });

  it('asks for a first project when the organisation has none', async () => {
    const { user } = setup({
      seed: [{ address: MOCK_WALLET, principals: [{ name: 'Acme Ltd', projects: [] }] }],
    });
    await signInDemo(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Create a project' })).toBeTruthy();
    expect(screen.getByText('Acme Ltd has no projects yet.')).toBeTruthy();
    await user.type(screen.getByLabelText('Project name'), 'Payouts');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    expect(within(switcher()).getByText('Payouts')).toBeTruthy();
  });

  it('returns to sign in when the session ends on the way', async () => {
    const fake = createFakeAuthApi({ delayMs: 0, seed: [ACME] });
    const { user } = setup(
      { seed: [ACME] },
      {
        ...fake,
        projects: () => Promise.reject(new ApiError('SESSION_INVALID', 'gone', 401)),
      },
    );
    await signInDemo(user);
    expect(await screen.findByText('Your session has ended. Sign in again.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: SIGN_IN })).toBeTruthy();
  });

  it('opens straight into the dashboard when the session is still good', async () => {
    setup({ seed: [ACME], signedInAs: MOCK_WALLET });
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    expect(within(switcher()).getByText('Acme Ltd')).toBeTruthy();
  });

  it('only shows a live server sign in once its config turns it on', async () => {
    const base = createMockApi({ delayMs: 0 });
    const off = render(<App api={base} auth={createFakeAuthApi({ delayMs: 0 })} mock={false} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    off.unmount();

    const on: ConsoleApi = {
      ...base,
      config: async () => ({ ...(await base.config()), signIn: true }),
    };
    render(<App api={on} auth={createFakeAuthApi({ delayMs: 0 })} mock={false} />);
    expect(await screen.findByRole('heading', { level: 1, name: SIGN_IN })).toBeTruthy();
    expect(screen.queryByRole('button', { name: DEMO })).toBeNull();
  });
});

describe('signed in', () => {
  const TWO = {
    address: MOCK_WALLET,
    principals: [
      { name: 'Acme Ltd', projects: ['Payouts', 'Grants'] },
      { name: 'Beta Co', projects: ['Prizes'] },
    ],
  };

  it('switches projects from the header and sends the project with each request', async () => {
    const { user, fake } = setup({ seed: [TWO] });
    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    const before = fake.inspect().project;

    await user.click(switcher());
    const menu = within(screen.getByRole('group', { name: 'Beta Co' }));
    await user.click(menu.getByRole('button', { name: 'Prizes' }));
    expect(within(switcher()).getByText('Beta Co')).toBeTruthy();
    expect(within(switcher()).getByText('Prizes')).toBeTruthy();
    expect(fake.inspect().project).not.toBe(before);
    expect(document.activeElement).toBe(switcher());
  });

  it('marks the open project with a mark and a word, not colour alone', async () => {
    const { user } = setup({ seed: [TWO] });
    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await user.click(switcher());
    const open = screen.getByRole('button', { name: /Payouts \(open\)/ });
    expect(open.getAttribute('aria-current')).toBe('true');
  });

  it('restores the last project on the next sign in', async () => {
    const { user } = setup({ seed: [TWO] });
    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await user.click(switcher());
    await user.click(screen.getByRole('button', { name: 'Grants' }));
    await user.click(switcher());
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { level: 1, name: SIGN_IN });

    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(within(switcher()).getByText('Grants')).toBeTruthy();
  });

  it('creates a project from the switcher and opens it', async () => {
    const { user } = setup({ seed: [TWO] });
    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await user.click(switcher());
    await user.click(screen.getByRole('button', { name: 'New project in Beta Co' }));
    const name = screen.getByLabelText('Project name');
    expect(document.activeElement).toBe(name);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Enter a project name.')).toBeTruthy();
    await user.type(name, 'Bounties');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(within(switcher()).getByText('Bounties')).toBeTruthy();
    });
    expect(switcher().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(switcher());
    expect(switcher().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(switcher());
  });

  it('works the switcher from the keyboard and closes it with Escape', async () => {
    const { user } = setup({ seed: [TWO] });
    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    switcher().focus();
    await user.keyboard('{Enter}');
    expect(switcher().getAttribute('aria-expanded')).toBe('true');
    await user.tab();
    expect(document.activeElement?.textContent).toContain('Payouts');
    await user.keyboard('{Escape}');
    expect(switcher().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(switcher());
  });

  it('signs out: ends the session, forgets the wallet and every loaded page', async () => {
    const { user, fake } = setup({ seed: [TWO] });
    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(localStorage.getItem('ujira.console.wallet')).not.toBeNull();

    await user.click(switcher());
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: SIGN_IN })).toBeTruthy();
    expect(screen.getByText('You are signed out.')).toBeTruthy();
    expect(fake.inspect()).toMatchObject({ signedIn: false, project: null });
    expect(localStorage.getItem('ujira.console.wallet')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Dashboard' })).toBeNull();
  });

  it('stays signed in and says so when sign out does not reach the server', async () => {
    const fake = createFakeAuthApi({ delayMs: 0, seed: [TWO] });
    const { user } = setup(
      { seed: [TWO] },
      {
        ...fake,
        endSession: () =>
          Promise.reject(new ApiError('network', 'We could not reach the UJIRA server.', 0)),
      },
    );
    await signInDemo(user);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await user.click(switcher());
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('We could not reach the UJIRA server.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
  });

  it('keeps no signature, message or session in browser storage', async () => {
    const seen: string[] = [];
    const fake = createFakeAuthApi({ delayMs: 0 });
    const { user } = setup(
      {},
      {
        ...fake,
        challenge: async (address) => {
          const c = await fake.challenge(address);
          seen.push(c.message, c.challengeId);
          return c;
        },
        startSession: (p) => {
          seen.push(p.signature);
          return fake.startSession(p);
        },
      },
    );
    await signInDemo(user);
    await nameOrganisation(user, 'Acme Ltd');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(seen).toHaveLength(3);

    const stored: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i) ?? '';
        stored.push(key, store.getItem(key) ?? '');
      }
    }
    const everything = stored.join('\n');
    for (const value of seen) expect(everything).not.toContain(value);
    expect(document.cookie).toBe('');
  });
});
