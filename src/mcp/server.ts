// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The MCP server: exactly four tools over the payout engine. It writes
// nothing but the protocol, since over stdio anything else on stdout would
// corrupt the stream the client reads.
//
// Tool input never carries a key. Every schema is strict, so an argument the
// tool does not define, a pasted secret included, is refused by name and
// never echoed back.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  listInput,
  payoutInput,
  quoteInput,
  statusInput,
  type PayoutEngine,
} from '../engine/engine.js';
import { EngineError } from '../errors.js';
import { formatUnits } from '../money.js';
import { receiptToJson, type Receipt } from '../receipts/log.js';

export const SERVER_NAME = 'ujira';
export const SERVER_VERSION = '0.1.0';

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject;
  readonly readOnly: boolean;
  run(engine: PayoutEngine, args: unknown): Promise<unknown>;
}

const AMOUNT_NOTE =
  'amount is a whole number of minor units as a string; USDC has 7 decimals, so "10000000" is 1 USDC.';

function withDisplay(r: Receipt): Record<string, unknown> {
  return { ...receiptToJson(r), amount_display: `${formatUnits(r.amount)} ${r.asset}` };
}

export const TOOLS: readonly Tool[] = [
  {
    name: 'quote_payout',
    description: `Predicts whether the mandate would allow a payout, need a human approval, or block it (with the reason), without spending anything. ${AMOUNT_NOTE}`,
    schema: quoteInput.strict(),
    readOnly: true,
    run: (engine, args) => engine.quotePayout(args),
  },
  {
    name: 'request_payout',
    description: `Requests a payout for a task, signed by this server's agent key and checked by the mandate on chain. Pays at once below the approval threshold; at or above it the payout waits for a human approver, and calling again with the same task_id after approval pays it. The same task_id is never paid twice. ${AMOUNT_NOTE}`,
    schema: payoutInput.strict(),
    readOnly: false,
    run: async (engine, args) => withDisplay(await engine.requestPayout(args)),
  },
  {
    name: 'payout_status',
    description:
      "The on-chain status of a task's payout (pending, approved, executed, rejected, cancelled or not_found) and its receipt.",
    schema: statusInput.strict(),
    readOnly: true,
    run: (engine, args) => engine.payoutStatus(args),
  },
  {
    name: 'list_receipts',
    description:
      'Receipts for this mandate, newest first: task_id, recipient, amount, asset, rail, outcome, payout_id and transaction hashes. With verify, each one is cross-checked against the mandate and the ledger.',
    schema: listInput.strict(),
    readOnly: true,
    run: (engine, args) => engine.listReceipts(args),
  },
];

function text(value: unknown, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export interface ServerOptions {
  /** Told the class name of a failure that is a bug here rather than an answer. */
  readonly onInternalError?: (name: string) => void;
}

export function createMcpServer(engine: PayoutEngine, options: ServerOptions = {}): McpServer {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  // The low level handlers, so the engine parses the arguments itself and
  // one schema decides what is valid.
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema, { io: 'input' }) as {
        type: 'object';
        [key: string]: unknown;
      },
      annotations: { readOnlyHint: tool.readOnly, idempotentHint: true },
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, 'There is no such tool');
    const args = request.params.arguments ?? {};
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const fields = parsed.error.issues
        .map((i) => {
          const where = i.path.join('.');
          return i.code === 'unrecognized_keys'
            ? `unknown field(s): ${i.keys.join(', ')}`
            : `${where === '' ? 'input' : where}: ${i.message}`;
        })
        .join('; ');
      return text(`The input was refused: ${fields}`, true);
    }
    try {
      return text(await tool.run(engine, args));
    } catch (error) {
      if (error instanceof EngineError) return text(`${error.code}: ${error.message}`, true);
      options.onInternalError?.(error instanceof Error ? error.name : 'NonError');
      return text('Something went wrong in the payout server', true);
    }
  });
  return mcp;
}
