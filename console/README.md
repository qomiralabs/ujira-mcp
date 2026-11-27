# UJIRA dashboard

The web app the HTTP server serves at `/app` (the marketing site owns `/`). Anyone with a Stellar testnet wallet (Freighter, or
Albedo with nothing to install) can set up their wallet, create a mandate with their own rules,
act as the agent, approve payouts and read the receipts, without a terminal.

The console never holds a key. The server builds each transaction, the wallet signs it, and the
server submits it. Amounts travel as strings of integer minor units (USDC has 7 decimals) and are
converted with string arithmetic, never floats.

## Run it

```sh
npm ci
npm run dev          # http://localhost:5173/app/, forwards /api, /v1 and /m/ to UJIRA_API_URL (default http://127.0.0.1:8080)
npm run build        # writes dist/, which the server serves
```

From the repository root, `npm run build:console` does the install and the build in one step, and
the Docker image builds the console in its own stage and ships only `console/dist`.

Pages have plain paths under `/app`: `/app` (overview), `/app/mandates`, `/app/mandates/new`,
`/app/mandates/<id>`, `/app/payouts`, `/app/approvals`, `/app/receipts`, `/app/recipients` and
`/app/developers`, plus pages for what is still being built. The server answers every GET under
`/app` that is not a file with `index.html`. Old hash links (`#/m/<id>`, `#/new`) are rewritten to
their paths on load.

Open any page with `?mock=1` to use an in-memory stand in for the API and a demo wallet: every
screen works without a server, a wallet or test money. Nothing in mock mode touches a network.

## Sign in

Principals sign in with their Stellar wallet (Freighter or Albedo). The console asks
`POST /v1/auth/challenge` for a one time message, the wallet signs it, and `POST /v1/auth/session`
trades the signature for an HttpOnly session cookie. The signature goes straight to the server; the
console keeps no signature, message or session in browser storage. On the first sign in the
console asks for an organisation name (`POST /v1/principals`, which also creates the first
project). Signed in, the header shows the organisation and the open project, with a switcher for
the others, a new project and sign out (`DELETE /v1/auth/session`). The open project is sent in the
`Ujira-Project` header, and its ID is kept on the device so the next sign in opens it again.

Signed out, every page shows the sign in screen and keeps its URL, so a link opens the page asked
for after sign in. Sign out forgets the wallet and every loaded page.

In mock mode sign in always runs, against a typed fake of the `/v1` routes (`src/lib/fakeAuth.ts`)
that keeps the same rules: single use challenges that lapse after 10 minutes, the signature from
the address that asked, a session for everything else. On a live server sign in stays off until
`/api/config` sends `"signIn": true`, which the server does once it serves the `/v1` routes.

## Moving to /v1

`src/lib/v1.ts` is the typed client for the public API under `/v1`. Sign in (`src/lib/auth.ts`)
and every data route share one transport: same origin, so the browser sends the session cookie;
the open project in the `Ujira-Project` header; and one error envelope,
`{ "error": { "code", "message", "requestId" } }`. Every answer is checked against its schema in
`src/lib/v1Schemas.ts`. An answer in the wrong shape shows the error state with the request id,
never the data. Amounts arrive as strings of minor units and become `bigint` at the edge, and
`formatToken` in `src/lib/money.ts` is the one formatter for them. A 401 from any route sends the
person to sign in; a 429 says how long to wait, from `Retry-After`.

Screens move from `/api` to `/v1` one at a time, behind a build flag. `VITE_V1_SCREENS` names the
ones that have moved, as a comma list (`payouts,receipts`) or `all`; a screen calls
`useV1('payouts')` and gets the client only when the flag names it and someone is signed in,
otherwise `null`, which means stay on `/api`. With the flag unset every screen reads `/api`, as
ujira.co does today.

```sh
VITE_V1_SCREENS=payouts,receipts npx vite build
```

Mock mode serves the same routes from `src/lib/fakeV1.ts`, which runs the fake sign in's tenant
check on every call and keeps the server's money rules: idempotency keys replay or refuse, a task
pays once per mandate, a refused payout is a `blocked` record with the rule's name. The tests replay
answers recorded from each route in `src/test/v1Recorded.ts`. In mock mode only, `?v1=mandates`
in the address adds screens to the flag for that page load, so the browser flows walk both paths
in one build.

On `/v1` the mandate screens (`mandates`) read `GET /v1/mandates` and `GET /v1/mandates/{id}`,
keyed by the open project. Create is two wallet signatures, `POST /v1/mandates/prepare` and a
`fund` action; pause, resume, revoke, adding recipients, funding and withdrawing are each a
`POST /v1/mandates/{id}/actions` signing request. Every signature goes through
`POST /v1/signing/submit`, and a step is done only once the mandate read back from the server shows
it; until then the page says what it waits for. Revoke asks for the mandate's name typed back.

The developers screen (`developers`) lists the project's keys from `GET /v1/api-keys`, makes one
with `POST /v1/api-keys` (a name, scopes, and an expiry of 1 to 730 days, 365 by default) and
revokes one with `DELETE /v1/api-keys/{id}` after a confirm. The whole key is in the create answer
only; the console holds it in the dialog that shows it, and nowhere else, so it is gone once that
dialog closes. Only owners and admins manage keys: everyone else sees a short line saying so, and a
403 from the server reads the same way. The screen also gives each mandate's MCP address,
`<origin>/m/<contract>/mcp`, with the steps to connect it.

## Checks

```sh
npm run typecheck
npm run lint         # zero warnings
npm run format:check
npm test
npm run licenses     # fails on any package license outside the allowlist; --write refreshes THIRD_PARTY_NOTICES.md
```

Browser flows run with Playwright against the built console in mock mode, at 375, 768 and 1440 wide
in light and dark, and write screenshots to `e2e/screenshots/`:

```sh
npx playwright install chromium   # once
npx vite build
npm run e2e
```

## Layout

- `src/lib`: the API client and its schemas, the `/v1` client, its sign in and their fakes, amount maths,
  address checks, wallets, the mock API.
- `src/app`: the app shell state, the session gate, routes under `/app`, and the portfolio (every mandate of the
  connected wallet with its payouts and receipts, shared by all pages).
- `src/screens`: the overview with setup, mandates, the create form, the mandate page, payouts,
  approvals, receipts, recipients, developers, and the pages for what is coming.
- `src/components`: the sidebar shell, signing steps, the agent panel, approvals, payout and
  receipt tables, and shared pieces.
- `src/brand/tokens.css`: the design tokens. Its first block is the landing page's own `:root`
  (`site/index.html`), kept identical by a test; colours, fonts, radii and shadows reach the CSS only
  through it. Urbanist and JetBrains Mono load from Google Fonts, as on the landing page.
