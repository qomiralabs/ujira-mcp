// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Igbo. Waiting for a native speaker translator: every string is null,
// flagged rather than guessed, with the English above it for reference.
// Until the last one is filled in, a request for this language gets the
// whole widget in English. The footer byline is the brand line and stays
// as it is in every language.
//
// Not reviewed by a native speaker yet, so the widget does not offer it.
// Where the English changed when the widget moved to the wallet method
// only, the string is null again, with the new English above it.

import type { Draft } from '../catalogue.js';

export const ig: Draft = {
  // Get set up to be paid
  'widget.label': null,
  // Step {step} of {total}
  'widget.progress': null,
  // Back
  'widget.back': null,
  // Back to {step}
  'widget.back.name': null,
  // Saving your address
  'widget.busy': null,
  // Getting things ready
  'widget.loading': null,
  // We could not connect. Check your internet connection, then try again.
  'widget.loadFailed': null,
  // Try again
  'widget.retry': null,
  // We could not save that. Try again in a moment.
  'widget.saveFailed': null,
  // This setup link has expired. Ask the people paying you for a new one.
  'widget.expired': null,
  // This setup link is not complete. Ask the people paying you for a new one.
  'widget.notReady': null,
  // Wallet payouts are not open for you yet. Ask the people paying you.
  'widget.closed': null,
  // your wallet
  'step.wallet.short': null,
  // your address
  'step.address.short': null,
  // Which wallet do you use?
  'wallet.heading': null,
  // Payouts arrive as USDC to your Stellar wallet.
  'wallet.hint': null,
  // Freighter
  'wallet.freighter.name': null,
  // The browser extension. Connect it with one press.
  'wallet.freighter.line': null,
  // Albedo
  'wallet.albedo.name': null,
  // Works in a browser window, with nothing to install.
  'wallet.albedo.line': null,
  // Another wallet
  'wallet.other.name': null,
  // Paste your address, then sign a short message in your wallet app.
  'wallet.other.line': null,
  // Continue
  'wallet.action': null,
  // Choose the wallet you use.
  'wallet.missing': null,
  // Connect Freighter
  'connect.heading': null,
  // Freighter shares your wallet address with this page. It cannot move any money.
  'connect.hint': null,
  // Connect Freighter
  'connect.action': null,
  // Waiting for Freighter
  'connect.busy': null,
  // Freighter is not installed in this browser. Install it, or go back and choose another wallet.
  'connect.missing': null,
  // Freighter did not share an address. Open Freighter, unlock it, then try again.
  'connect.declined': null,
  // Connect Albedo
  'connect.albedo.heading': null,
  // Albedo opens in a new window and shares your wallet address with this page. It cannot move any money.
  'connect.albedo.hint': null,
  // Connect Albedo
  'connect.albedo.action': null,
  // Waiting for Albedo
  'connect.albedo.busy': null,
  // Albedo did not share an address. Let its window open, choose your account, then try again.
  'connect.albedo.declined': null,
  // Where should your payouts arrive?
  'destination.wallet.heading': null,
  // Your wallet address
  'destination.wallet.label': null,
  // Copy it from your wallet app. It starts with G and has 56 characters.
  'destination.wallet.hint': null,
  // Save my address
  'destination.wallet.action': null,
  // Paste the address from your wallet.
  'destination.wallet.missing': null,
  // That address is not right. Copy it from your wallet again.
  'destination.wallet.invalid': null,
  // Payouts cannot be sent to this address. Use the address of your own wallet.
  'destination.wallet.unpayable': null,
  // This address cannot receive payouts. Check the address and memo, or use another wallet.
  'destination.refused': null,
  // Memo, only if you were given one
  'destination.memo.label': null,
  // Leave this empty for your own wallet. Some exchanges give a number to add to their address.
  'destination.memo.hint': null,
  // Payouts cannot carry a memo with letters or symbols. Use your own wallet, or an address that needs no memo or only a number.
  'destination.memo.unsupported': null,
  // This address cannot take a separate memo. Leave the memo empty.
  'destination.memo.notNeeded': null,
  // That memo number is too long. Check it and type it again.
  'destination.memo.tooLong': null,
  // Confirm this wallet is yours
  'prove.heading': null,
  // Your wallet signs a short message. It moves no money and costs nothing.
  'prove.hint': null,
  // Wallet address
  'prove.address': null,
  // Sign with my wallet
  'prove.action': null,
  // Sign with Freighter
  'prove.freighter.action': null,
  // Sign with Albedo
  'prove.albedo.action': null,
  // Albedo signed with a different account. Choose the account you saved, then try again.
  'prove.albedo.otherAccount': null,
  // Albedo did not send back a signature we can use. Try again.
  'prove.albedo.unusable': null,
  // Waiting for your wallet
  'prove.busy': null,
  // In your wallet app, choose to sign a message and paste in the text below. Then paste the signature it shows you.
  'prove.manual.hint': null,
  // Message to sign
  'prove.message.label': null,
  // Copy
  'prove.copy': null,
  // Copy the message to sign
  'prove.copy.name': null,
  // Copied
  'prove.copied': null,
  // Signature from your wallet
  'prove.signature.label': null,
  // Paste it exactly as your wallet shows it.
  'prove.signature.hint': null,
  // Paste the signature your wallet gave you.
  'prove.signature.missing': null,
  // Confirm my wallet
  'prove.manual.action': null,
  // Your wallet did not sign. Try again when you are ready.
  'prove.declined': null,
  // That signature does not match this address. Sign the message again with the wallet for this address.
  'prove.invalid': null,
  // The message expired before it was signed. Sign this new one.
  'prove.expired': null,
  // This wallet is not active yet. Most wallet apps activate it with your first deposit. Activate it, then try again.
  'receive.accountNotFound': null,
  // Your wallet is not ready for this payout yet. In your wallet app, add the currency you are paid in, then try again.
  'receive.noTrustline': null,
  // Your wallet provider has not turned on this currency for you yet. Ask them, then try again.
  'receive.notAuthorized': null,
  // Your wallet has a limit on this currency that is too low. Raise it in your wallet app.
  'receive.limit': null,
  // This key cannot sign for this wallet any more. Sign with a key that is a current signer of the wallet.
  'receive.signerNotAuthorized': null,
  // You are set up.
  'done.heading': null,
  // Payouts reach you as USDC to your Stellar wallet. Every payout comes with a receipt you can keep.
  'done.body': null,
  'footer.byline': 'Payouts by UJIRA',
};
