// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The hosted invite page at /embed/v1/invite: the link a principal sends a
// recipient opens here, and the page opens the onboarding widget for them.
//
// The embed token rides in the URL fragment, which a browser never sends to a
// server. The page reads it, takes it out of the address bar and the history
// at once, and hands it to the widget, which sends it only in an
// Authorization header. So the token is never in a request line, a server
// log, or a Referer, and no-referrer makes sure of the last.
//
// The page's one script and one style block are inline, allowed by their
// hashes, so the content security policy can forbid every other inline
// script and every third party.

import { createHash } from 'node:crypto';

export const INVITE_PATH = '/embed/v1/invite';

/** Where the widget is served from, beside this page. */
const WIDGET_SCRIPT = '/embed/v1/ujira-embed.js';

/**
 * Reads the token from the fragment and mounts the widget with it. Kept to
 * plain script that any browser the widget runs in can parse.
 */
export const INVITE_SCRIPT = `(function () {
  var token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  if (location.hash !== '') history.replaceState(null, '', location.pathname + location.search);
  if (!/^ujes_(?:live|test)_[a-z2-7]{59}$/.test(token)) {
    document.getElementById('gone').hidden = false;
    return;
  }
  customElements.whenDefined('ujira-onboarding').then(function () {
    var widget = document.createElement('ujira-onboarding');
    widget.token = token;
    document.getElementById('slot').append(widget);
  });
})();`;

const INVITE_STYLE = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: "Urbanist", "Segoe UI", system-ui, sans-serif;
    color: #0A1F26;
    background: #EDF5F6;
  }
  main { max-width: 28rem; margin: 0 auto; padding: 32px 16px 48px; }
  .brand {
    margin: 0 0 24px;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: #0F4C5C;
  }
  .brand::after {
    content: "";
    display: inline-block;
    width: 0.4em;
    height: 0.4em;
    margin-left: 0.15em;
    border-radius: 50%;
    background: #F4A300;
  }
  h1 { margin: 0 0 16px; font-size: 24px; line-height: 1.3; }
  .gone {
    margin: 0;
    padding: 16px;
    border-radius: 12px;
    background: #FFFFFF;
    color: #3F5258;
    font-size: 16px;
    line-height: 1.5;
  }
`;

function sha256(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** Only this page's own script and style, the widget from this origin, and its calls back here. */
export const INVITE_CSP = [
  "default-src 'none'",
  `script-src 'self' ${sha256(INVITE_SCRIPT)}`,
  `style-src ${sha256(INVITE_STYLE)}`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const INVITE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Set up your payouts | UJIRA</title>
    <style>${INVITE_STYLE}</style>
    <script type="module" src="${WIDGET_SCRIPT}"></script>
  </head>
  <body>
    <main>
      <p class="brand">UJIRA</p>
      <h1>Set up your payouts</h1>
      <p id="gone" class="gone" hidden>
        This link has expired or was revoked. Ask the person who sent it for a new one.
      </p>
      <div id="slot"></div>
    </main>
    <script>${INVITE_SCRIPT}</script>
  </body>
</html>
`;

export const INVITE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  // The page holds no token, but a fresh copy means a fixed page reaches every link at once.
  'cache-control': 'no-cache',
  'content-security-policy': INVITE_CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
