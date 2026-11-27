// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import './brand/tokens.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { migrateLegacyHash } from './app/routes';
import { v1ScreensFor } from './app/switch';
import { createHttpApi, type ConsoleApi } from './lib/api';
import { createHttpAuthApi, type AuthApi } from './lib/auth';
import { createHttpV1Api, createV1Transport, type V1Api } from './lib/v1';
import { mockRequested } from './lib/wallet';

// Links from before the move to /app used hash routes; read them as paths.
migrateLegacyHash();
const mock = mockRequested();
const v1Screens = v1ScreensFor(import.meta.env.VITE_V1_SCREENS, mock);

async function clients(): Promise<{ api: ConsoleApi; auth: AuthApi; v1: V1Api }> {
  if (mock) {
    // The mock API and the fakes are only downloaded when someone asks for them.
    const [{ createMockApi }, { createFakeAuthApi }, { createFakeV1Api }] = await Promise.all([
      import('./lib/mock'),
      import('./lib/fakeAuth'),
      import('./lib/fakeV1'),
    ]);
    const auth = createFakeAuthApi();
    return { api: createMockApi(), auth, v1: createFakeV1Api(auth) };
  }
  // Sign in and the data routes share one transport, so they name the same project.
  const transport = createV1Transport();
  return {
    api: createHttpApi(),
    auth: createHttpAuthApi(transport),
    v1: createHttpV1Api(transport),
  };
}

const { api, auth, v1 } = await clients();
const root = document.getElementById('root');
if (root === null) throw new Error('The page has no #root element');

createRoot(root).render(
  <StrictMode>
    <App api={api} auth={auth} v1={v1} v1Screens={v1Screens} mock={mock} />
  </StrictMode>,
);
