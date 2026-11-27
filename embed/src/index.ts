// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The script tag entry point. Loading this file defines <ujira-onboarding>;
// nothing else is needed on the page.

import { TAG_NAME, UjiraOnboarding } from './onboarding-element.js';
import { registerFocusProperties } from './theme/theme.js';

export {
  TAG_NAME,
  UjiraOnboarding,
  COMPLETE_EVENT,
  STEP_CHANGE_EVENT,
} from './onboarding-element.js';
export type { CompleteDetail, StepChangeDetail, WidgetMode } from './onboarding-element.js';
export type { Answers, StepId, WalletChoice } from './steps.js';
export type { OnboardingClient } from './api/client.js';
export type { SignedMessage, WalletConnector } from './wallet.js';

/** Defines the element once, so two script tags on one page are harmless. */
export function define(): void {
  // Before the element renders: this keeps a focus value CSS cannot use from
  // taking the focus ring with it. A failure here, such as a page that
  // replaced CSS.registerProperty, costs that protection and nothing more,
  // so it is reported and the widget is defined anyway.
  try {
    registerFocusProperties();
  } catch (error) {
    report(error);
  }
  if (customElements.get(TAG_NAME) === undefined) {
    customElements.define(TAG_NAME, UjiraOnboarding);
  }
}

/** Hands an error to the page's error handlers without stopping this script. */
function report(error: unknown): void {
  // Typed as optional because some browsers the widget runs in predate it.
  const { reportError } = globalThis as { reportError?: (error: unknown) => void };
  if (reportError !== undefined) {
    reportError(error);
    return;
  }
  setTimeout(() => {
    throw error;
  });
}

define();

declare global {
  interface HTMLElementTagNameMap {
    [TAG_NAME]: UjiraOnboarding;
  }
}
