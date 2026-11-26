// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The public demo MCP at /mcp: one shared demo mandate that anyone can call
// with no sign in. A cap on what a stranger can ask it to pay and limits on
// how often they can ask keep it safe to leave open. Testnet only.

import type { PayoutEngine } from '../engine/engine.js';
import type { McpBinding } from '../mcp/http.js';
import { WindowLimiter, type HttpSettings, type PublicLimits } from '../mcp/public.js';
import type { GuardAnswer, ToolGuard, ToolName } from '../mcp/server.js';
import { formatUnits } from '../money.js';

export interface PublicLimiters {
  readonly toolCalls: WindowLimiter;
  readonly payouts: WindowLimiter;
}

export function publicLimiters(limits: PublicLimits, now?: () => number): PublicLimiters {
  return {
    toolCalls: new WindowLimiter(limits.toolCallsPerMinute, 60_000, now),
    payouts: new WindowLimiter(limits.payoutsPerHour, 3_600_000, now),
  };
}

const refuse = (message: string): GuardAnswer => ({ answer: message, isError: true });

const inMinutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/**
 * The guard for one public caller. The global limit comes first so a flood
 * costs nothing past it; the amount cap answers before the per-address limit
 * so a refused amount does not use up a visitor's payouts.
 */
export function publicGuard(options: {
  readonly limits: PublicLimits;
  readonly limiters: PublicLimiters;
  /** The caller's rate limit key, from rateKey. */
  readonly client: string;
  readonly assetCode: string;
}): ToolGuard {
  const { limits, limiters, client, assetCode } = options;
  return (tool: ToolName, input) => {
    const busy = limiters.toolCalls.take('all');
    if (!busy.ok) {
      return refuse(
        'rate_limited: this public demo server is answering too many calls right now; try again in a minute',
      );
    }
    const amount = input['amount'];
    const priced = tool === 'quote_payout' || tool === 'request_payout';
    if (priced && typeof amount === 'bigint' && amount > limits.maxAmount) {
      const fields = {
        reason: 'public_demo_limit',
        amount: amount.toString(),
        asset: assetCode,
        max_amount: limits.maxAmount.toString(),
        detail: `This shared public demo pays at most ${formatUnits(limits.maxAmount)} ${assetCode} per payout. Nothing was sent.`,
      };
      const taskId = input['task_id'];
      return {
        answer:
          tool === 'quote_payout'
            ? { decision: 'blocked', ...fields }
            : {
                task_id: typeof taskId === 'string' ? taskId : null,
                outcome: 'blocked',
                ...fields,
              },
      };
    }
    if (tool === 'request_payout') {
      const hit = limiters.payouts.take(client);
      if (!hit.ok) {
        return refuse(
          `rate_limited: this public demo allows ${limits.payoutsPerHour} payout requests an hour from one address; try again in ${inMinutes(hit.retryAfterMs)} minutes`,
        );
      }
    }
    return undefined;
  };
}

/** What every visitor is told: the demo is shared and what it lets a stranger do. */
export function publicNotes(
  limits: PublicLimits,
  assetCode: string,
  recipients: readonly string[],
): { notes: Partial<Record<ToolName, string>>; instructions: string } {
  const cap = `${formatUnits(limits.maxAmount)} ${assetCode}`;
  const allowed =
    recipients.length === 0 ? '' : ` Allowlisted demo recipients: ${recipients.join(', ')}.`;
  const shared =
    'This is a shared public demo on Stellar testnet: everyone who connects uses the same demo mandate, agent key and receipt log, and testnet tokens are not real money.';
  return {
    notes: {
      quote_payout: `On this public demo, amounts above ${cap} are blocked with reason public_demo_limit.${allowed}`,
      request_payout: `${shared} Amounts above ${cap} are blocked with reason public_demo_limit, and one address may request ${limits.payoutsPerHour} payouts an hour. Task IDs are public, so put no personal data in them.${allowed}`,
      payout_status: 'Task IDs on this public demo are shared by everyone who connects.',
      list_receipts: `${shared} These receipts are everyone's, not only yours.`,
    },
    instructions: `UJIRA public demo. ${shared} Payouts above ${cap} are blocked with reason public_demo_limit; the mandate's own rules apply below that. Task IDs and receipts are visible to every visitor, so never put personal data in them.${allowed}`,
  };
}

/**
 * The /mcp binding for each caller. The limiters are made once, so every
 * caller of this server counts against the same windows.
 */
export function publicMcp(o: {
  readonly engine: PayoutEngine;
  readonly http: HttpSettings;
  readonly assetCode: string;
  /** Allowlisted destinations to tell visitors about. */
  readonly recipients: readonly string[];
  readonly now?: () => number;
}): (client: string) => McpBinding {
  const { limits } = o.http;
  const limiters = publicLimiters(limits, o.now);
  const { notes, instructions } = publicNotes(limits, o.assetCode, o.recipients);
  return (client) => ({
    engine: o.engine,
    options: {
      guard: publicGuard({ limits, limiters, client, assetCode: o.assetCode }),
      notes,
      instructions,
    },
  });
}
