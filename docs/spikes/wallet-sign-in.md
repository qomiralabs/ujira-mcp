# Spike: can Freighter and Albedo sign the sign in message?

- Issue: #45. Date: 2026-11-26.
- Question: do the two wallets the console supports sign the message from `src/auth/wallet-message.ts` with SEP-53, in a form `verifyWalletMessage` accepts?
- Answer: yes, both. Measured in a browser with each wallet's current release. They return the signature in different fields and encodings, and Albedo also returns an older signature that is not SEP-53 and must not be used.

## Results

| Wallet                                                                                                                                  | Call                                                                           | What comes back                                                                                                                                                                                                        | Verified                                      | Kind     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------- |
| Freighter extension 5.53.1 (the GitHub release build; its screens now say "Varial"), client `@stellar/freighter-api` 6.0.1, on Test Net | `signMessage(text, { address })`, also with `networkPassphrase` set to Testnet | `{ signedMessage, signerAddress }`. `signedMessage` is the SEP-53 signature as base64, 88 characters (64 bytes). `signerAddress` is the address that signed. Failures come back in `error`, not as a thrown exception. | yes                                           | measured |
| Albedo at albedo.link (footer: v1.3.0), client `@albedo-link/intent` 0.13.0                                                             | `albedo.signMessage({ message: text })`                                        | `signedMessage`: the SEP-53 signature as hex, 128 characters. `signerAddress` and `pubkey`: the signer. `message_signature`: Albedo's older signature over sha256 of `<pubkey>:<message>`, also 128 hex characters.    | yes, `signedMessage` only                     | measured |
| Albedo, `message_signature`                                                                                                             | same call                                                                      | not SEP-53                                                                                                                                                                                                             | refused with `SIGNATURE_INVALID`, as intended | measured |

`walletSignatureToBase64` takes either encoding, so the console sends the field as the wallet returned it.

## How it was measured

- Headless Chromium 153 driven by Playwright 1.63. A page on `http://localhost:8753` loaded the two client bundles exactly as published on npm, at the versions `console/package-lock.json` pins.
- The message was built by `createWalletMessage` for origin `http://localhost:8753` and the wallet's address, and the result was checked by `verifyWalletMessage` with a SEP-53 verifier from `@stellar/stellar-sdk` 17.2.1 (`Keypair.verifyMessage`) in place of the chain adapter.
- Freighter: the release build loaded unpacked, a new wallet created in it, the network switched to Test Net, access granted, then the sign message window confirmed.
- Albedo: the live site in a popup, using "Provide secret key directly" with a keypair made for the run.
- Keys were made for the run, never funded and never printed. A SEP-53 signature is checked off chain, so nothing touched the network.

## What the console (#46) needs to do

- Freighter: call `signMessage(text, { address })` with the connected address. Treat `error` as a refusal, require `signerAddress` to equal the connected address, then send `signedMessage`. Keep `@stellar/freighter-api` at 5.0.0 or later (see below).
- Albedo: call `signMessage({ message: text, pubkey: address })`, so Albedo asks for the connected account (`pubkey` is a documented parameter; the measured run left it out), and send `signedMessage`. Its TypeScript types do not declare `signedMessage`, so read it with a runtime check. Never send `message_signature`.
- Send the message text exactly as the server issued it. Both wallets sign the exact bytes, including the line breaks.

## Behaviour worth knowing

- If the app passes `networkPassphrase` and the wallet is on another network, Freighter shows "Signing this message is not possible" and the call does not resolve until the person closes it (measured with Main Net set in the wallet and Testnet requested). The message has no network in it, so sign in can leave `networkPassphrase` out.
- On Main Net, Freighter refuses sites without TLS ("WEBSITE CONNECTION IS NOT SECURE") unless the person changes a setting (measured with `http://localhost`). On Test Net, `http://localhost` worked. ujira.co is served over https.
- Both wallets show the requesting site from the browser, not from the message: Freighter showed `localhost`, Albedo `localhost:8753`. Both show the message with its line breaks collapsed; Freighter also shows the "Stellar Signed Message:" prefix. The text stays readable because every field has a label.
- Freighter extension builds before 2026-05-26 applied SEP-53 only when the client library was 5.0.0 or later; older clients got a signature over the bare message, which `verifyWalletMessage` refuses (source: stellar/freighter #2815; a test covers the refusal). The console pins 6.0.1.
- Albedo signs messages only with accounts it holds the key for (stored accounts, a key typed in, an implicit session). For hardware accounts its source throws "Unsupported account type", so a Ledger or Trezor user cannot sign in through Albedo. Source, not measured.
- Freighter's source signs messages with hardware wallets in its popup. Not measured.

## Not measured

- A person signing in on ujira.co with their own installed Freighter and their own Albedo account. Worth a two minute check when the sign in routes (#55) and screens (#46) are live.
- Hardware wallets in either wallet.
