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
npm run dev          # http://localhost:5173/app/, forwards /api and /m/ to UJIRA_API_URL (default http://127.0.0.1:8080)
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

- `src/lib`: the API client and its schemas, the `/v1` sign in client and its fake, amount maths,
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
