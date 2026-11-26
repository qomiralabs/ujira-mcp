// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Portuguese, written to read naturally in Brazil, Mozambique and Angola:
// the recipient addressed as "você", no regional slang. Same house style as
// en.ts. Awaiting native speaker review before release, which should settle
// the European and African spellings.
//
// Not reviewed by a native speaker yet, so the widget does not offer it.
// Where the English changed when the widget moved to the wallet method
// only, the string is null again, with the new English above it.

import type { Draft } from '../catalogue.js';

export const pt: Draft = {
  'widget.label': 'Prepare-se para receber pagamentos',
  'widget.progress': 'Passo {step} de {total}',
  'widget.back': 'Voltar',
  'widget.back.name': 'Voltar para {step}',
  // Saving your address
  'widget.busy': null,
  'widget.loading': 'Preparando tudo',
  'widget.loadFailed':
    'Não conseguimos conectar. Verifique sua conexão com a internet e tente de novo.',
  'widget.retry': 'Tentar de novo',
  'widget.saveFailed': 'Não conseguimos salvar. Tente de novo em instantes.',
  'widget.expired': 'Este link de configuração expirou. Peça um novo a quem paga você.',
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
  'destination.wallet.action': 'Salvar meu endereço',
  'destination.wallet.missing': 'Cole o endereço da sua carteira.',
  'destination.wallet.invalid': 'Esse endereço não está certo. Copie de novo da sua carteira.',
  'destination.wallet.unpayable':
    'Não é possível enviar pagamentos para este endereço. Use o endereço da sua própria carteira.',
  'destination.refused':
    'Este endereço não pode receber pagamentos. Confira o endereço e o memo, ou use outra carteira.',
  'destination.memo.label': 'Memo, só se você recebeu um',
  'destination.memo.hint':
    'Deixe em branco para a sua própria carteira. Algumas corretoras dão um número para acrescentar ao endereço.',
  'destination.memo.unsupported':
    'Os pagamentos não podem levar um memo com letras ou símbolos. Use sua própria carteira, ou um endereço que não precise de memo ou só de um número.',
  'destination.memo.notNeeded': 'Este endereço não aceita um memo à parte. Deixe o memo em branco.',
  'destination.memo.tooLong': 'Esse número de memo é longo demais. Confira e digite de novo.',
  'prove.heading': 'Confirme que esta carteira é sua',
  'prove.hint': 'Sua carteira assina uma mensagem curta. Isso não move dinheiro e não custa nada.',
  // Wallet address
  'prove.address': null,
  'prove.action': 'Assinar com minha carteira',
  // Sign with Freighter
  'prove.freighter.action': null,
  'prove.busy': 'Aguardando sua carteira',
  // In your wallet app, choose to sign a message and paste in the text below. Then paste the signature it shows you.
  'prove.manual.hint': null,
  'prove.message.label': 'Mensagem para assinar',
  'prove.copy': 'Copiar',
  'prove.copy.name': 'Copiar a mensagem para assinar',
  'prove.copied': 'Copiado',
  'prove.signature.label': 'Assinatura da sua carteira',
  'prove.signature.hint': 'Cole exatamente como a sua carteira mostra.',
  'prove.signature.missing': 'Cole a assinatura que sua carteira deu.',
  'prove.manual.action': 'Confirmar minha carteira',
  'prove.declined': 'Sua carteira não assinou. Tente de novo quando estiver pronto.',
  'prove.invalid':
    'Essa assinatura não corresponde a este endereço. Assine a mensagem de novo com a carteira deste endereço.',
  'prove.expired': 'A mensagem expirou antes de ser assinada. Assine esta nova.',
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
  'done.heading': 'Está tudo pronto.',
  // Payouts reach you as USDC to your Stellar wallet. Every payout comes with a receipt you can keep.
  'done.body': null,
  'footer.byline': 'Payouts by UJIRA',
};
