// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { issueEmbedToken, parseEmbedToken } from './embed-token.js';
import { hashSecret, issueToken, parseToken } from './token.js';

describe('embed tokens', () => {
  it('issues a URL safe token that parses back to its environment and hash', () => {
    const issued = issueEmbedToken('test');
    expect(issued.token).toMatch(/^ujes_test_[a-z2-7]{59}$/);
    expect(encodeURIComponent(issued.token)).toBe(issued.token);
    const parsed = parseEmbedToken(issued.token);
    expect(parsed?.environment).toBe('test');
    expect(parsed?.secretSha256.equals(issued.secretSha256)).toBe(true);
    expect(issued.secretSha256).toHaveLength(32);
  });

  it('stores only a hash, never the token or its secret', () => {
    const issued = issueEmbedToken('live');
    const secret = issued.token.slice('ujes_live_'.length, -7);
    expect(issued.secretSha256.equals(hashSecret(secret))).toBe(true);
    expect(issued.secretSha256.toString('utf8')).not.toContain(secret);
  });

  it('gives every token its own secret', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => issueEmbedToken('test').token));
    expect(tokens.size).toBe(20);
  });

  it('refuses a token with a wrong checksum, a changed secret or another shape', () => {
    const { token } = issueEmbedToken('test');
    const last = token.at(-1) === 'a' ? 'b' : 'a';
    expect(parseEmbedToken(`${token.slice(0, -1)}${last}`)).toBeNull();
    const flipped = token.charAt(12) === 'a' ? 'b' : 'a';
    expect(parseEmbedToken(`${token.slice(0, 12)}${flipped}${token.slice(13)}`)).toBeNull();
    expect(parseEmbedToken(token.toUpperCase())).toBeNull();
    expect(parseEmbedToken(`${token}a`)).toBeNull();
    expect(parseEmbedToken(`ujes_prod_${token.slice(10)}`)).toBeNull();
    expect(parseEmbedToken('')).toBeNull();
  });

  it('is never mistaken for an API key, and an API key is never one', () => {
    const embed = issueEmbedToken('test').token;
    const key = issueToken('test').token;
    expect(parseToken(embed)).toBeNull();
    expect(parseEmbedToken(key)).toBeNull();
  });
});
