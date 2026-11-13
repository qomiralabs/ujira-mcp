// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Turns the brand colour tokens into CSS custom properties, so no colour is
// typed by hand anywhere in the console. The build serves the result as the
// virtual module "virtual:ujira-tokens.css".

export interface BrandTokens {
  readonly core: Readonly<Record<string, string>>;
  readonly neutral: Readonly<Record<string, string>>;
  readonly status: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly modes: Readonly<Record<'light' | 'dark', Readonly<Record<string, string>>>>;
}

function block(selector: string, vars: readonly [string, string][]): string {
  const lines = vars.map(([k, v]) => (k === 'color-scheme' ? `  ${k}: ${v};` : `  --${k}: ${v};`));
  return `${selector} {\n${lines.join('\n')}\n}\n`;
}

function modeVars(
  mode: Readonly<Record<string, string>>,
  scheme: 'light' | 'dark',
): [string, string][] {
  const vars: [string, string][] = Object.entries(mode)
    .filter(([k]) => k !== 'logo')
    .map(([k, v]) => [k, v]);
  vars.push(['color-scheme', scheme]);
  return vars;
}

export function tokensToCss(tokens: BrandTokens): string {
  const shared: [string, string][] = [
    ...Object.entries(tokens.core),
    ...Object.entries(tokens.neutral),
    ...Object.entries(tokens.status).flatMap(([name, shades]) =>
      Object.entries(shades).map(([shade, v]): [string, string] => [`status-${name}-${shade}`, v]),
    ),
  ];
  const light = modeVars(tokens.modes.light, 'light');
  const dark = modeVars(tokens.modes.dark, 'dark');
  return [
    block(':root', [...shared, ...light]),
    block(':root[data-theme="dark"]', dark),
    `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme="light"])', dark)
      .split('\n')
      .map((l) => (l === '' ? l : `  ${l}`))
      .join('\n')}}\n`,
  ].join('\n');
}
