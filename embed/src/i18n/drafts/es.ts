// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Spanish, neutral rather than regional, the recipient addressed as "tú".
// Written to the same house style as en.ts. Awaiting native speaker review
// before release.
//
// Not reviewed by a native speaker yet, so the widget does not offer it.
// Where the English changed when the widget moved to the wallet method
// only, the string is null again, with the new English above it.

import type { Draft } from '../catalogue.js';

export const es: Draft = {
  'widget.label': 'Prepárate para recibir pagos',
  'widget.progress': 'Paso {step} de {total}',
  'widget.back': 'Atrás',
  'widget.back.name': 'Volver a {step}',
  // Saving your address
  'widget.busy': null,
  'widget.loading': 'Preparando todo',
  'widget.loadFailed': 'No pudimos conectar. Revisa tu conexión a internet y vuelve a intentarlo.',
  'widget.retry': 'Intentar de nuevo',
  'widget.saveFailed': 'No pudimos guardarlo. Vuelve a intentarlo en un momento.',
  'widget.expired': 'Este enlace de configuración ha caducado. Pide uno nuevo a quienes te pagan.',
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
  // Where should your payouts arrive?
  'destination.wallet.heading': null,
  // Your wallet address
  'destination.wallet.label': null,
  // Copy it from your wallet app. It starts with G and has 56 characters.
  'destination.wallet.hint': null,
  'destination.wallet.action': 'Guardar mi dirección',
  'destination.wallet.missing': 'Pega la dirección de tu billetera.',
  'destination.wallet.invalid': 'Esa dirección no es correcta. Cópiala de nuevo de tu billetera.',
  'destination.wallet.unpayable':
    'No se pueden enviar pagos a esta dirección. Usa la dirección de tu propia billetera.',
  'destination.refused':
    'Esta dirección no puede recibir pagos. Revisa la dirección y el memo, o usa otra billetera.',
  'destination.memo.label': 'Memo, solo si te dieron uno',
  'destination.memo.hint':
    'Déjalo vacío para tu propia billetera. Algunos exchanges dan un número para añadir a su dirección.',
  'destination.memo.unsupported':
    'Los pagos no pueden llevar un memo con letras o símbolos. Usa tu propia billetera, o una dirección que no necesite memo o solo uno numérico.',
  'destination.memo.notNeeded': 'Esta dirección no admite un memo aparte. Deja el memo vacío.',
  'destination.memo.tooLong':
    'Ese número de memo es demasiado largo. Revísalo y escríbelo de nuevo.',
  'prove.heading': 'Confirma que esta billetera es tuya',
  'prove.hint': 'Tu billetera firma un mensaje corto. No mueve dinero y no cuesta nada.',
  // Wallet address
  'prove.address': null,
  'prove.action': 'Firmar con mi billetera',
  // Sign with Freighter
  'prove.freighter.action': null,
  'prove.busy': 'Esperando a tu billetera',
  // In your wallet app, choose to sign a message and paste in the text below. Then paste the signature it shows you.
  'prove.manual.hint': null,
  'prove.message.label': 'Mensaje para firmar',
  'prove.copy': 'Copiar',
  'prove.copy.name': 'Copiar el mensaje para firmar',
  'prove.copied': 'Copiado',
  'prove.signature.label': 'Firma de tu billetera',
  'prove.signature.hint': 'Pégala tal como la muestra tu billetera.',
  'prove.signature.missing': 'Pega la firma que te dio tu billetera.',
  'prove.manual.action': 'Confirmar mi billetera',
  'prove.declined': 'Tu billetera no firmó. Inténtalo de nuevo cuando quieras.',
  'prove.invalid':
    'Esa firma no corresponde a esta dirección. Firma el mensaje de nuevo con la billetera de esta dirección.',
  'prove.expired': 'El mensaje caducó antes de firmarse. Firma este nuevo.',
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
  'done.heading': 'Ya está todo listo.',
  // Payouts reach you as USDC to your Stellar wallet. Every payout comes with a receipt you can keep.
  'done.body': null,
  'footer.byline': 'Payouts by UJIRA',
};
