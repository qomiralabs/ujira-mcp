// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// These tests exist so the claim in tls.ts cannot drift from what the code
// carries. Security review blocked an earlier version of this module for
// telling an operator that TLS trust was pinned here when nothing pinned
// it; a claim about transport security needs a test that fails when the
// claim stops being true.

import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PINNED_TLS, SUPABASE_ROOT_2021_CA, SUPABASE_ROOT_2021_CA_FINGERPRINT } from './tls.js';

const CERT_FILE = fileURLToPath(
  new URL('../../db/certs/supabase-root-2021-ca.crt', import.meta.url),
);

describe('the pinned TLS trust', () => {
  it('embeds exactly the vendored certificate, byte for byte', () => {
    // db/certs/ is the source of truth. If someone updates the file and not
    // the embedded copy, or the other way round, this fails.
    expect(SUPABASE_ROOT_2021_CA).toBe(readFileSync(CERT_FILE, 'utf8'));
  });

  it('is the Supabase Root 2021 CA, by its own fingerprint', () => {
    const certificate = new X509Certificate(SUPABASE_ROOT_2021_CA);
    expect(certificate.fingerprint256).toBe(SUPABASE_ROOT_2021_CA_FINGERPRINT);
    expect(certificate.subject).toContain('Supabase Root 2021 CA');
  });

  it('is a certificate authority with runway left before it has to be rotated', () => {
    // Runway, not validity. A check that only fires once the certificate is
    // dead buys nothing: the day it fails, every connection is already
    // failing. Ninety days is enough to rotate a pin through review. This
    // stays in the per pull request suite rather than a scheduled run
    // because the expiry is in 2031, so it costs nothing until it matters,
    // and the zero warnings rule means a soft signal is not available.
    const certificate = new X509Certificate(SUPABASE_ROOT_2021_CA);
    expect(certificate.ca).toBe(true);
    const daysLeft = (new Date(certificate.validTo).getTime() - Date.now()) / 86_400_000;
    expect(
      daysLeft,
      `the pinned CA expires in ${Math.floor(daysLeft).toString()} days: rotate the pin in src/db/tls.ts and db/certs/, from the source URL in that file`,
    ).toBeGreaterThan(90);
  });

  it('verifies the server rather than trusting it', () => {
    expect(PINNED_TLS.rejectUnauthorized).toBe(true);
    expect(PINNED_TLS.ca).toBe(SUPABASE_ROOT_2021_CA);
    expect(PINNED_TLS.minVersion).toBe('TLSv1.2');
  });

  it('cannot be edited by a caller that gets hold of it', () => {
    expect(Object.isFrozen(PINNED_TLS)).toBe(true);
  });

  it('trusts this certificate alone, not the system roots', () => {
    // A single ca entry replaces the default trust store, which is the
    // point: a certificate from another issuer is refused however valid.
    expect(typeof PINNED_TLS.ca).toBe('string');
    expect(PINNED_TLS.ca.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
  });
});
