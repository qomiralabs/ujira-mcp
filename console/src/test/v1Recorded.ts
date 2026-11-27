// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Answers recorded from the /v1 routes as the API design writes them, one
// per route the console calls. The client tests replay them; when the server
// changes a shape, the recording changes here first.

const NET = 'stellar:testnet';
const usdc = (amount: string) => ({ amount, asset: 'USDC', network: NET, scale: 7 });

export const IDS = {
  principal: '7d0c2f3e-6a51-4c1e-9a7e-0b1f5c0f6a10',
  project: '1f4b2b8e-2a8d-4f0f-8c55-6f0e3e2c9b21',
  mandate: '0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b',
  recipient: '5a1e9c2d-7b3f-4e8a-a1c2-3d4e5f6a7b8c',
  payout: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
  receipt: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
  runner: '6f5e4d3c-2b1a-4f0e-9d8c-7b6a5f4e3d2c',
  invite: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a',
  signing: 'sr_01HZX3Q8K4M2',
  contract: 'CB4AYBA5NVQPVPNOWUCSZQK6ZIGOF7KSCS6SF6UV6D2OKPDXLHEPD4V7',
  principalAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  tx: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
} as const;

export const signingRequest = {
  id: IDS.signing,
  network: NET,
  xdr: 'AAAAAgAAAAB=',
  signer: IDS.principalAddress,
  action: 'pause',
  summary: 'Pause the mandate',
  expiresAt: '2026-11-26T10:10:00.000Z',
};

export const mandate = {
  id: IDS.mandate,
  contractId: IDS.contract,
  network: NET,
  asset: 'USDC',
  status: 'active',
  depositAddress: IDS.contract,
  createdAt: '2026-11-20T09:00:00.000Z',
  config: {
    principal: IDS.principalAddress,
    agents: ['GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT'],
    // The chain names the owner as the approver when the mandate is created without one.
    approvers: [IDS.principalAddress],
    approvalsRequired: 1,
    executors: ['GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT'],
    limits: {
      totalBudget: usdc('50000000000'),
      perPaymentCap: usdc('5000000000'),
      perRecipientDailyCap: usdc('10000000000'),
      approvalThreshold: usdc('2500000000'),
      payoutTtlSeconds: 86400,
      expiresAt: '2027-02-20T09:00:00.000Z',
    },
  },
  state: {
    balance: usdc('20000000000'),
    committed: usdc('3000000000'),
    spent: usdc('1200000000'),
    pending: usdc('3000000000'),
    free: usdc('17000000000'),
    paused: false,
    revoked: false,
    expired: false,
  },
  // A field a later server adds; the console must keep working.
  label: 'Week 48 payouts',
};

export const recipient = {
  id: IDS.recipient,
  mandateId: IDS.mandate,
  label: 'Ada',
  address: 'GBT7...I3DT',
  status: 'active',
  payable: true,
  createdAt: '2026-11-20T09:05:00.000Z',
};

// One recipient's own page also carries the email, when there is one.
export const recipientDetail = { ...recipient, email: 'ada@example.com' };

export const embedSession = {
  id: IDS.invite,
  recipientId: IDS.recipient,
  createdAt: '2026-11-26T09:00:00.000Z',
  expiresAt: '2026-11-27T09:00:00.000Z',
  revokedAt: null,
};

export const payout = {
  id: IDS.payout,
  principalId: IDS.principal,
  projectId: IDS.project,
  mandate: { id: IDS.mandate, contractId: IDS.contract },
  recipient: { id: IDS.recipient, label: 'Ada' },
  taskId: 'task-42',
  amount: usdc('25000000'),
  fee: usdc('0'),
  status: 'paid',
  blockedBy: null,
  legs: [
    {
      index: 0,
      method: 'stellar.wallet',
      destination: 'GBT7...I3DT',
      amount: usdc('25000000'),
      status: 'paid',
      txHash: IDS.tx,
    },
  ],
  onChainPayoutId: 'f'.repeat(64),
  requestTxHash: IDS.tx,
  receiptId: IDS.receipt,
  createdAt: '2026-11-25T12:00:00.000Z',
  updatedAt: '2026-11-25T12:00:09.000Z',
  settledAt: '2026-11-25T12:00:09.000Z',
};

// Far past what a JavaScript number holds exactly, so only bigint keeps it.
const HUGE = '300000000000000000000000000000000000001';

export const pendingPayout = {
  ...payout,
  id: '8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a',
  taskId: 'task-43',
  amount: usdc(HUGE),
  status: 'pending_approval',
  legs: [{ ...payout.legs[0], amount: usdc(HUGE), status: 'pending_approval', txHash: null }],
  receiptId: null,
  settledAt: null,
};

export const receipt = {
  id: IDS.receipt,
  payoutId: IDS.payout,
  mandate: { id: IDS.mandate, contractId: IDS.contract },
  recipient: { id: IDS.recipient, label: 'Ada' },
  taskId: 'task-42',
  amount: usdc('25000000'),
  fee: usdc('0'),
  outcome: 'paid',
  blockedBy: null,
  txHash: IDS.tx,
  ref: `ujira:tx:v1:${NET}:${IDS.tx}:0`,
  issuedAt: '2026-11-25T12:00:10.000Z',
};

export const apiKey = {
  principalId: IDS.principal,
  projectId: IDS.project,
  id: IDS.runner,
  name: 'Payroll runner',
  prefix: 'ujk_test_m3qx7k2pa4bn5c6d',
  scopes: ['payouts:read', 'payouts:write'],
  expiresAt: '2027-11-24T08:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
  createdAt: '2026-11-24T08:00:00.000Z',
};

// The format the server issues, `ujk_<env>_<id>_<secret><checksum>`; never a real key.
export const apiKeySecret = `${apiKey.prefix}_${'a'.repeat(52)}${'b'.repeat(7)}`;

/** Each route's recorded answer, keyed by "METHOD path". */
export const RECORDED = {
  'GET /v1/mandates': { items: [mandate], nextCursor: 'eyJhZnRlciI6MX0' },
  'GET /v1/mandates/{id}': { mandate },
  'POST /v1/mandates/prepare': { signingRequest: { ...signingRequest, action: 'create' } },
  'POST /v1/mandates/import': { mandate },
  'POST /v1/mandates/{id}/actions': { signingRequest },
  'POST /v1/signing/submit': { txHash: IDS.tx, mandateId: null },
  'GET /v1/recipients': { items: [recipient], nextCursor: null },
  'GET /v1/recipients/{id}': { recipient: recipientDetail },
  'POST /v1/recipients': {
    recipient,
    signingRequest: { ...signingRequest, action: 'allow_recipients' },
  },
  'GET /v1/embed/sessions': { items: [embedSession], nextCursor: null },
  'POST /v1/embed/sessions': {
    session: embedSession,
    // A placeholder in the token's shape, not a token.
    token: `ujes_test_${'0'.repeat(48)}`,
  },
  'POST /v1/payouts': { payout },
  'GET /v1/payouts': { items: [payout, pendingPayout], nextCursor: null },
  'GET /v1/payouts/{id}': { payout },
  'GET /v1/approvals': { items: [pendingPayout], nextCursor: null },
  'GET /v1/receipts': { items: [receipt], nextCursor: null },
  'GET /v1/receipts/{id}': { receipt },
  'GET /v1/receipts/{id}/verify': { matched: true, field: null, txHash: IDS.tx },
  'GET /v1/api-keys': { items: [apiKey], nextCursor: null },
  'POST /v1/api-keys': { apiKey, secret: apiKeySecret },
  'DELETE /v1/api-keys/{id}': { apiKey: { ...apiKey, revokedAt: '2026-11-26T09:00:00.000Z' } },
  'GET /v1/stats/overview': {
    period: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-26T00:00:00.000Z' },
    paid: [usdc('1225000000')],
    byStatus: { paid: 12, pending_approval: 1, blocked: 2 },
    approvalsWaiting: 1,
  },
} as const;

export const RECEIPTS_CSV =
  'receipt_id,payout_id,task_id,recipient,amount,asset,outcome,blocked_by,tx_hash,issued_at\n' +
  `${IDS.receipt},${IDS.payout},task-42,Ada,2.5,USDC,paid,,${IDS.tx},2026-11-25T12:00:10.000Z\n`;
