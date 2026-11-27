// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// How the migration command line connects, decided from its environment
// alone. No database is reached here.

import { describe, expect, it } from 'vitest';

import { migrationTransport } from './migrate-cli.js';
import { PINNED_TLS } from './tls.js';

const KEYS = ['UJIRA_DB_MIGRATOR_URL', 'UJIRA_DB_BOOTSTRAP_URL'] as const;
const RENDER = 'postgresql://ujira_migrator:secret@dpg-x-a.virginia-postgres.render.com:5432/ujira';
const LOCAL = 'postgresql://postgres:secret@127.0.0.1:55432/postgres';

describe('migrationTransport', () => {
  it('pins TLS by default and when asked', () => {
    for (const mode of [undefined, '', 'pinned']) {
      const result = migrationTransport(
        { UJIRA_DB_TLS: mode, UJIRA_DB_MIGRATOR_URL: RENDER, UJIRA_DB_BOOTSTRAP_URL: RENDER },
        KEYS,
      );
      expect(result).toEqual({ ok: true, tls: PINNED_TLS });
    }
  });

  it('pins TLS for a loopback host too, unless it is turned off', () => {
    expect(migrationTransport({ UJIRA_DB_MIGRATOR_URL: LOCAL }, KEYS)).toEqual({
      ok: true,
      tls: PINNED_TLS,
    });
    expect(migrationTransport({ UJIRA_DB_TLS: 'off', UJIRA_DB_MIGRATOR_URL: LOCAL }, KEYS)).toEqual(
      { ok: true, tls: undefined },
    );
  });

  it('refuses to turn TLS off when any URL names a real host', () => {
    const result = migrationTransport(
      { UJIRA_DB_TLS: 'off', UJIRA_DB_MIGRATOR_URL: LOCAL, UJIRA_DB_BOOTSTRAP_URL: RENDER },
      KEYS,
    );
    expect(result).toEqual({
      ok: false,
      message:
        'UJIRA_DB_TLS=off is only allowed for a loopback host, and UJIRA_DB_BOOTSTRAP_URL names another host',
    });
  });

  it('refuses an unknown mode', () => {
    expect(
      migrationTransport({ UJIRA_DB_TLS: 'maybe', UJIRA_DB_MIGRATOR_URL: RENDER }, KEYS),
    ).toEqual({ ok: false, message: "UJIRA_DB_TLS must be 'pinned' or 'off'" });
  });

  it.each(['sslmode=disable', 'sslmode=require', 'ssl=false', 'sslrootcert=/tmp/other.crt'])(
    'refuses a URL that sets %s, which would replace the pinned trust',
    (query) => {
      const result = migrationTransport({ UJIRA_DB_MIGRATOR_URL: `${RENDER}?${query}` }, KEYS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('src/db/tls.ts');
    },
  );

  it.each(['6432', '6543'])('refuses the transaction pooler port %s for either login', (port) => {
    const pooled = RENDER.replace(':5432/', `:${port}/`);
    for (const key of KEYS) {
      const result = migrationTransport({ UJIRA_DB_MIGRATOR_URL: RENDER, [key]: pooled }, KEYS);
      expect(result).toEqual({
        ok: false,
        message: `${key} must not use the transaction pooler port ${port}: the migration lock is held in the session, so connect directly on 5432`,
      });
    }
  });

  it('never quotes a URL back, since it carries a password', () => {
    for (const env of [
      { UJIRA_DB_MIGRATOR_URL: `${RENDER}?sslmode=disable` },
      { UJIRA_DB_MIGRATOR_URL: 'not a url secret' },
      { UJIRA_DB_TLS: 'off', UJIRA_DB_MIGRATOR_URL: RENDER },
    ]) {
      const result = migrationTransport(env, KEYS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toContain('secret');
    }
  });

  it('skips a URL that is not set', () => {
    expect(
      migrationTransport({ UJIRA_DB_MIGRATOR_URL: RENDER, UJIRA_DB_BOOTSTRAP_URL: '' }, KEYS),
    ).toEqual({ ok: true, tls: PINNED_TLS });
  });
});
