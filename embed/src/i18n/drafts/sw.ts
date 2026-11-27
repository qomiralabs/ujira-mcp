// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Swahili, standard East African usage, the recipient addressed directly.
// Same house style as en.ts. Awaiting native speaker review before release.
//
// Not reviewed by a native speaker yet, so the widget does not offer it.
// Where the English changed when the widget moved to the wallet method
// only, the string is null again, with the new English above it.

import type { Draft } from '../catalogue.js';

export const sw: Draft = {
  'widget.label': 'Jiandae kulipwa',
  'widget.progress': 'Hatua {step} kati ya {total}',
  'widget.back': 'Rudi',
  'widget.back.name': 'Rudi kwenye {step}',
  // Saving your address
  'widget.busy': null,
  'widget.loading': 'Tunaandaa kila kitu',
  'widget.loadFailed':
    'Hatukuweza kuunganisha. Angalia muunganisho wako wa intaneti, kisha ujaribu tena.',
  'widget.retry': 'Jaribu tena',
  'widget.saveFailed': 'Hatukuweza kuhifadhi hilo. Jaribu tena baada ya muda mfupi.',
  'widget.expired':
    'Kiungo hiki cha usajili kimeisha muda wake. Omba kipya kutoka kwa wanaokulipa.',
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
  'destination.wallet.action': 'Hifadhi anwani yangu',
  'destination.wallet.missing': 'Bandika anwani kutoka kwenye pochi yako.',
  'destination.wallet.invalid': 'Anwani hiyo si sahihi. Inakili tena kutoka kwenye pochi yako.',
  'destination.wallet.unpayable':
    'Malipo hayawezi kutumwa kwenye anwani hii. Tumia anwani ya pochi yako mwenyewe.',
  'destination.refused':
    'Anwani hii haiwezi kupokea malipo. Angalia anwani na memo, au tumia pochi nyingine.',
  'destination.memo.label': 'Memo, ikiwa tu ulipewa',
  'destination.memo.hint':
    'Iache wazi kwa pochi yako mwenyewe. Baadhi ya masoko ya kubadilishia fedha hutoa namba ya kuongeza kwenye anwani yao.',
  'destination.memo.unsupported':
    'Malipo hayawezi kubeba memo yenye herufi au alama. Tumia pochi yako mwenyewe, au anwani isiyohitaji memo au inayohitaji namba tu.',
  'destination.memo.notNeeded': 'Anwani hii haikubali memo tofauti. Iache memo wazi.',
  'destination.memo.tooLong': 'Namba hiyo ya memo ni ndefu mno. Iangalie na uiandike tena.',
  'prove.heading': 'Thibitisha kwamba pochi hii ni yako',
  'prove.hint': 'Pochi yako inatia sahihi ujumbe mfupi. Haihamishi pesa na haigharimu chochote.',
  // Wallet address
  'prove.address': null,
  'prove.action': 'Tia sahihi kwa pochi yangu',
  // Sign with Freighter
  'prove.freighter.action': null,
  // Sign with Albedo
  'prove.albedo.action': null,
  // Albedo signed with a different account. Choose the account you saved, then try again.
  'prove.albedo.otherAccount': null,
  // Albedo did not send back a signature we can use. Try again.
  'prove.albedo.unusable': null,
  'prove.busy': 'Tunasubiri pochi yako',
  // In your wallet app, choose to sign a message and paste in the text below. Then paste the signature it shows you.
  'prove.manual.hint': null,
  'prove.message.label': 'Ujumbe wa kutia sahihi',
  'prove.copy': 'Nakili',
  'prove.copy.name': 'Nakili ujumbe wa kutia sahihi',
  'prove.copied': 'Imenakiliwa',
  'prove.signature.label': 'Sahihi kutoka kwenye pochi yako',
  'prove.signature.hint': 'Ibandike kama pochi yako inavyoionyesha.',
  'prove.signature.missing': 'Bandika sahihi ambayo pochi yako ilikupa.',
  'prove.manual.action': 'Thibitisha pochi yangu',
  'prove.declined': 'Pochi yako haikutia sahihi. Jaribu tena ukiwa tayari.',
  'prove.invalid':
    'Sahihi hiyo hailingani na anwani hii. Tia sahihi ujumbe tena kwa pochi ya anwani hii.',
  'prove.expired': 'Ujumbe uliisha muda wake kabla ya kutiwa sahihi. Tia sahihi huu mpya.',
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
  'done.heading': 'Uko tayari.',
  // Payouts reach you as USDC to your Stellar wallet. Every payout comes with a receipt you can keep.
  'done.body': null,
  'footer.byline': 'Payouts by UJIRA',
};
