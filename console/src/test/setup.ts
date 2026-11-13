// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  localStorage.clear();
  location.hash = '';
});
