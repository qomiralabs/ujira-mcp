// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import type { MouseEvent, ReactNode } from 'react';

import { go } from '../app/hooks';
import { hrefFor } from '../app/routes';

/**
 * A link to a dashboard page. A plain click moves without a reload; a middle
 * click or a modifier key still opens the real URL in a new tab.
 */
export function Link({
  to,
  className,
  current = false,
  children,
}: {
  /** A dashboard path such as "/mandates". */
  to: string;
  className?: string;
  current?: boolean;
  children: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    go(to);
  };
  return (
    <a
      href={hrefFor(to)}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
    </a>
  );
}
