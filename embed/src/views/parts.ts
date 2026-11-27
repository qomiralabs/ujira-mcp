// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The small pieces every step is built from. Each one takes the words it
// shows as an argument: the copy itself only ever comes from a language file.

import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from 'lit';

export const FIELD_ID = 'answer';
export const HINT_ID = 'answer-hint';
export const ALERT_ID = 'answer-problem';

/** 24px grid, 1.5px stroke, round ends, the same grid as the brand icons. */
export function alertIcon(): SVGTemplateResult {
  return svg`<circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5" />
    <path d="M12 16.25h0.01" />`;
}

/** The problem with the last answer, or nothing when there is none. */
export function alertBlock(message: string): TemplateResult | typeof nothing {
  if (message === '') return nothing;
  return html`<div class="alert" id=${ALERT_ID} role="alert">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      ${alertIcon()}
    </svg>
    <span>${message}</span>
  </div>`;
}

/** Shown while an answer is being saved, or a wallet is signing. */
export function busyBlock(label: string, busy: boolean): TemplateResult | typeof nothing {
  if (!busy) return nothing;
  return html`<p class="status" role="status">
    <span class="spinner" aria-hidden="true"></span>
    <span>${label}</span>
  </p>`;
}

export interface PrimaryAction {
  label: string;
  busy: boolean;
}

/** The one action that moves the step on. One per screen. */
export function primaryAction({ label, busy }: PrimaryAction): TemplateResult {
  return html`<button class="primary" type="submit" ?disabled=${busy} aria-busy=${busy}>
    ${label}
  </button>`;
}

export interface TextButtonOptions {
  /** What the control says on screen. */
  label: string;
  /**
   * What it says to a screen reader, when the row it sits in supplies the
   * rest of the meaning. It always starts with the visible label, so the two
   * never contradict each other. "Back" can be one word on screen because
   * the progress it acts on sits beside it; moved away from that row, the
   * visible word has to grow to carry the meaning on its own.
   */
  name?: string;
  press: () => void;
}

export function textButton({ label, name, press }: TextButtonOptions): TemplateResult {
  return html`<button
    class="text-button"
    type="button"
    aria-label=${name ?? nothing}
    @click=${press}
  >
    ${label}
  </button>`;
}

export interface TextFieldOptions {
  label: string;
  hint: string;
  value: string;
  invalid: boolean;
  disabled: boolean;
  /** Codes and addresses are shown in the mono face, like every other code. */
  code: boolean;
  inputMode: 'text' | 'numeric';
  autocomplete: string;
  change: (value: string) => void;
  /** For a second field on the same step. The first is always the answer. */
  id?: string;
}

export function textField(options: TextFieldOptions): TemplateResult {
  const id = options.id ?? FIELD_ID;
  const hintId = id === FIELD_ID ? HINT_ID : `${id}-hint`;
  const describedBy = options.invalid ? `${hintId} ${ALERT_ID}` : hintId;
  return html`<div class="field">
    <label class="label" for=${id}>${options.label}</label>
    <p class="hint" id=${hintId}>${options.hint}</p>
    <input
      class="input"
      id=${id}
      name=${id}
      type="text"
      .value=${options.value}
      ?disabled=${options.disabled}
      ?data-code=${options.code}
      inputmode=${options.inputMode}
      autocomplete=${options.autocomplete}
      autocapitalize="off"
      spellcheck="false"
      aria-invalid=${options.invalid ? 'true' : 'false'}
      aria-describedby=${describedBy}
      enterkeyhint="go"
      @input=${(event: Event) => {
        const input = event.target;
        if (input instanceof HTMLInputElement) options.change(input.value);
      }}
    />
  </div>`;
}
