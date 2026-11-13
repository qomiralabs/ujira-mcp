// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { createHash } from 'node:crypto';

import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

/** 32 bytes as 64 lowercase hex digits, the form every BytesN<32> takes here. */
export const hex32 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex digits');
export type Hex32 = z.infer<typeof hex32>;

/**
 * A task ID the caller chooses. Printable and short, because it lands in the
 * receipt log and in what is shown back to the caller.
 */
export const taskId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:/@#-]+$/, 'letters, digits and . _ : / @ # - only');

/** A classic Stellar account (G...), the only destination the USDC rail pays. */
export const accountAddress = z
  .string()
  .refine((s) => StrKey.isValidEd25519PublicKey(s), 'expected a Stellar account address (G...)');

export const contractAddress = z
  .string()
  .refine((s) => StrKey.isValidContract(s), 'expected a Stellar contract address (C...)');

function sha256(parts: readonly string[]): Hex32 {
  // A newline cannot appear in any part (task IDs and addresses refuse it), so
  // the joined form is unambiguous.
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * The payout ID for a task on a mandate. Deterministic, so a retry of the same
 * task maps to the same ID and the mandate refuses to pay it twice.
 */
export function payoutIdFor(mandate: string, task: string): Hex32 {
  return sha256(['ujira-mcp/payout/v1', mandate, task]);
}

/** The task reference the request carries on chain. The task ID itself stays off chain. */
export function taskRefFor(task: string): Hex32 {
  return sha256(['ujira-mcp/task/v1', task]);
}

/** The recipient reference used when the mandate file names none for a destination. */
export function defaultRecipientRef(destination: string): Hex32 {
  return sha256(['ujira-mcp/recipient/v1', destination]);
}
