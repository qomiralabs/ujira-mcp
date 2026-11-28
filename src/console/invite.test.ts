// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The invite page's script, run against a stand in for the browser: it takes
// the token out of the address bar before anything else, hands it to the
// widget and nowhere else, and says the link is no good when there is none.
// The page's headers are tested over HTTP in test/web.test.ts.

import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { issueEmbedToken } from '../auth/embed-token.js';
import { INVITE_CSP, INVITE_HTML, INVITE_SCRIPT } from './invite.js';

interface Element {
  hidden: boolean;
  token?: string;
  readonly tag: string;
  readonly children: Element[];
  append(child: Element): void;
}

function element(tag: string, hidden = false): Element {
  const children: Element[] = [];
  return {
    tag,
    hidden,
    children,
    append(child) {
      children.push(child);
    },
  };
}

function open(url: string) {
  const at = new URL(url);
  const events: string[] = [];
  const gone = element('p', true);
  const slot = element('div');
  let defined: () => void = () => undefined;
  const location = { hash: at.hash, pathname: at.pathname, search: at.search };
  runInNewContext(INVITE_SCRIPT, {
    URLSearchParams,
    location,
    history: {
      replaceState: (_state: unknown, _title: string, next: string) => {
        events.push(`replace ${next}`);
        location.hash = '';
      },
    },
    document: {
      getElementById: (id: string) => (id === 'gone' ? gone : id === 'slot' ? slot : null),
      createElement: (tag: string) => {
        events.push(`create ${tag}`);
        return element(tag);
      },
    },
    customElements: {
      whenDefined: (name: string) => {
        events.push(`wait ${name}`);
        return new Promise<void>((resolve) => {
          defined = resolve;
        });
      },
    },
  });
  return {
    events,
    gone,
    slot,
    location,
    define: async () => {
      defined();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('the invite page script', () => {
  it('takes the token out of the address bar, then gives it to the widget once it is defined', async () => {
    const { token } = issueEmbedToken('test');
    const page = open(`https://ujira.co/embed/v1/invite#token=${token}`);
    expect(page.events).toEqual(['replace /embed/v1/invite', 'wait ujira-onboarding']);
    expect(page.location.hash).toBe('');
    expect(page.slot.children).toEqual([]);
    await page.define();
    expect(page.slot.children).toHaveLength(1);
    expect(page.slot.children[0]).toMatchObject({ tag: 'ujira-onboarding', token });
    expect(page.gone.hidden).toBe(true);
  });

  it('reads an encoded token, as the console writes the link', async () => {
    const { token } = issueEmbedToken('test');
    const page = open(`https://ujira.co/embed/v1/invite#token=${encodeURIComponent(token)}`);
    await page.define();
    expect(page.slot.children[0]?.token).toBe(token);
  });

  it('says the link is no good, and mounts nothing, without a token or with a mangled one', () => {
    for (const fragment of ['', '#', '#token=', '#token=ujes_test_short', '#other=1']) {
      const page = open(`https://ujira.co/embed/v1/invite${fragment}`);
      expect(page.gone.hidden, fragment).toBe(false);
      expect(page.slot.children, fragment).toEqual([]);
      expect(
        page.events.filter((event) => event.startsWith('wait')),
        fragment,
      ).toEqual([]);
      expect(page.location.hash, fragment).toBe('');
    }
  });

  it('is the exact script the policy allows by hash', () => {
    const hash = createHash('sha256').update(INVITE_SCRIPT, 'utf8').digest('base64');
    expect(INVITE_CSP).toContain(`'sha256-${hash}'`);
    expect(INVITE_HTML).toContain(`<script>${INVITE_SCRIPT}</script>`);
    const style = /<style>([\s\S]*?)<\/style>/.exec(INVITE_HTML)?.[1] ?? '';
    const styleHash = createHash('sha256').update(style, 'utf8').digest('base64');
    expect(INVITE_CSP).toContain(`style-src 'sha256-${styleHash}'`);
  });
});
