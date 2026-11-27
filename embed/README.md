# UJIRA embed widget

The onboarding widget recipients use inside your own product. One script tag, one custom element, no framework needed on the page. It saves the recipient's Stellar wallet with UJIRA and has the wallet prove it belongs to them.

```html
<script type="module" src="https://ujira.co/embed/v1/ujira-embed.js"></script>

<ujira-onboarding token="ujes_test_..."></ujira-onboarding>
```

Mint the token on your server with `POST /v1/embed/sessions` and your project API key, for one recipient you have already added. It is short lived and reaches nothing but that recipient. Never put an API key in a page.

The widget talks to the server it was loaded from. Set `api-base` only when the API lives somewhere else.

## The flow

Three questions, one per step, then a confirmation:

1. **Which wallet.** Freighter, Albedo, or another wallet. Payouts arrive as USDC to your Stellar wallet either way.
2. **The address.** Freighter or Albedo shares it with one press. Any other wallet: the person pastes it, with a memo only when an exchange gave them a number. The address is checked the way UJIRA checks it (checksum, never the all zero key, never an address a payout would burn, a memo only as a number) before it is saved, and UJIRA checks it again.
3. **The proof.** The wallet signs a short message (SEP-53). It moves no money. Freighter or Albedo signs with one press (from Albedo the widget takes only `signedMessage`, never `message_signature`); for another wallet the person signs in their wallet app and pastes the signature, unless your page hands the widget a wallet that can sign (see `wallet` below).

Albedo needs nothing installed: it opens its own window. Its library loads as a second file, `ujira-embed-albedo-<hash>.js`, beside `ujira-embed.js`, and only once someone picks Albedo, because on load it watches every click on the page for `web+stellar` links. The build fails if that library ends up in the main file, if a file name is one the server would not serve, or if the files together pass 60 KB gzipped.

Then `ujira-onboarding-complete` fires and the widget says the person is set up.

Only the wallet method exists here. Local currency payouts are not part of this widget.

## Attributes and properties

| Name       | Type                      | Default           | What it does                                                                                    |
| ---------- | ------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `token`    | string                    | empty             | The embed token your server minted for this recipient. Without one the widget says so and stops |
| `api-base` | URL                       | the script origin | Where the UJIRA API is                                                                          |
| `mode`     | `light`, `dark`, `system` | `light`           | Which set of default colours to use                                                             |
| `locale`   | language tag              | empty             | English only at testnet; any other value gives English                                          |
| `wallet`   | object                    | none              | Property only. Your page's own wallet connection, so another wallet signs with one press        |
| `client`   | object                    | none              | Property only. A client to use in place of one built from the token, for tests                  |

`reset()` starts again from the first question. `currentStep` and `currentAnswers` read the state.

```js
document.querySelector('ujira-onboarding').wallet = {
  // SEP-53 message signing; resolve with the base64 signature.
  signMessage: async (message, address) => ({
    signature: await myWallet.signMessage(message, address),
  }),
};
```

## Events

| Event                       | Detail                                    | When                                             |
| --------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `ujira-step-change`         | `{ step, position, total }`               | The step on screen changed                       |
| `ujira-onboarding-complete` | `{ wallet, destination, memo, methodId }` | UJIRA saved the address and the wallet proved it |

Both bubble and cross the shadow boundary.

## What it calls

All under `/v1/embed/`, with `Authorization: Bearer <token>` and no cookies: `GET onboarding`, then `POST recipients/{id}/methods`, `POST recipients/{id}/methods/{methodId}/wallet-challenges` and `POST recipients/{id}/methods/{methodId}/wallet-proofs`. Every answer is checked against its schema before it is used. A refusal is read from the error envelope, `{ "error": { "code", "message", "reason", "requestId" } }`, where `reason` narrows `DESTINATION_INVALID` (`MEMO_UNSUPPORTED`) and `DESTINATION_NOT_RECEIVABLE` (`ACCOUNT_NOT_FOUND`, `NO_TRUSTLINE`, `TRUSTLINE_NOT_AUTHORIZED`, `TRUSTLINE_LIMIT`, `DESTINATION_IS_ISSUER`). A 401 means the token has expired.

## Theming

The widget matches the recipient card on the landing page by default. Every colour, radius, font and shadow is a custom property set on the element itself, so a rule on your page that targets the element always wins:

```css
ujira-onboarding {
  --ujira-embed-accent: #005ab4;
  --ujira-embed-on-accent: #ffffff;
  --ujira-embed-radius-card: 8px;
  --ujira-embed-font: 'Graphik', system-ui, sans-serif;
}
```

A value set on an ancestor does not reach the widget, except as the fallback of the five focus properties: when the value set on the element cannot be used, such as a `var()` naming a token you never defined, those take what an ancestor set, and the default when none did.

| Property                          | What it paints                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `--ujira-embed-surface`           | The card and the wallet choices                                                    |
| `--ujira-embed-field`             | Inputs, the saved address and the message to sign                                  |
| `--ujira-embed-rule`              | The card's edge and the line above the footer                                      |
| `--ujira-embed-field-border`      | The edge of an input or a choice, kept at 3:1 on the surface and the field         |
| `--ujira-embed-text`              | Headings, answers and the dot of the chosen radio                                  |
| `--ujira-embed-text-secondary`    | Hints, the progress line and the footer                                            |
| `--ujira-embed-accent`            | The fill of the one action on each step                                            |
| `--ujira-embed-accent-hover`      | That fill under the pointer                                                        |
| `--ujira-embed-on-accent`         | The label on the action                                                            |
| `--ujira-embed-link`              | Back and Copy                                                                      |
| `--ujira-embed-mark`              | The saffron marks: progress done, the chosen wallet's edge and the dot of the mark |
| `--ujira-embed-mark-track`        | Progress still to come                                                             |
| `--ujira-embed-error`             | A problem message and its border                                                   |
| `--ujira-embed-focus`             | The focus ring                                                                     |
| `--ujira-embed-focus-inner`       | The band behind the ring, so the ring reads on the action as well as on the card   |
| `--ujira-embed-focus-width`       | How thick the ring is. Never thinner than 2px                                      |
| `--ujira-embed-focus-offset`      | The gap between the control and the ring, held between 0 and 8px                   |
| `--ujira-embed-focus-inner-width` | How thick the band is. Never thinner than 1px                                      |
| `--ujira-embed-shadow`            | The card's shadow; none in dark mode                                               |
| `--ujira-embed-radius-card`       | The card                                                                           |
| `--ujira-embed-radius-control`    | Inputs and the action                                                              |
| `--ujira-embed-font`              | Everything except addresses and the message to sign                                |
| `--ujira-embed-font-mono`         | Addresses and the message to sign                                                  |
| `--ujira-embed-ease`              | The one easing curve                                                               |

A test fails if a property here paints nothing, or if one exists that this table does not list. The defaults are the dashboard's tokens (`console/src/brand/tokens.css`), and another test fails when they drift apart. The widget loads no font: it uses Urbanist and JetBrains Mono when your page has them, and the system faces otherwise.

`mode="dark"` switches to the dark set and `mode="system"` follows the reader's setting. Parts are exposed for what the properties do not cover: `widget`, `chrome`, `progress`.

The shadow root is open. It keeps our styles off your page and your selectors off our elements, but it hides nothing from your page: it can read what a recipient types. If you need the answers kept from your own page, load the widget in a cross origin iframe instead.

## Languages

Every string is in `src/i18n/en.ts`, and only English is shown at testnet. Hausa, Yoruba, Igbo, Swahili, French, Portuguese and Spanish stay in `src/i18n/drafts/`, each with every key, marked as not reviewed. A string whose English changed when the widget moved to the wallet method only is `null` again, with the English above it. A draft ships once it has no `null` left and a native speaker has reviewed it; nothing in the widget imports the drafts until then, so they cost the bundle nothing.

## Checks

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test              # flow, copy, theme, contrast and the size rules
npm run build         # dist/ujira-embed.js, then the 60 KB gzipped budget
npm run licenses      # the dependency licence allowlist
npx playwright install chromium
npm run e2e           # the built file on a plain HTML page: flow, 320px, axe, theming
npm run screenshots -- <folder>
```

The build fails when the file is over 60 KB gzipped, carries the development build of the renderer, stops defining the element, or carries a licence notice nobody reviewed.
