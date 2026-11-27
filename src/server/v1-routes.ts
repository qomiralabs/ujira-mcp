// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The /v1 routes that need a database: sign in, principals and projects, API
// keys, payouts and recipients, all on one database and one chain adapter,
// behind one authenticate. Kept apart from the web role so a test can build exactly what
// the server mounts, on a test database and a fake chain.
//
// Every new project gets its agent key here, and recipients seal a person's
// email, both under the key encryption key. A project without a key could
// not drive a mandate, so the key is required: the web role refuses to start
// without one rather than serving half of /v1.

import { createAuthenticate } from '../api/authenticate.js';
import { databaseIdempotencyStore } from '../api/idempotency-store.js';
import type { Route } from '../api/route.js';
import { apiKeyRoutes } from '../api/routes/api-keys.js';
import { authRoutes } from '../api/routes/auth.js';
import { payoutRoutes } from '../api/routes/payouts.js';
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
import type { AgentAccounts } from '../chain/agent-accounts.js';
import { payoutJobQueue, type Database } from '../db/index.js';
import { createAgentKeyService, type AgentKeyService } from '../keys/agent-keys.js';
import { postgresAgentKeyStore } from '../keys/postgres-store.js';
import type { Sealer } from '../keys/sealer.js';
import { createPayoutService } from '../payouts/payout-service.js';
import { databasePayoutStore } from '../payouts/payout-store.js';
import { createRecipientService } from '../payouts/recipients.js';
import { postgresTenancyStore } from '../tenancy/postgres-store.js';
import { Tenancy } from '../tenancy/tenancy.js';

/** What a recipient's wallet must be able to take: testnet USDC, as CODE:ISSUER. */
export const RECIPIENT_DESTINATION_ASSET =
  'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export interface V1RoutesOptions {
  readonly db: Database;
  /** Checks sign in signatures, parses addresses and answers recipient checks. */
  readonly adapter: ChainAdapter & WalletProofVerifier;
  /** The app origin, such as https://ujira.co. */
  readonly origin: string;
  readonly network: 'testnet' | 'pubnet';
  readonly log: (line: string) => void;
  /** Seals agent secrets and recipient emails under the key encryption key. */
  readonly sealer: Sealer;
  /** Makes and funds each project's agent key. */
  readonly agentAccounts: AgentAccounts;
}

export interface V1Routes {
  readonly routes: Route[];
  readonly agentKeys: AgentKeyService;
}

export function v1Routes(o: V1RoutesOptions): V1Routes {
  const { db, log } = o;
  const signIn = new SignIn({
    store: postgresSignInStore(db),
    verifier: o.adapter,
    origin: o.origin,
    log,
  });
  const agentKeys = createAgentKeyService({
    store: postgresAgentKeyStore(db, { accounts: o.adapter }),
    sealer: o.sealer,
    accounts: o.agentAccounts,
    log,
  });
  const tenancy = new Tenancy({
    store: postgresTenancyStore(db),
    log,
    onProjectCreated: async (context, requestId) => {
      await agentKeys.provision(context, requestId);
    },
  });
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
    // A payout is written with its first job, which the worker role runs.
    ...payoutRoutes({
      service: createPayoutService({
        store: databasePayoutStore(db, payoutJobQueue),
        chain: o.adapter,
        destinationAsset: () => RECIPIENT_DESTINATION_ASSET,
        log,
      }),
      authenticate,
      idempotency: { store: databaseIdempotencyStore(db), log },
    }),
  ];

  const service = createRecipientService({
    db,
    chain: o.adapter,
    sealer: o.sealer,
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
  return { routes, agentKeys };
}
