# UJIRA Console

The web app the HTTP server serves at `/`. Anyone with a Stellar testnet wallet (Freighter, or
Albedo with nothing to install) can set up their wallet, create a mandate with their own rules,
act as the agent, approve payouts and read the receipts, without a terminal.

The console never holds a key. The server builds each transaction, the wallet signs it, and the
server submits it. Amounts travel as strings of integer minor units (USDC has 7 decimals) and are
converted with string arithmetic, never floats.

## Run it

```sh
npm ci
npm run dev          # http://localhost:5173, forwards /api and /m/ to UJIRA_API_URL (default http://127.0.0.1:8080)
npm run build        # writes dist/, which the server serves
```

From the repository root, `npm run build:console` does the install and the build in one step, and
the Docker image builds the console in its own stage and ships only `console/dist`.

Open any page with `?mock=1` to use an in-memory stand in for the API and a demo wallet: every
screen works without a server, a wallet or test money. Nothing in mock mode touches a network.

## Checks

```sh
npm run typecheck
npm run lint         # zero warnings
npm run format:check
npm test
npm run licenses     # fails on any package license outside the allowlist; --write refreshes THIRD_PARTY_NOTICES.md
```

## Layout

- `src/lib`: the API client and its schemas, amount maths, address checks, wallets, the mock API.
- `src/screens`: the start page with setup, the create mandate form, the mandate page.
- `src/components`: signing steps, the agent panel, approvals, receipts and shared pieces.
- `src/brand`: colour tokens and marks from the UJIRA brand kit. Colours reach the CSS only through
  the tokens.
