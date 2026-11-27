// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The key encryption key comes from the environment only. A server that keeps
// agent keys refuses to start without a valid one, rather than starting and
// failing on the first project, and a malformed one refuses to start whether
// or not anything needs it yet, so a bad value is found at deploy time.
//
// No message here repeats the value, not even in part: a key pasted into the
// wrong variable, or cut short, is still most of a key.

import { EngineError } from '../errors.js';
import { createSealer, SealError, type Sealer } from './sealer.js';

export const KEY_ENCRYPTION_KEY_VARIABLE = 'UJIRA_KEY_ENCRYPTION_KEY';

type Env = Readonly<Record<string, string | undefined>>;

const FORMAT = 'must be 32 random bytes in base64, such as the output of openssl rand -base64 32';

// The sealer under the configured key, or undefined when none is set.
export function sealerFromEnv(env: Env): Sealer | undefined {
  // Surrounding whitespace only: a host's secret field often keeps the
  // newline a paste brought with it, and base64 never contains one.
  const raw = env[KEY_ENCRYPTION_KEY_VARIABLE]?.trim();
  if (raw === undefined || raw === '') return undefined;
  try {
    return createSealer(raw);
  } catch (error) {
    // SealError carries no part of the key, but it is left off anyway so a
    // later change to it cannot start leaking through here.
    if (error instanceof SealError) {
      throw new EngineError('config_invalid', `${KEY_ENCRYPTION_KEY_VARIABLE} ${FORMAT}`);
    }
    throw error;
  }
}

// For a role that keeps agent keys or personal data. `why` names the setting
// that needs it, so the person reading the refusal knows what turned it on.
export function requireSealer(env: Env, why: string): Sealer {
  const sealer = sealerFromEnv(env);
  if (sealer === undefined) {
    throw new EngineError(
      'config_invalid',
      `${why} needs ${KEY_ENCRYPTION_KEY_VARIABLE}, which ${FORMAT}`,
    );
  }
  return sealer;
}
