// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The /v1 routes that need a database: sign in, principals and projects, API
// keys and recipients, all on one database and one chain adapter, behind one
// authenticate. Kept apart from the web role so a test can build exactly what
// the server mounts, on a test database and a fake chain.
//
// Recipients seal a person's email under the key encryption key. Without a
// usable key they are not served at all, rather than taking an email they
// could not protect; everything else still is, and the log says why. The key
// itself is never logged.

import { createAuthenticate } from '../api/authenticate.js';
import type { Route } from '../api/route.js';
import { apiKeyRoutes } from '../api/routes/api-keys.js';
import { authRoutes } from '../api/routes/auth.js';
import { recipientRoutes } from '../api/routes/recipients.js';
import { tenancyRoutes } from '../api/routes/tenancy.js';
import { createApiKeyService } from '../auth/api-key-service.js';
import { databaseApiKeyRecords, databaseTokenStore } from '../auth/api-key-store.js';
import { postgresSignInStore } from '../auth/postgres-store.js';
import { SignIn } from '../auth/sign-in.js';
import { createTokenAuthenticator } from '../auth/token-auth.js';
import { tokenEnvironmentFor } from '../auth/token.js';
import type { WalletProofVerifier } from '../auth/wallet-message.js';
import type { ChainAdapter } from '../chain/adapter.js';
import type { Database } from '../db/index.js';
import { createSealer, SealError, type Sealer } from '../keys/sealer.js';
import { createRecipientService } from '../payouts/recipients.js';
import { postgresTenancyStore } from '../tenancy/postgres-store.js';
import { Tenancy } from '../tenancy/tenancy.js';

type Env = Readonly<Record<string, string | undefined>>;

/** What a recipient's wallet must be able to take: testnet USDC, as CODE:ISSUER. */
export const RECIPIENT_DESTINATION_ASSET =
  'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export const KEY_ENCRYPTION_KEY_VAR = 'UJIRA_KEY_ENCRYPTION_KEY';

export interface V1RoutesOptions {
  readonly db: Database;
  /** Checks sign in signatures, parses addresses and answers recipient checks. */
  readonly adapter: ChainAdapter & WalletProofVerifier;
  /** The app origin, such as https://ujira.co. */
  readonly origin: string;
  readonly network: 'testnet' | 'pubnet';
  readonly env: Env;
  readonly log: (line: string) => void;
}

export interface V1Routes {
  readonly routes: Route[];
  readonly recipients: 'on' | 'off';
}

/** The sealer for personal data, or undefined, with the reason logged, when the key is missing or unusable. */
export function sealerFromEnv(env: Env, log: (line: string) => void): Sealer | undefined {
  const raw = env[KEY_ENCRYPTION_KEY_VAR]?.trim();
  if (raw === undefined || raw === '') {
    log('event=recipients_off level=warn reason=key_encryption_key_missing');
    return undefined;
  }
  try {
    return createSealer(raw);
  } catch (error) {
    if (!(error instanceof SealError)) throw error;
    // A typo in one secret should not take the whole site down with it.
    log('event=recipients_off level=warn reason=key_encryption_key_invalid');
    return undefined;
  }
}

export function v1Routes(o: V1RoutesOptions): V1Routes {
  const { db, log } = o;
  const signIn = new SignIn({
    store: postgresSignInStore(db),
    verifier: o.adapter,
    origin: o.origin,
    log,
  });
  const tenancy = new Tenancy({ store: postgresTenancyStore(db), log });
  const session = { signIn, origin: o.origin };
  const environment = tokenEnvironmentFor(o.network);
  const tokens = createTokenAuthenticator({ store: databaseTokenStore(db), environment, log });
  const keys = createApiKeyService({
    records: databaseApiKeyRecords(db),
    environment,
    onRevoked: (prefix) => {
      tokens.forget(prefix);
    },
  });
  const authenticate = createAuthenticate({ tokens, session });
  const routes: Route[] = [
    ...authRoutes(session),
    ...tenancyRoutes({ signIn, tenancy, origin: o.origin }),
    ...apiKeyRoutes({ keys, authenticate }),
  ];

  const sealer = sealerFromEnv(o.env, log);
  if (sealer === undefined) return { routes, recipients: 'off' };
  const service = createRecipientService({
    db,
    chain: o.adapter,
    sealer,
    destinationAsset: () => RECIPIENT_DESTINATION_ASSET,
    log,
  });
  // The routes say whether they write as well, but authenticate reads that
  // from the method, so the scope is all it needs. Only the tenant goes on:
  // the service has no use for the session or the key behind it.
  routes.push(
    ...recipientRoutes({
      service,
      authenticate: async (c, access) => {
        const caller = await authenticate({ scope: access.scope })(c);
        return { principalId: caller.principalId, projectId: caller.projectId };
      },
    }),
  );
  return { routes, recipients: 'on' };
}
