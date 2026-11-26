// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The words a recipient reads. The method is named once, as "USDC to your
// Stellar wallet"; beyond that phrase there is no currency, network or chain
// wording at all. And no word is typed into a template: every one comes from
// en.ts, so a translator has one place to work.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { en } from './en.js';

const METHOD = 'USDC to your Stellar wallet';

const CHAIN_WORDS =
  /\b(?:usdc|usd coin|stellar|xlm|lumens?|tokens?|crypto\w*|blockchain|chain|on-?chain|trustline|transaction|hash|stablecoin|anchor|sep-?\d+|network|ledger|soroban|contract|mandate|testnet|mainnet)\b/i;

function beyondTheMethod(text: string): string {
  return text.split(METHOD).join(' ');
}

const SRC = join(import.meta.dirname, '..');

function templateFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return templateFiles(path);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return /\b(?:html|svg)`/.test(readFileSync(path, 'utf8')) ? [path] : [];
  });
}

/** Stands for an interpolation, so `aria-label=${label}` passes and `aria-label="Close"` does not. */
const MARKER = String.fromCharCode(0xe000);
const SPOKEN = new RegExp(
  String.raw`\b(?:aria-label|aria-description|placeholder|title|alt)=["']?[^"'\s>${MARKER}]`,
  'i',
);

/** Words typed straight into an html`` or svg`` template, outside any tag. */
function typedWords(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag.getText(tree);
      const template = node.template;
      if (tag === 'html' || tag === 'svg') {
        const parts = ts.isNoSubstitutionTemplateLiteral(template)
          ? [template.text]
          : [template.head.text, ...template.templateSpans.map((span) => span.literal.text)];
        const joined = parts.join(MARKER);
        const where = `${relative(SRC, file)}:${String(
          tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        )}`;
        if (SPOKEN.test(joined)) found.push(`${where} a spoken attribute is typed in`);
        const outsideTags = joined.replace(/<[^>]*>/g, ' ');
        if (/[A-Za-z]{2,}/.test(outsideTags)) found.push(`${where} ${outsideTags.trim()}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

describe('copy', () => {
  it('names the method "USDC to your Stellar wallet" on the first step and at the end', () => {
    expect(en['wallet.hint']).toContain(METHOD);
    expect(en['done.body']).toContain(METHOD);
  });

  it('has no currency, network or chain words beyond that phrase', () => {
    const offenders = Object.entries(en).filter(([, value]) =>
      CHAIN_WORDS.test(beyondTheMethod(value)),
    );
    expect(offenders).toEqual([]);
  });

  it('would catch a chain word if one slipped in', () => {
    expect(CHAIN_WORDS.test(beyondTheMethod('Add USDC in your wallet'))).toBe(true);
    expect(CHAIN_WORDS.test(beyondTheMethod('Your Stellar address'))).toBe(true);
    expect(CHAIN_WORDS.test(beyondTheMethod('Add a trustline and some XLM'))).toBe(true);
    expect(CHAIN_WORDS.test(beyondTheMethod(`Payouts arrive as ${METHOD}.`))).toBe(false);
  });

  it('says Payouts by UJIRA in the footer', () => {
    expect(en['footer.byline']).toBe('Payouts by UJIRA');
  });

  it('says "paid", never "sent funds" or "transferred", and never calls people users', () => {
    const offenders = Object.entries(en).filter(([, value]) =>
      /\b(?:sent funds|transferred|users?|workers?)\b/i.test(value),
    );
    expect(offenders).toEqual([]);
  });

  it('uses no em or en dash', () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    const offenders = Object.entries(en).filter(([, value]) => dashes.test(value));
    expect(offenders).toEqual([]);
  });

  it('is never typed into a template', () => {
    const files = templateFiles(SRC);
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.flatMap(typedWords)).toEqual([]);
  });
});
