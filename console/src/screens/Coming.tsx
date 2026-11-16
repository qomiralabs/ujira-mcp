// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Pages for what is planned but not built yet. They stay in the menu and say
// so plainly, rather than hide.

import { explorerAccount, useApp } from '../app/context';
import { Link } from '../components/Link';
import { ComingSoon, Notice } from '../components/ui';

export function LocalCurrencyPage() {
  return (
    <div className="stack">
      <ComingSoon
        title="Local currency payouts"
        lede="Pay people in the money they spend: bank accounts, mobile money and cash pickup, through Stellar anchors. This comes after the testnet launch."
        items={[
          { title: 'Bank and mobile money', text: 'Naira, shillings, cedis and more.' },
          { title: 'Cash pickup', text: 'Collected at an agent near the recipient.' },
          { title: 'Funding by bank transfer', text: 'Top up a mandate without holding USDC.' },
        ]}
      >
        <p className="muted small">
          Today every payout is USDC to the recipient&apos;s Stellar wallet, or through the Stellar
          Disbursement Platform.
        </p>
      </ComingSoon>
    </div>
  );
}

export function TeamPage() {
  return (
    <div className="stack">
      <ComingSoon
        title="Team and keys"
        lede="Invite approvers who sign with a passkey, decide who can ask for payouts and who can approve them, and rotate keys safely."
        items={[
          { title: 'Passkey approvers', text: 'No seed phrases to lose.' },
          { title: 'Roles', text: 'Ask, approve and recover, each on its own key.' },
          { title: 'Rotation and recovery', text: 'Replace a lost key without a new mandate.' },
        ]}
      >
        <p className="muted small">
          Today the wallet that creates a mandate owns it and approves its big payouts.
        </p>
      </ComingSoon>
    </div>
  );
}

export function ActivityPage() {
  const { config, wallet } = useApp();
  return (
    <div className="stack">
      <ComingSoon
        title="Wallet activity"
        lede="Everything your wallet did on testnet in one list: setup, mandates, deposits and approvals, each with its transaction."
        items={[
          { title: 'One timeline', text: 'Every signature you gave, newest first.' },
          { title: 'Filters', text: 'By mandate, by kind, by date.' },
          { title: 'Export', text: 'A file of the whole history.' },
        ]}
      >
        <p className="small">
          Until then, <Link to="/receipts">receipts</Link> list every payout, and{' '}
          {wallet === null ? (
            'Stellar Expert shows any wallet in full.'
          ) : (
            <a href={explorerAccount(config, wallet.address)} target="_blank" rel="noreferrer">
              Stellar Expert shows your wallet in full
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
          .
        </p>
      </ComingSoon>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="stack narrow">
      <Notice tone="info" title="There is no page at this address">
        <p>
          It may have moved. <Link to="/">Go to the overview</Link>, or pick a page from the menu.
        </p>
      </Notice>
    </div>
  );
}
