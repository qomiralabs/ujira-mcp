// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// English copy for the onboarding widget. Every string a person reads lives
// here, and nowhere else. The drafts in drafts/ carry the same keys.
//
// House style: sentence case, plain words, no filler. A label says what the
// control does. Where a person chooses between things we named, every choice
// carries one short line saying what it is.
//
// The only place the currency or the network is named is the payout method
// itself, "USDC to your Stellar wallet". A test holds that line.

export const en = {
  'widget.label': 'Get set up to be paid',
  'widget.progress': 'Step {step} of {total}',
  'widget.back': 'Back',
  'widget.back.name': 'Back to {step}',
  'widget.busy': 'Saving your address',
  'widget.loading': 'Getting things ready',
  'widget.loadFailed': 'We could not connect. Check your internet connection, then try again.',
  'widget.retry': 'Try again',
  'widget.saveFailed': 'We could not save that. Try again in a moment.',
  'widget.expired': 'This setup link has expired. Ask the people paying you for a new one.',
  'widget.notReady': 'This setup link is not complete. Ask the people paying you for a new one.',
  'widget.closed': 'Wallet payouts are not open for you yet. Ask the people paying you.',

  'step.wallet.short': 'your wallet',
  'step.address.short': 'your address',

  'wallet.heading': 'Which wallet do you use?',
  'wallet.hint': 'Payouts arrive as USDC to your Stellar wallet.',
  'wallet.freighter.name': 'Freighter',
  'wallet.freighter.line': 'The browser extension. Connect it with one press.',
  'wallet.albedo.name': 'Albedo',
  'wallet.albedo.line': 'Works in a browser window, with nothing to install.',
  'wallet.other.name': 'Another wallet',
  'wallet.other.line': 'Paste your address, then sign a short message in your wallet app.',
  'wallet.action': 'Continue',
  'wallet.missing': 'Choose the wallet you use.',

  'connect.heading': 'Connect Freighter',
  'connect.hint': 'Freighter shares your wallet address with this page. It cannot move any money.',
  'connect.action': 'Connect Freighter',
  'connect.busy': 'Waiting for Freighter',
  'connect.missing':
    'Freighter is not installed in this browser. Install it, or go back and choose another wallet.',
  'connect.declined':
    'Freighter did not share an address. Open Freighter, unlock it, then try again.',

  'connect.albedo.heading': 'Connect Albedo',
  'connect.albedo.hint':
    'Albedo opens in a new window and shares your wallet address with this page. It cannot move any money.',
  'connect.albedo.action': 'Connect Albedo',
  'connect.albedo.busy': 'Waiting for Albedo',
  'connect.albedo.declined':
    'Albedo did not share an address. Let its window open, choose your account, then try again.',

  'destination.wallet.heading': 'Where should your payouts arrive?',
  'destination.wallet.label': 'Your wallet address',
  'destination.wallet.hint':
    'Copy it from your wallet app. It starts with G and has 56 characters.',
  'destination.wallet.action': 'Save my address',
  'destination.wallet.missing': 'Paste the address from your wallet.',
  'destination.wallet.invalid': 'That address is not right. Copy it from your wallet again.',
  'destination.wallet.unpayable':
    'Payouts cannot be sent to this address. Use the address of your own wallet.',
  'destination.refused':
    'This address cannot receive payouts. Check the address and memo, or use another wallet.',
  'destination.memo.label': 'Memo, only if you were given one',
  'destination.memo.hint':
    'Leave this empty for your own wallet. Some exchanges give a number to add to their address.',
  'destination.memo.unsupported':
    'Payouts cannot carry a memo with letters or symbols. Use your own wallet, or an address that needs no memo or only a number.',
  'destination.memo.notNeeded': 'This address cannot take a separate memo. Leave the memo empty.',
  'destination.memo.tooLong': 'That memo number is too long. Check it and type it again.',

  'prove.heading': 'Confirm this wallet is yours',
  'prove.hint': 'Your wallet signs a short message. It moves no money and costs nothing.',
  'prove.address': 'Wallet address',
  'prove.action': 'Sign with my wallet',
  'prove.freighter.action': 'Sign with Freighter',
  'prove.albedo.action': 'Sign with Albedo',
  'prove.albedo.otherAccount':
    'Albedo signed with a different account. Choose the account you saved, then try again.',
  'prove.albedo.unusable': 'Albedo did not send back a signature we can use. Try again.',
  'prove.busy': 'Waiting for your wallet',
  'prove.manual.hint':
    'In your wallet app, choose to sign a message and paste in the text below. Then paste the signature it shows you.',
  'prove.message.label': 'Message to sign',
  'prove.copy': 'Copy',
  'prove.copy.name': 'Copy the message to sign',
  'prove.copied': 'Copied',
  'prove.signature.label': 'Signature from your wallet',
  'prove.signature.hint': 'Paste it exactly as your wallet shows it.',
  'prove.signature.missing': 'Paste the signature your wallet gave you.',
  'prove.manual.action': 'Confirm my wallet',
  'prove.declined': 'Your wallet did not sign. Try again when you are ready.',
  'prove.invalid':
    'That signature does not match this address. Sign the message again with the wallet for this address.',
  'prove.expired': 'The message expired before it was signed. Sign this new one.',

  'receive.accountNotFound':
    'This wallet is not active yet. Most wallet apps activate it with your first deposit. Activate it, then try again.',
  'receive.noTrustline':
    'Your wallet is not ready for this payout yet. In your wallet app, add the currency you are paid in, then try again.',
  'receive.notAuthorized':
    'Your wallet provider has not turned on this currency for you yet. Ask them, then try again.',
  'receive.limit':
    'Your wallet has a limit on this currency that is too low. Raise it in your wallet app.',
  'receive.signerNotAuthorized':
    'This key cannot sign for this wallet any more. Sign with a key that is a current signer of the wallet.',

  'done.heading': 'You are set up.',
  'done.body':
    'Payouts reach you as USDC to your Stellar wallet. Every payout comes with a receipt you can keep.',

  'footer.byline': 'Payouts by UJIRA',
} as const;
