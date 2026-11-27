// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// French. Written to the same house style as en.ts: plain words, the
// recipient addressed as "vous", sentence case. Awaiting native speaker
// review before release.
//
// Not reviewed by a native speaker yet, so the widget does not offer it.
// Where the English changed when the widget moved to the wallet method
// only, the string is null again, with the new English above it.

import type { Draft } from '../catalogue.js';

export const fr: Draft = {
  'widget.label': 'Préparez-vous à être payé',
  'widget.progress': 'Étape {step} sur {total}',
  'widget.back': 'Retour',
  'widget.back.name': 'Retour à {step}',
  // Saving your address
  'widget.busy': null,
  'widget.loading': 'Préparation en cours',
  'widget.loadFailed': 'Connexion impossible. Vérifiez votre connexion internet, puis réessayez.',
  'widget.retry': 'Réessayer',
  'widget.saveFailed': "Nous n'avons pas pu enregistrer. Réessayez dans un instant.",
  'widget.expired':
    'Ce lien de configuration a expiré. Demandez-en un nouveau aux personnes qui vous paient.',
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
  'destination.wallet.action': 'Enregistrer mon adresse',
  'destination.wallet.missing': "Collez l'adresse de votre portefeuille.",
  'destination.wallet.invalid':
    "Cette adresse n'est pas correcte. Copiez-la à nouveau depuis votre portefeuille.",
  'destination.wallet.unpayable':
    "Les paiements ne peuvent pas être envoyés à cette adresse. Utilisez l'adresse de votre propre portefeuille.",
  'destination.refused':
    "Cette adresse ne peut pas recevoir de paiements. Vérifiez l'adresse et le mémo, ou utilisez un autre portefeuille.",
  'destination.memo.label': 'Mémo, seulement si on vous en a donné un',
  'destination.memo.hint':
    'Laissez vide pour votre propre portefeuille. Certaines plateformes d’échange donnent un numéro à ajouter à leur adresse.',
  'destination.memo.unsupported':
    'Les paiements ne peuvent pas porter un mémo avec des lettres ou des symboles. Utilisez votre propre portefeuille, ou une adresse sans mémo ou avec un mémo uniquement en chiffres.',
  'destination.memo.notNeeded':
    'Cette adresse ne peut pas recevoir de mémo séparé. Laissez le mémo vide.',
  'destination.memo.tooLong':
    'Ce numéro de mémo est trop long. Vérifiez-le et saisissez-le à nouveau.',
  'prove.heading': 'Confirmez que ce portefeuille est le vôtre',
  'prove.hint':
    "Votre portefeuille signe un court message. Cela ne déplace pas d'argent et ne coûte rien.",
  // Wallet address
  'prove.address': null,
  'prove.action': 'Signer avec mon portefeuille',
  // Sign with Freighter
  'prove.freighter.action': null,
  // Sign with Albedo
  'prove.albedo.action': null,
  // Albedo signed with a different account. Choose the account you saved, then try again.
  'prove.albedo.otherAccount': null,
  // Albedo did not send back a signature we can use. Try again.
  'prove.albedo.unusable': null,
  'prove.busy': 'En attente de votre portefeuille',
  // In your wallet app, choose to sign a message and paste in the text below. Then paste the signature it shows you.
  'prove.manual.hint': null,
  'prove.message.label': 'Message à signer',
  'prove.copy': 'Copier',
  'prove.copy.name': 'Copier le message à signer',
  'prove.copied': 'Copié',
  'prove.signature.label': 'Signature de votre portefeuille',
  'prove.signature.hint': 'Collez-la exactement comme votre portefeuille l’affiche.',
  'prove.signature.missing': 'Collez la signature que votre portefeuille vous a donnée.',
  'prove.manual.action': 'Confirmer mon portefeuille',
  'prove.declined': "Votre portefeuille n'a pas signé. Réessayez quand vous êtes prêt.",
  'prove.invalid':
    'Cette signature ne correspond pas à cette adresse. Signez à nouveau le message avec le portefeuille de cette adresse.',
  'prove.expired': "Le message a expiré avant d'être signé. Signez ce nouveau message.",
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
  'done.heading': 'Tout est prêt.',
  // Payouts reach you as USDC to your Stellar wallet. Every payout comes with a receipt you can keep.
  'done.body': null,
  'footer.byline': 'Payouts by UJIRA',
};
