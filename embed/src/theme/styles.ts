// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The widget's own styles, in the look of the recipient card on the landing
// page: a white card with a soft shadow, saffron progress marks, one dark
// action. Shadow DOM keeps them off the integrator's page and keeps the
// integrator's page off the widget, so everything that should be theirs to
// change is a custom property.
//
// Built for a 320px screen on a low end phone: one column, 48px controls,
// no images, no web font of our own.

import { css, type CSSResult } from 'lit';

import { hostTheme } from './theme.js';

const widget = css`
  * {
    box-sizing: border-box;
  }

  .widget {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 18px;
    background: var(--ujira-embed-surface);
    border: 1px solid var(--ujira-embed-rule);
    border-radius: var(--ujira-embed-radius-card);
    box-shadow: var(--ujira-embed-shadow);
    font-size: 16px;
    line-height: 1.5;
  }

  @container (min-width: 23rem) {
    .widget {
      padding: 22px;
    }
  }

  /*
   * Clamped where the values are spent: a zero width ring is no keyboard
   * focus indicator at all, on a flow where someone is typing the address
   * their money goes to. Thicker is the integrator's business; absent is
   * not. The outline is written as longhands so the style stands alone.
   */
  :focus-visible {
    outline-width: max(2px, var(--ujira-embed-focus-width));
    outline-style: solid;
    outline-color: var(--ujira-embed-focus);
    outline-offset: clamp(0px, var(--ujira-embed-focus-offset), 8px);
    box-shadow: 0 0 0 max(1px, var(--ujira-embed-focus-inner-width)) var(--ujira-embed-focus-inner);
  }

  .bars {
    display: flex;
    gap: 6px;
  }

  .bars i {
    flex: 1;
    height: 4px;
    border-radius: 999px;
    background: var(--ujira-embed-mark-track);
  }

  .bars i.on {
    background: var(--ujira-embed-mark);
  }

  .chrome {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 24px;
    margin-top: -6px;
  }

  .progress {
    margin: 0 0 0 auto;
    font-size: 13px;
    line-height: 1.3;
    color: var(--ujira-embed-text-secondary);
  }

  .step {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .heading {
    margin: 0;
    padding: 0;
    font-size: 22px;
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: -0.03em;
    color: var(--ujira-embed-text);
  }

  /* The heading takes focus only so a screen reader announces the new step. */
  .heading:focus {
    outline: none;
    box-shadow: none;
  }

  .hint {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ujira-embed-text-secondary);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .label {
    font-size: 15px;
    font-weight: 500;
    color: var(--ujira-embed-text);
  }

  /* 16px, so a phone never zooms the page when the field takes focus. */
  .input {
    width: 100%;
    min-height: 48px;
    padding: 12px 14px;
    font: 400 16px/1.4 var(--ujira-embed-font);
    color: var(--ujira-embed-text);
    background: var(--ujira-embed-field);
    border: 1px solid var(--ujira-embed-field-border);
    border-radius: var(--ujira-embed-radius-control);
  }

  .input[data-code] {
    font-family: var(--ujira-embed-font-mono);
  }

  .input:disabled {
    opacity: 0.7;
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .choice {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: start;
    gap: 2px 12px;
    min-height: 48px;
    padding: 13px 15px;
    background: var(--ujira-embed-surface);
    border: 1px solid var(--ujira-embed-field-border);
    border-radius: 16px;
    cursor: pointer;
  }

  /*
   * The chosen card takes the saffron edge of the landing page's method
   * card. The radio itself is native and goes from an empty circle to a
   * filled one, a change of shape, so the choice never rests on colour.
   */
  .choice:has(input:checked) {
    padding: 12px 14px;
    border: 2px solid var(--ujira-embed-mark);
  }

  .choice input {
    width: 20px;
    height: 20px;
    margin: 2px 0 0;
    accent-color: var(--ujira-embed-text);
  }

  .choice-name {
    font-weight: 600;
  }

  .choice-line {
    grid-column: 2;
    margin: 0;
    font-size: 14px;
    color: var(--ujira-embed-text-secondary);
  }

  .statement {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 14px;
    background: var(--ujira-embed-field);
    border-radius: var(--ujira-embed-radius-control);
  }

  .statement-label {
    font-size: 13px;
    color: var(--ujira-embed-text-secondary);
  }

  .statement-value {
    margin: 0;
    font: 400 14px/1.4 var(--ujira-embed-font-mono);
    overflow-wrap: anywhere;
  }

  .answer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 44px;
  }

  /* The message a wallet signs, shown whole so nothing has to scroll. */
  .sign-text {
    margin: 0;
    padding: 12px 14px;
    font: 400 14px/1.4 var(--ujira-embed-font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ujira-embed-text);
    background: var(--ujira-embed-field);
    border-radius: var(--ujira-embed-radius-control);
  }

  .primary {
    width: 100%;
    min-height: 48px;
    padding: 12px 20px;
    font: 500 17px/1.2 var(--ujira-embed-font);
    letter-spacing: -0.01em;
    color: var(--ujira-embed-on-accent);
    background: var(--ujira-embed-accent);
    border: 0;
    border-radius: var(--ujira-embed-radius-control);
    cursor: pointer;
    transition: background-color 300ms var(--ujira-embed-ease);
  }

  .primary:hover:not(:disabled) {
    background: var(--ujira-embed-accent-hover);
  }

  .primary:disabled {
    cursor: default;
    opacity: 0.7;
  }

  /*
   * The padding widens the target without moving the text: the negative
   * margin pulls the box back so the label sits flush with the card's
   * content. Back is a small word, and it is the control a person reaches
   * for after a mistake.
   */
  .text-button {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 8px;
    margin-inline: -8px;
    font: 500 14px/1.3 var(--ujira-embed-font);
    color: var(--ujira-embed-link);
    background: none;
    border: 0;
    cursor: pointer;
    text-align: start;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .alert {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px 14px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ujira-embed-error);
    border: 1px solid var(--ujira-embed-error);
    border-radius: var(--ujira-embed-radius-control);
  }

  .alert svg {
    flex: none;
    width: 20px;
    height: 20px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 14px;
    color: var(--ujira-embed-text-secondary);
  }

  .spinner {
    flex: none;
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 0;
    padding-top: 14px;
    font-size: 13px;
    color: var(--ujira-embed-text-secondary);
    border-top: 1px solid var(--ujira-embed-rule);
  }

  .footer svg {
    flex: none;
    width: 16px;
    height: 16px;
  }

  .footer .mark-dot {
    fill: var(--ujira-embed-mark);
  }

  @media (prefers-reduced-motion: reduce) {
    .primary {
      transition: none;
    }

    .spinner {
      animation: none;
      border-top-color: currentColor;
      opacity: 0.6;
    }
  }
`;

// Typed as the array it is, not as the wider group, so a test can read the
// stylesheet text without casting its way through a union.
export const widgetStyles: CSSResult[] = [hostTheme, widget];
