// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_BUDGET,
  loadDatabaseConfig,
  POOL_DEFAULTS,
  type DatabaseEnvironment,
} from './config.js';
import { DatabaseConfigError } from './errors.js';
import { PINNED_TLS } from './tls.js';

const URLS: DatabaseEnvironment = {
  UJIRA_DB_APP_URL: 'postgresql://app:secret@pooler.example:6543/postgres',
  UJIRA_DB_WORKER_URL: 'postgresql://worker:secret@pooler.example:5432/postgres',
  UJIRA_DB_MIGRATOR_URL: 'postgresql://migrator:secret@pooler.example:5432/postgres',
};

describe('loadDatabaseConfig', () => {
  it('reads the three logins from the environment', () => {
    const config = loadDatabaseConfig(URLS);
    expect(config.app.url.reveal()).toBe(URLS.UJIRA_DB_APP_URL);
    expect(config.worker.url.reveal()).toBe(URLS.UJIRA_DB_WORKER_URL);
    expect(config.migration.url.reveal()).toBe(URLS.UJIRA_DB_MIGRATOR_URL);
  });

  it('logs the reader in as the app unless it has a URL of its own', () => {
    expect(loadDatabaseConfig(URLS).reader.url.reveal()).toBe(URLS.UJIRA_DB_APP_URL);
    expect(loadDatabaseConfig({ ...URLS, UJIRA_DB_READER_URL: ' ' }).reader.url.reveal()).toBe(
      URLS.UJIRA_DB_APP_URL,
    );
    const own = 'postgresql://reader:secret@pooler.example:6543/postgres';
    expect(loadDatabaseConfig({ ...URLS, UJIRA_DB_READER_URL: own }).reader.url.reveal()).toBe(own);
  });

  it('names the variable it read when the reader falls back to a bad app URL', () => {
    expect(() => loadDatabaseConfig({ ...URLS, UJIRA_DB_APP_URL: 'nope' })).toThrow(
      /UJIRA_DB_APP_URL/,
    );
  });

  it.each(['UJIRA_DB_APP_URL', 'UJIRA_DB_WORKER_URL', 'UJIRA_DB_MIGRATOR_URL'] as const)(
    'refuses a missing %s',
    (key) => {
      const env = Object.fromEntries(
        Object.entries(URLS).filter(([name]) => name !== key),
      ) as DatabaseEnvironment;
      expect(() => loadDatabaseConfig(env)).toThrow(DatabaseConfigError);
    },
  );

  it('never puts a URL in the message, because it carries the password', () => {
    let message = '';
    try {
      loadDatabaseConfig({ ...URLS, UJIRA_DB_APP_URL: 'http://app:secret@host/db' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('UJIRA_DB_APP_URL');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('host');
  });

  it.each([
    ['an empty url', ''],
    ['a url with no scheme', 'pooler.example:6543/postgres'],
    ['a http url', 'http://pooler.example/postgres'],
    ['a url with no host', 'postgresql:///postgres'],
    ['a url with no database', 'postgresql://app:secret@pooler.example:6543'],
  ])('refuses %s', (_name, url) => {
    expect(() => loadDatabaseConfig({ ...URLS, UJIRA_DB_APP_URL: url })).toThrow(
      DatabaseConfigError,
    );
  });

  it('refuses an ssl parameter in a url, which would replace the pinned trust', () => {
    // The spike refuses these for the same reason: pg lets sslmode turn
    // verification, or TLS itself, off.
    for (const url of [
      'postgresql://app:s@pooler.example:6543/postgres?sslmode=disable',
      'postgresql://app:s@pooler.example:6543/postgres?sslmode=no-verify',
      'postgresql://app:s@pooler.example:6543/postgres?ssl=false',
      'postgresql://app:s@pooler.example:6543/postgres?sslrootcert=/tmp/other.crt',
    ]) {
      expect(() => loadDatabaseConfig({ ...URLS, UJIRA_DB_APP_URL: url }), url).toThrow(
        DatabaseConfigError,
      );
    }
  });

  it('refuses the transaction pooler port for the worker and the migrator', () => {
    // Measured in the spike: the transaction pooler delivers no LISTEN
    // notification, and the migration tool takes a session level advisory
    // lock, so neither role may point at PgBouncer's 6432, where Render runs
    // it, or Supavisor's 6543. Any other port is allowed, so a local
    // Postgres works.
    for (const port of ['6432', '6543']) {
      const onTransactionPort = `postgresql://worker:s@pooler.example:${port}/postgres`;
      expect(() => loadDatabaseConfig({ ...URLS, UJIRA_DB_WORKER_URL: onTransactionPort })).toThrow(
        `UJIRA_DB_WORKER_URL must not use the transaction pooler port ${port}`,
      );
      expect(() =>
        loadDatabaseConfig({ ...URLS, UJIRA_DB_MIGRATOR_URL: onTransactionPort }),
      ).toThrow(DatabaseConfigError);
    }
    // A local container on a random port is fine for both.
    expect(() =>
      loadDatabaseConfig({
        ...URLS,
        UJIRA_DB_WORKER_URL: 'postgresql://worker:s@127.0.0.1:55001/postgres',
        UJIRA_DB_MIGRATOR_URL: 'postgresql://migrator:s@127.0.0.1:55001/postgres',
      }),
    ).not.toThrow();
  });

  it('applies conservative pool defaults', () => {
    const config = loadDatabaseConfig(URLS);
    expect(config.app.poolSize).toBe(POOL_DEFAULTS.app);
    expect(config.worker.poolSize).toBe(POOL_DEFAULTS.worker);
    expect(config.reader.poolSize).toBe(POOL_DEFAULTS.reader);
    expect(config.migration.poolSize).toBe(POOL_DEFAULTS.migration);
  });

  it('sizes the app and worker pools by UJIRA_DB_POOL_SIZE, inside the budget', () => {
    const config = loadDatabaseConfig({ ...URLS, UJIRA_DB_POOL_SIZE: '3' });
    expect(config.app.poolSize).toBe(3);
    expect(config.worker.poolSize).toBe(3);
    expect(config.reader.poolSize).toBe(POOL_DEFAULTS.reader);
    expect(config.migration.poolSize).toBe(POOL_DEFAULTS.migration);
    // Two pools take the size, and the reader and the migrator keep theirs.
    const fixed = POOL_DEFAULTS.reader + POOL_DEFAULTS.migration;
    const largest = Math.floor((CONNECTION_BUDGET.reservedForUs - fixed) / 2);
    expect(() => loadDatabaseConfig({ ...URLS, UJIRA_DB_POOL_SIZE: String(largest + 1) })).toThrow(
      DatabaseConfigError,
    );
    expect(() =>
      loadDatabaseConfig({ ...URLS, UJIRA_DB_POOL_SIZE: String(largest) }),
    ).not.toThrow();
  });

  it('lets the app and the reader use the transaction pooler, since they listen for nothing', () => {
    expect(() =>
      loadDatabaseConfig({
        ...URLS,
        UJIRA_DB_READER_URL: 'postgresql://reader:s@pooler.example:6543/postgres',
      }),
    ).not.toThrow();
  });

  it('keeps the defaults inside the measured connection budget', () => {
    // The Render plan allows 100 client connections, and the instance
    // reports max_connections 103. Defaults that can exhaust it would take
    // the database down rather than slow it.
    const total = Object.values(POOL_DEFAULTS).reduce((sum, size) => sum + size, 0);
    expect(CONNECTION_BUDGET.maxConnections).toBe(100);
    expect(total).toBeLessThanOrEqual(CONNECTION_BUDGET.reservedForUs);
    expect(CONNECTION_BUDGET.reservedForUs).toBeLessThan(CONNECTION_BUDGET.maxConnections);
  });

  it('refuses a pool size that would not leave room for the others', () => {
    expect(() =>
      loadDatabaseConfig({
        ...URLS,
        UJIRA_DB_POOL_SIZE: String(CONNECTION_BUDGET.maxConnections),
      }),
    ).toThrow(DatabaseConfigError);
  });

  it('reads the sizes and timeouts when they are set', () => {
    const config = loadDatabaseConfig({
      ...URLS,
      UJIRA_DB_POOL_SIZE: '7',
      UJIRA_DB_ACQUIRE_TIMEOUT_MS: '2500',
      UJIRA_DB_STATEMENT_TIMEOUT_MS: '4000',
      UJIRA_DB_LOCK_TIMEOUT_MS: '1500',
    });
    expect(config.app.poolSize).toBe(7);
    expect(config.acquireTimeoutMs).toBe(2500);
    expect(config.statementTimeoutMs).toBe(4000);
    expect(config.lockTimeoutMs).toBe(1500);
  });

  it.each([
    ['a size that is not a number', { UJIRA_DB_POOL_SIZE: 'four' }],
    ['a zero size', { UJIRA_DB_POOL_SIZE: '0' }],
    ['a negative size', { UJIRA_DB_POOL_SIZE: '-1' }],
    ['a fractional size', { UJIRA_DB_POOL_SIZE: '1.5' }],
    ['a size with spaces', { UJIRA_DB_POOL_SIZE: ' 4 ' }],
    ['a zero timeout', { UJIRA_DB_STATEMENT_TIMEOUT_MS: '0' }],
    ['a timeout that is not a number', { UJIRA_DB_LOCK_TIMEOUT_MS: 'soon' }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => loadDatabaseConfig({ ...URLS, ...overrides })).toThrow(DatabaseConfigError);
  });

  it('keeps the statement timeout under 8 s', () => {
    // The app role's server side limits in the roles migration sit under
    // 8 s. A longer one here would never be reached.
    const config = loadDatabaseConfig(URLS);
    expect(config.statementTimeoutMs).toBeLessThan(8_000);
    expect(config.lockTimeoutMs).toBeLessThan(8_000);
    expect(() => loadDatabaseConfig({ ...URLS, UJIRA_DB_STATEMENT_TIMEOUT_MS: '9000' })).toThrow(
      DatabaseConfigError,
    );
  });

  it('is frozen, so nothing can retune a pool after it is read', () => {
    const config = loadDatabaseConfig(URLS);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.app)).toBe(true);
  });
});

describe('TLS', () => {
  // Security review blocked an earlier version of this file: it refused the
  // one parameter an operator would use to ask for verified TLS, told them
  // trust was pinned in the module, and pinned nothing, so a server that
  // permits plaintext got tenant identifiers in the clear.
  it('pins the trust by default, and hands the driver the pinned object', () => {
    const config = loadDatabaseConfig(URLS);
    expect(config.tls).toBe('pinned');
    expect(config.tlsOptions).toBe(PINNED_TLS);
    expect(config.tlsOptions?.rejectUnauthorized).toBe(true);
  });

  it('refuses an ssl parameter and says where the trust lives', () => {
    let message = '';
    try {
      loadDatabaseConfig({
        ...URLS,
        UJIRA_DB_APP_URL: 'postgresql://app:s@pooler.example:6543/postgres?sslmode=require',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    // The message must point at the mechanism that exists.
    expect(message).toContain('src/db/tls.ts');
  });

  it('allows TLS to be turned off for a loopback host, which is how a container is reached', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const url = `postgresql://app:s@${host}:55432/postgres`;
      const config = loadDatabaseConfig({
        UJIRA_DB_TLS: 'off',
        UJIRA_DB_APP_URL: url,
        UJIRA_DB_WORKER_URL: url,
        UJIRA_DB_MIGRATOR_URL: url,
      });
      expect(config.tls, host).toBe('off');
      expect(config.tlsOptions, host).toBeUndefined();
    }
  });

  it('refuses TLS off for any host that is not loopback', () => {
    expect(() => loadDatabaseConfig({ ...URLS, UJIRA_DB_TLS: 'off' })).toThrow(DatabaseConfigError);
    // Including one that merely looks local.
    expect(() =>
      loadDatabaseConfig({
        ...URLS,
        UJIRA_DB_TLS: 'off',
        UJIRA_DB_APP_URL: 'postgresql://app:s@localhost.attacker.example:6543/postgres',
      }),
    ).toThrow(DatabaseConfigError);
  });

  it.each(['no', 'disable', 'PINNED', 'true', ''])('refuses the TLS mode %s', (mode) => {
    if (mode === '') {
      // Empty is treated as unset, which means pinned.
      expect(loadDatabaseConfig({ ...URLS, UJIRA_DB_TLS: mode }).tls).toBe('pinned');
      return;
    }
    expect(() => loadDatabaseConfig({ ...URLS, UJIRA_DB_TLS: mode })).toThrow(DatabaseConfigError);
  });
});

describe('URL query parameters', () => {
  it('refuses options, which pg forwards as a startup parameter', () => {
    // Security verified this is not cosmetic: the parameter reaches the
    // server and can set a session level tenant key on a pooled connection
    // before any statement exists for the guard to see.
    expect(() =>
      loadDatabaseConfig({
        ...URLS,
        UJIRA_DB_APP_URL:
          'postgresql://app:s@pooler.example:6543/postgres?options=-c%20ujira.principal_id%3Dattacker',
      }),
    ).toThrow(DatabaseConfigError);
  });

  it.each(['application_name=ujira-api', 'connect_timeout=5'])('allows %s', (query) => {
    expect(() =>
      loadDatabaseConfig({
        ...URLS,
        UJIRA_DB_APP_URL: `postgresql://app:s@pooler.example:6543/postgres?${query}`,
      }),
    ).not.toThrow();
  });

  it.each(['target_session_attrs=any', 'passfile=/tmp/p', 'service=prod', 'krbsrvname=x'])(
    'refuses %s, because the allowlist is the policy',
    (query) => {
      expect(() =>
        loadDatabaseConfig({
          ...URLS,
          UJIRA_DB_APP_URL: `postgresql://app:s@pooler.example:6543/postgres?${query}`,
        }),
      ).toThrow(DatabaseConfigError);
    },
  );
});
