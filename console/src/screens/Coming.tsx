// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Pages for what is planned but not built yet. They stay in the menu and say
// so plainly, rather than hide.

import { explorerAccount, useApp } from '../app/context';
import { Link } from '../components/Link';
import { ComingSoon, Empty, Icon } from '../components/ui';

export function LocalCurrencyPage() {
  return (
    <div className="stack narrow">
      <ComingSoon
        title="Local currency payouts"
        lede="Bank, mobile money and cash through Stellar anchors. Today: USDC or SDP."
        items={['Bank and mobile money', 'Cash pickup', 'Funding by bank transfer']}
      />
    </div>
  );
}

export function TeamPage() {
  return (
    <div className="stack narrow">
      <ComingSoon
        title="Team and keys"
        lede="Approvers with passkeys, roles and safe key rotation. Today: the owner wallet approves."
        items={['Passkey approvers', 'Roles', 'Rotation and recovery']}
      />
    </div>
  );
}

export function ActivityPage() {
  const { config, wallet } = useApp();
  return (
    <div className="stack narrow">
      <ComingSoon
        title="Wallet activity"
        lede="Every signature your wallet gave, in one timeline."
        items={['One timeline', 'Filters', 'Export']}
      >
        <p className="small">
          For now: <Link to="/receipts">receipts</Link>
          {wallet === null ? null : (
            <>
              {' '}
              or{' '}
              <a href={explorerAccount(config, wallet.address)} target="_blank" rel="noreferrer">
                Stellar Expert
                <span className="sr-only"> (opens your wallet in a new tab)</span>
              </a>
            </>
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
      <section className="card">
        <Empty
          text="There is no page at this address."
          action={
            <Link to="/" className="btn btn-primary btn-small">
              <Icon name="home" size={16} />
              Go to the overview
            </Link>
          }
        />
      </section>
    </div>
  );
}
