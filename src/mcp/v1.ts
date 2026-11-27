// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The product MCP at POST /v1/mcp: the same four tool names as the public
// demo, over the services /v1 runs, so a tool and the API it mirrors enforce
// the same rules with the same code. Inputs are the /v1 request bodies and
// answers are the /v1 shapes, less anything that could name a person.
//
// A project API key is the only way in, and the tenant comes from the key
// alone. Connecting needs payouts:read; request_payout also needs
// payouts:write, checked per call, so a read only key can still quote and
// read. Stateless like the demo: every POST builds its own server and
// transport, so nothing about a caller outlives their request.
//
// The task id is the idempotency key for request_payout. The key is derived
// from the mandate and the task, so a retried tool call lands on the payout
// row's unique key and finds the payout it made, and the same task sent with
// another amount is refused rather than paid again.

import { createHash } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { Authenticate, KeyCaller } from '../api/authenticate.js';
import { readBodyBytes } from '../api/body.js';
import type { V1Context } from '../api/context.js';
import { decodeCursor, encodeCursor } from '../api/cursor.js';
import { ApiError, validationDetails, type ErrorDetail } from '../api/errors.js';
import type { Route } from '../api/route.js';
import {
  amountWire,
  createPayoutBody,
  payoutApiError,
  payoutDetailSchema,
  payoutWire,
  quotePayoutBody,
} from '../api/routes/payouts.js';
import type { ApiScope } from '../auth/scopes.js';
import { PageRequestError } from '../db/index.js';
import { taskId } from '../ids.js';
import { logLine } from '../log.js';
import type { PayoutRecord, PayoutService } from '../payouts/payout-service.js';
import type { McpReads, ReceiptWithPayout } from './v1-reads.js';

export const V1_MCP_PATH = '/v1/mcp';
export const V1_MCP_SERVER_NAME = 'ujira';
export const V1_MCP_SERVER_VERSION = '1.0.0';

// The demo's names, so an agent moves from the demo to a project by changing
// the URL and adding a key.
export const V1_TOOL_NAMES = [
  'quote_payout',
  'request_payout',
  'payout_status',
  'list_receipts',
] as const;
export type V1ToolName = (typeof V1_TOOL_NAMES)[number];

const ENTRY_SCOPE: ApiScope = 'payouts:read';
const DEFAULT_RECEIPT_PAGE = 20;
const MAX_RECEIPT_PAGE = 50;

export const V1_MCP_INSTRUCTIONS =
  "UJIRA pays out through a principal's mandate on Stellar. The mandate's limits (total budget, per payment cap, per recipient daily cap and approval threshold) are set by the principal on chain and enforced by the mandate contract; UJIRA reads them from the chain and cannot raise them. A payout at or above the approval threshold waits until an approver approves it in the UJIRA dashboard with their wallet; no tool here approves. Amounts are integer minor units as decimal strings with an explicit asset, network and scale.";

const LIMITS_NOTE =
  "The mandate's limits live on chain: the mandate contract checks every payout against them, and UJIRA reads them from the chain rather than keeping its own copy.";
const APPROVAL_NOTE =
  'A payout at or above the approval threshold waits in pending_approval until an approver approves it in the UJIRA dashboard; this tool cannot approve.';
const AMOUNT_NOTE =
  'amount is { amount, asset, network, scale }, with amount in minor units as a decimal string; USDC on Stellar has scale 7, so "10000000" is 1 USDC.';

const lowerUuid = z.uuid().transform((value) => value.toLowerCase());

const statusInput = z.object({ mandateId: lowerUuid, taskId }).strict();

const receiptsInput = z
  .object({
    limit: z.int().min(1).max(MAX_RECEIPT_PAGE).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

const cursorValue = z.object({ after: z.string().min(1).max(256) }).strict();

// The payout as /v1 shows it, with the recipient by id only: a label is free
// text a principal typed and may well be a person's name.
export const mcpPayoutSchema = payoutDetailSchema
  .omit({ recipient: true })
  .extend({ recipient: z.object({ id: z.uuid() }).strict() })
  .strict();

const amountOut = z
  .object({ amount: z.string(), asset: z.string(), network: z.string(), scale: z.int() })
  .strict();

export const mcpReceiptSchema = z
  .object({
    id: z.uuid(),
    payoutId: z.uuid(),
    mandateId: z.uuid(),
    taskId: z.string(),
    status: z.string(),
    blockedBy: z.string().nullable(),
    amount: amountOut,
    fee: amountOut,
    chainReceiptRef: z.string().nullable(),
    requestTxHash: z.string().nullable(),
    settledAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

const quoteAnswer = z
  .object({
    quote: z
      .object({
        decision: z.enum(['allowed', 'approval_required', 'blocked']),
        blockedBy: z.string().nullable(),
        amount: amountOut,
      })
      .strict(),
  })
  .strict();

const requestAnswer = z
  .object({
    payout: mcpPayoutSchema,
    // True when this call found the payout an earlier call with the task made.
    replayed: z.boolean(),
  })
  .strict();

const statusAnswer = z
  .object({ payout: mcpPayoutSchema.nullable(), receipt: mcpReceiptSchema.nullable() })
  .strict();

const receiptsAnswer = z
  .object({ items: z.array(mcpReceiptSchema), nextCursor: z.string().nullable() })
  .strict();

/**
 * The idempotency key a tool call's payout is written under. Task ids may
 * hold characters a key may not, and are unique per mandate, so the key is a
 * digest of both. The prefix keeps it apart from any key a client sends to
 * POST /v1/payouts itself.
 */
export function taskIdempotencyKey(mandateId: string, task: string): string {
  const digest = createHash('sha256')
    .update(['ujira/mcp-task/v1', mandateId.toLowerCase(), task].join('\n'))
    .digest('hex');
  return `mcp.${digest}`;
}

export interface V1McpServices {
  readonly payouts: PayoutService;
  readonly reads: McpReads;
}

/** Who is calling, for one request. */
export interface V1McpCall {
  readonly caller: KeyCaller;
  readonly requestId: string;
}

interface Tool<S extends z.ZodType> {
  readonly name: V1ToolName;
  readonly description: string;
  readonly schema: S;
  readonly readOnly: boolean;
  readonly scope: ApiScope;
  run(services: V1McpServices, call: V1McpCall, input: z.output<S>): Promise<unknown>;
}

interface ErasedTool {
  readonly name: V1ToolName;
  readonly description: string;
  readonly schema: z.ZodType;
  readonly readOnly: boolean;
  readonly scope: ApiScope;
  run(services: V1McpServices, call: V1McpCall, input: unknown): Promise<unknown>;
}

function tool<S extends z.ZodType>(t: Tool<S>): ErasedTool {
  return { ...t, run: (services, call, input) => t.run(services, call, input as z.output<S>) };
}

function mcpPayout(
  record: PayoutRecord,
  receiptId: string | null,
): z.input<typeof mcpPayoutSchema> {
  const { recipient, ...rest } = payoutWire(record, receiptId);
  return { ...rest, recipient: { id: recipient.id } };
}

function mcpReceipt({ receipt, payout }: ReceiptWithPayout): z.input<typeof mcpReceiptSchema> {
  return {
    id: receipt.id,
    payoutId: receipt.payoutId,
    mandateId: payout.mandateId,
    taskId: payout.taskId,
    status: receipt.status,
    blockedBy: receipt.blockedBy,
    amount: amountWire(receipt.amount, receipt.network),
    fee: amountWire(receipt.fee, receipt.network),
    chainReceiptRef: receipt.chainReceiptRef,
    requestTxHash: receipt.requestTxHash,
    settledAt: receipt.settledAt === null ? null : receipt.settledAt.toISOString(),
    createdAt: receipt.createdAt.toISOString(),
  };
}

export const V1_TOOLS: readonly ErasedTool[] = [
  tool({
    name: 'quote_payout',
    description: `Asks the mandate whether it would take this payout now: allowed, approval_required, or blocked with the spec error name, such as INSUFFICIENT_FUNDS. Nothing is written or spent. ${LIMITS_NOTE} ${APPROVAL_NOTE} ${AMOUNT_NOTE}`,
    schema: quotePayoutBody,
    readOnly: true,
    scope: 'payouts:read',
    run: async (services, call, input) => {
      const answer = await services.payouts.quote(call.caller, input, call.requestId);
      return quoteAnswer.parse({
        quote: {
          decision: answer.decision,
          blockedBy: answer.blockedBy,
          amount: amountWire(answer.amount, answer.network),
        },
      });
    },
  }),
  tool({
    name: 'request_payout',
    description: `Requests a payout for a task. The task id is the idempotency key: calling again with the same mandateId and taskId returns the same payout and never pays twice, and the same task with another amount or recipient is refused. The payout is accepted as queued and paid by UJIRA within the mandate's limits; a payout the mandate refuses is recorded as blocked with the spec error. ${LIMITS_NOTE} ${APPROVAL_NOTE} Needs an API key with payouts:write. ${AMOUNT_NOTE}`,
    schema: createPayoutBody,
    readOnly: false,
    scope: 'payouts:write',
    run: async (services, call, input) => {
      const record = await services.payouts.create(
        call.caller,
        {
          mandateId: input.mandateId,
          recipientId: input.recipientId,
          amount: input.amount,
          taskId: input.taskId,
          metadata: input.metadata,
          idempotencyKey: taskIdempotencyKey(input.mandateId, input.taskId),
        },
        call.requestId,
      );
      return requestAnswer.parse({ payout: mcpPayout(record, null), replayed: !record.created });
    },
  }),
  tool({
    name: 'payout_status',
    description: `The payout for a task on a mandate as UJIRA records it: its status (queued, submitting, pending_approval, approved, settling, paid, blocked, rejected, cancelled, failed or needs_attention), the spec error when blocked, each leg's transaction hash, and its receipt once it is final. pending_approval means an approver must act in the UJIRA dashboard. payout is null when the task has no payout on that mandate. ${LIMITS_NOTE}`,
    schema: statusInput,
    readOnly: true,
    scope: 'payouts:read',
    run: async (services, call, input) => {
      const found = await services.reads.payoutByTask(call.caller, input.mandateId, input.taskId);
      if (found === undefined) return statusAnswer.parse({ payout: null, receipt: null });
      const receipt =
        found.receipt === null
          ? null
          : mcpReceipt({ receipt: found.receipt, payout: found.record.payout });
      return statusAnswer.parse({
        payout: mcpPayout(found.record, found.receipt?.id ?? null),
        receipt,
      });
    },
  }),
  tool({
    name: 'list_receipts',
    description: `Receipts of this project's finished payouts, newest first: the outcome, amount, fee, task, mandate, chain receipt reference and request transaction hash. A blocked payout has a receipt too, naming the spec error. Pass nextCursor back as cursor for the next page. ${LIMITS_NOTE}`,
    schema: receiptsInput,
    readOnly: true,
    scope: 'payouts:read',
    run: async (services, call, input) => {
      const after =
        input.cursor === undefined ? undefined : decodeCursor(input.cursor, cursorValue).after;
      const page = await services.reads.receipts(call.caller, {
        limit: input.limit ?? DEFAULT_RECEIPT_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      return receiptsAnswer.parse({
        items: page.items.map(mcpReceipt),
        nextCursor: page.next === null ? null : encodeCursor({ after: page.next }),
      });
    },
  }),
];

function text(value: unknown, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

// The tool's answer to a refusal: the /v1 envelope, with paths that name the
// tool's input rather than an HTTP body.
function refusal(error: ApiError, requestId: string): CallToolResult {
  const details = (error.details ?? []).map((d) => ({
    path: d.path.replace(/^(?:body|query)\./, ''),
    issue: d.issue,
  }));
  return text(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        ...(details.length === 0 ? {} : { details }),
      },
    },
    true,
  );
}

/** A failure the caller can act on, as /v1 would answer it, or undefined for a bug. */
export function toolRefusal(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (error instanceof PageRequestError) {
    return new ApiError('INVALID_REQUEST', 'The cursor is not one this server issued', {
      details: [{ path: 'cursor', issue: 'invalid_format' }],
      cause: error,
    });
  }
  const mapped = payoutApiError(error);
  return mapped instanceof ApiError ? mapped : undefined;
}

export interface V1McpServerOptions {
  readonly log?: (line: string) => void;
}

export function createV1McpServer(
  services: V1McpServices,
  call: V1McpCall,
  options: V1McpServerOptions = {},
): McpServer {
  const log = options.log ?? (() => undefined);
  const mcp = new McpServer(
    { name: V1_MCP_SERVER_NAME, version: V1_MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: V1_MCP_INSTRUCTIONS },
  );
  // One line per tool call with the tenant and the outcome, never the input.
  const record = (name: V1ToolName, outcome: string) => {
    log(
      logLine('v1_mcp_tool', {
        requestId: call.requestId,
        principalId: call.caller.principalId,
        projectId: call.caller.projectId,
        tool: name,
        outcome,
      }),
    );
  };
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: V1_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema, { io: 'input' }) as {
        type: 'object';
        [key: string]: unknown;
      },
      annotations: { readOnlyHint: t.readOnly, idempotentHint: true },
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const found = V1_TOOLS.find((t) => t.name === request.params.name);
    if (found === undefined) throw new McpError(ErrorCode.InvalidParams, 'There is no such tool');
    if (!call.caller.scopes.includes(found.scope)) {
      record(found.name, 'FORBIDDEN');
      return refusal(
        new ApiError(
          'FORBIDDEN',
          `This API key does not hold ${found.scope}, which this tool needs`,
        ),
        call.requestId,
      );
    }
    const parsed = found.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      record(found.name, 'INVALID_REQUEST');
      const details: ErrorDetail[] = validationDetails(parsed.error, '');
      return refusal(
        new ApiError('INVALID_REQUEST', 'The input does not match the schema', { details }),
        call.requestId,
      );
    }
    try {
      const answer = await found.run(services, call, parsed.data);
      record(found.name, 'ok');
      return text(answer);
    } catch (error) {
      const refused = toolRefusal(error);
      if (refused !== undefined) {
        record(found.name, refused.code);
        return refusal(refused, call.requestId);
      }
      log(
        logLine('v1_mcp_tool_failed', {
          requestId: call.requestId,
          principalId: call.caller.principalId,
          projectId: call.caller.projectId,
          tool: found.name,
          error: error instanceof Error ? error.name : 'NonError',
        }),
      );
      return text(
        { error: { code: 'INTERNAL', message: 'Internal error', requestId: call.requestId } },
        true,
      );
    }
  });
  return mcp;
}

export interface V1McpRouteOptions extends V1McpServices {
  readonly authenticate: Authenticate;
  readonly log?: (line: string) => void;
}

function rpcError(
  status: number,
  code: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// A 401 says how to authenticate, so a client knows to send a Bearer key.
async function enter(authenticate: Authenticate, c: V1Context): Promise<KeyCaller> {
  const caller = await authenticate({ scope: ENTRY_SCOPE, via: 'key' })(c).catch(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        throw new ApiError(error.code, error.message, {
          headers: { 'www-authenticate': 'Bearer realm="ujira"' },
          cause: error,
        });
      }
      throw error;
    },
  );
  // A key rule never yields a session; checked so the type says so too.
  if (caller.kind !== 'key') throw new ApiError('TOKEN_MALFORMED', 'Send an API key');
  return caller;
}

export function v1McpRoutes(o: V1McpRouteOptions): Route[] {
  const services: V1McpServices = { payouts: o.payouts, reads: o.reads };
  const log = o.log ?? (() => undefined);

  async function run(c: V1Context): Promise<Response> {
    // Stateless: there is no stream to open with GET and no session to end with DELETE.
    if (c.req.method !== 'POST') {
      return rpcError(405, -32000, `Method not allowed; POST JSON-RPC to ${V1_MCP_PATH}`, {
        allow: 'POST',
      });
    }
    const caller = await enter(o.authenticate, c);
    const bytes = await readBodyBytes(c.req.raw);
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      return rpcError(400, -32700, 'Parse error');
    }
    const server = createV1McpServer(services, { caller, requestId: c.get('requestId') }, { log });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, { parsedBody: body });
    } finally {
      await transport.close();
      await server.close();
    }
  }

  return [
    {
      method: 'post',
      alsoMounted: ['get', 'delete'],
      path: V1_MCP_PATH,
      operationId: 'mcp',
      summary: 'The MCP server for this project',
      description: `Model Context Protocol over Streamable HTTP, stateless, answering JSON. Takes a project API key with payouts:read. Serves ${V1_TOOL_NAMES.join(', ')} over the same services as /v1; request_payout also needs payouts:write and uses the task id as its idempotency key. ${LIMITS_NOTE} ${APPROVAL_NOTE}`,
      tags: ['mcp'],
      status: 200,
      errors: [
        'TOKEN_MALFORMED',
        'TOKEN_INVALID',
        'TOKEN_ENVIRONMENT_MISMATCH',
        'FORBIDDEN',
        'ORIGIN_NOT_ALLOWED',
      ],
      body: z.looseObject({ jsonrpc: z.literal('2.0'), method: z.string().optional() }),
      query: undefined,
      params: undefined,
      response: z.looseObject({ jsonrpc: z.literal('2.0') }),
      responseDescription: 'The JSON-RPC answer, or 202 with no body for a notification',
      idempotent: false,
      run,
    },
  ];
}
