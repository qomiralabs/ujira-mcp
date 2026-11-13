// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import 'virtual:ujira-tokens.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { createHttpApi } from './lib/api';
import { mockRequested } from './lib/wallet';

const mock = mockRequested();
// The mock API is only downloaded when someone asks for it.
const api = mock ? (await import('./lib/mock')).createMockApi() : createHttpApi();
const root = document.getElementById('root');
if (root === null) throw new Error('The page has no #root element');

createRoot(root).render(
  <StrictMode>
    <App api={api} mock={mock} />
  </StrictMode>,
);
