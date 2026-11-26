// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import './brand/tokens.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { migrateLegacyHash } from './app/routes';
import { createHttpApi } from './lib/api';
import { createHttpAuthApi } from './lib/auth';
import { mockRequested } from './lib/wallet';

// Links from before the move to /app used hash routes; read them as paths.
migrateLegacyHash();
const mock = mockRequested();
// The mock API and the fake sign in are only downloaded when someone asks for them.
const api = mock ? (await import('./lib/mock')).createMockApi() : createHttpApi();
const auth = mock ? (await import('./lib/fakeAuth')).createFakeAuthApi() : createHttpAuthApi();
const root = document.getElementById('root');
if (root === null) throw new Error('The page has no #root element');

createRoot(root).render(
  <StrictMode>
    <App api={api} auth={auth} mock={mock} />
  </StrictMode>,
);
