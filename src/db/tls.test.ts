// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// These tests exist so the claim in tls.ts cannot drift from what the code
// carries. Security review blocked an earlier version of this module for
// telling an operator that TLS trust was pinned here when nothing pinned
// it; a claim about transport security needs a test that fails when the
// claim stops being true.

import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ISRG_ROOT_X1, ISRG_ROOT_YR, PINNED_ROOT_FINGERPRINTS, PINNED_TLS } from './tls.js';

const certFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../db/certs/${name}`, import.meta.url)), 'utf8');

const ROOTS = [
  { name: 'ISRG Root X1', pem: ISRG_ROOT_X1, file: 'isrg-root-x1.pem', key: 'x1' },
  { name: 'Root YR', pem: ISRG_ROOT_YR, file: 'isrg-root-yr.pem', key: 'yr' },
] as const;

// The YR2 intermediate and the cross signed Root YR, as the Render endpoint
// sent them on 2026-11-27. The leaf is left out: it is renewed every few
// months, and the test would then only prove an old certificate.
function serverIntermediates(): readonly X509Certificate[] {
  const text = certFile('render-chain-intermediates.pem');
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) => new X509Certificate(block));
}

describe('the pinned TLS trust', () => {
  for (const root of ROOTS) {
    it(`embeds ${root.name} exactly as vendored in db/certs, byte for byte`, () => {
      // db/certs/ is the source of truth. If someone updates the file and
      // not the embedded copy, or the other way round, this fails.
      expect(root.pem).toBe(certFile(root.file));
    });

    it(`is ${root.name}, by its own fingerprint`, () => {
      const certificate = new X509Certificate(root.pem);
      expect(certificate.fingerprint256).toBe(PINNED_ROOT_FINGERPRINTS[root.key]);
      expect(certificate.subject).toContain(`CN=${root.name}`);
      // Self signed: a root, not an intermediate that could be swapped.
      expect(certificate.checkIssued(certificate)).toBe(true);
      expect(certificate.verify(certificate.publicKey)).toBe(true);
    });

    it(`${root.name} is a certificate authority with runway left before it has to be rotated`, () => {
      // Runway, not validity. A check that only fires once the certificate
      // is dead buys nothing: the day it fails, every connection is already
      // failing. Ninety days is enough to rotate a pin through review.
      const certificate = new X509Certificate(root.pem);
      expect(certificate.ca).toBe(true);
      const daysLeft = (new Date(certificate.validTo).getTime() - Date.now()) / 86_400_000;
      expect(
        daysLeft,
        `${root.name} expires in ${Math.floor(daysLeft).toString()} days: rotate the pin in src/db/tls.ts and db/certs/, from the source URLs in that file`,
      ).toBeGreaterThan(90);
    });
  }

  it('matches the copy of ISRG Root X1 in the runtime root store, a second source', () => {
    const fingerprints = rootCertificates.map((pem) => new X509Certificate(pem).fingerprint256);
    expect(fingerprints).toContain(PINNED_ROOT_FINGERPRINTS.x1);
  });

  it('anchors the chain the database server sends, through either root', () => {
    const [intermediate, crossSigned] = serverIntermediates();
    if (intermediate === undefined || crossSigned === undefined) {
      throw new Error('db/certs/render-chain-intermediates.pem must hold two certificates');
    }
    const x1 = new X509Certificate(ISRG_ROOT_X1);
    const yr = new X509Certificate(ISRG_ROOT_YR);
    // Today: YR2, issued by Root YR, whose cross signed copy X1 issued.
    expect(intermediate.checkIssued(crossSigned)).toBe(true);
    expect(intermediate.verify(crossSigned.publicKey)).toBe(true);
    expect(crossSigned.checkIssued(x1)).toBe(true);
    expect(crossSigned.verify(x1.publicKey)).toBe(true);
    // Once the cross sign is dropped: YR2 verifies against the self signed
    // Root YR directly, because the two Root YR certificates share a key.
    expect(intermediate.checkIssued(yr)).toBe(true);
    expect(intermediate.verify(yr.publicKey)).toBe(true);
  });

  it('verifies the server rather than trusting it', () => {
    expect(PINNED_TLS.rejectUnauthorized).toBe(true);
    expect(PINNED_TLS.ca).toBe(`${ISRG_ROOT_X1}${ISRG_ROOT_YR}`);
    expect(PINNED_TLS.minVersion).toBe('TLSv1.2');
  });

  it('cannot be edited by a caller that gets hold of it', () => {
    expect(Object.isFrozen(PINNED_TLS)).toBe(true);
    expect(Object.isFrozen(PINNED_ROOT_FINGERPRINTS)).toBe(true);
  });

  it('trusts these two roots alone, not the system roots', () => {
    // A ca entry replaces the default trust store, which is the point: a
    // certificate from another issuer is refused however valid.
    expect(typeof PINNED_TLS.ca).toBe('string');
    expect(PINNED_TLS.ca.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
  });
});
