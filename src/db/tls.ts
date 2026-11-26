// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The TLS trust this module pins. Connections to the hosted database go
// through Supavisor, whose certificate chains to the Supabase Root 2021 CA,
// and this is that certificate. Verification is on and the trust store is
// this one certificate rather than the system roots, so a certificate from
// any other issuer is refused however valid it looks.
//
// The PEM is embedded rather than read from disk, so a built image cannot
// be missing it and nothing resolves a path at run time.
// db/certs/supabase-root-2021-ca.crt is the source of truth, and tls.test.ts fails if
// the two ever differ or if the embedded bytes stop being that CA.
//
// Where it came from, because a fingerprint proves identity without saying
// where identity came from:
//
//   https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
//
// Downloaded and compared byte for byte against the vendored file on
// 2026-10-21: 1367 bytes, identical. Rotating the pin means fetching that
// URL again, checking the fingerprint below against what Supabase
// publishes, and updating both the file and this module, which tls.test.ts
// requires to agree.
//
// A URL may not carry an ssl parameter, and config.ts refuses one: pg lets
// sslmode replace or disable this, which would quietly undo the pin.

const PEM_LINES = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL',
  'BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l',
  'dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh',
  'c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow',
  'azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD',
  'YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug',
  'Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW',
  'QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q',
  'DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2',
  'GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi',
  'cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4',
  'O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt',
  'NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX',
  'uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt',
  'aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU',
  'tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b',
  'VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6',
  'jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx',
  'Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2',
  'CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P',
  'o/bKiIz+Fq8=',
  '-----END CERTIFICATE-----',
].join('\n');

export const SUPABASE_ROOT_2021_CA = `${PEM_LINES}\n`;

// The certificate's own SHA-256 fingerprint, as Supabase publishes it and as
// the spike recorded it on 2026-10-18.
export const SUPABASE_ROOT_2021_CA_FINGERPRINT =
  '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';

// One frozen object, so a test can assert this exact configuration is what
// reaches the driver.
export const PINNED_TLS: {
  readonly ca: string;
  readonly rejectUnauthorized: true;
  readonly minVersion: 'TLSv1.2';
} = Object.freeze({
  ca: SUPABASE_ROOT_2021_CA,
  rejectUnauthorized: true,
  minVersion: 'TLSv1.2',
});
