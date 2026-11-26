// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Session level state is banned on pooled connections. The Supabase spike
// measured a session level setting on one client being read by another
// client on the same backend, which is a tenant leak, and the transaction
// pooler hands the same backend to anyone. Everything this module runs is
// transaction local, so any statement that would outlive its transaction is
// refused before it is sent.
//
// This is a guard, not a parser. Statement forms are matched with string
// literals and comments removed, so a banned word inside a literal stays
// text and cannot trip it. Double quoted identifiers keep their text,
// because the identifier is what the patterns need to read after the
// keyword, and dollar quoted bodies are scanned rather than blanked,
// because such a body can be executed. set_config is read with literals
// kept, because its third argument decides the scope and is usually a
// literal.

import { SessionStateError } from './errors.js';

// Whether the literal starting at the next quote takes backslash escapes.
// Only an E immediately before the quote, as a token of its own, does that:
// E'a\\'b' continues past the escaped quote, while 'a\\' ends at the second
// quote under standard_conforming_strings.
//
// The character class is not optional, and that matters. With it optional,
// any identifier ending in the letter e satisfied the rule, and Postgres
// accepts a type name immediately followed by a literal, so `select
// name'a\\'; set ujira.principal_id = 'attacker'` was read as an escape
// string, the scan ran past the literal's real end and swallowed the
// injected statement. Code review proved that live.
//
// blank() and setConfigArguments both decide this same question, so they
// use this one expression. They are read together: a rule written twice is
// a rule that diverges.
const ESCAPE_STRING_PREFIX = /(?:^|[^a-z0-9_$])[eE]$/i;

function takesBackslashEscapes(before: string): boolean {
  return ESCAPE_STRING_PREFIX.test(before.trimEnd());
}

// Statement forms that change state beyond the current transaction. SET
// LOCAL is included: it is transaction local and so harmless, but context
// here travels through set_config, and a second spelling would be a second
// thing to keep right.
const BANNED: readonly RegExp[] = [
  /\bset\s+(?:session\s+authorization\b|session_authorization\b|session\b|local\b|role\b|time\s+zone\b|[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?\s*(?:=|\bto\b))/,
  /\breset\s+(?:all\b|[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)/,
  /\bdiscard\s+[a-z]+/,
  /\balter\s+(?:role|user|database)\b[\s\S]*?\bset\b/,
];

// Third arguments that make a set_config call transaction local. Anything
// else, a bind parameter included, is refused: the value of a parameter is
// not known here, and the local flag is what keeps a tenant out of the next
// transaction on the same backend.
const LOCAL_FLAGS: ReadonlySet<string> = new Set(['true', "'true'", "'t'", "'on'", "'yes'", "'1'"]);

interface Replace {
  readonly literals: boolean;
}

// Walks the SQL, replacing comments, and optionally string literals and
// dollar quoted bodies, with a space. An unterminated quote or comment runs
// to the end, as Postgres reads it, so nothing after one hides from a scan.
function blank(sql: string, { literals }: Replace): string {
  let out = '';
  let at = 0;
  while (at < sql.length) {
    const char = sql[at] ?? '';
    // A dollar quoted body is not inert. DO runs it, CREATE FUNCTION stores
    // it to run later, and code review proved a tenant key set inside one
    // survived the transaction. Nothing here can tell an executed body from
    // a string that merely looks like one, so the content is scanned and a
    // body holding a banned statement is refused. That refuses a literal
    // that only quotes such a statement too, which is the direction to err
    // in: a false refusal is a review conversation, a false pass is a
    // tenant leak.
    const dollar = /^\$([a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(at));
    if (dollar !== null) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, at + tag.length);
      const body = sql.slice(at + tag.length, close === -1 ? sql.length : close);
      at = close === -1 ? sql.length : close + tag.length;
      out += ` ${blank(body, { literals })} `;
      continue;
    }
    if (char === '-' && sql[at + 1] === '-') {
      const end = sql.indexOf('\n', at);
      at = end === -1 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (char === '/' && sql[at + 1] === '*') {
      let depth = 1;
      at += 2;
      while (at < sql.length && depth > 0) {
        if (sql[at] === '/' && sql[at + 1] === '*') {
          depth += 1;
          at += 2;
        } else if (sql[at] === '*' && sql[at + 1] === '/') {
          depth -= 1;
          at += 2;
        } else {
          at += 1;
        }
      }
      out += ' ';
      continue;
    }
    // A double quote delimits an identifier, not a string, and the
    // identifier is what the patterns below need to read: `set
    // "ujira.principal_id" = ...` is a session level SET of a tenant key.
    // The quotes are dropped and the name is kept.
    //
    // The trade, the same one the dollar quoted bodies carry: a quoted
    // identifier is now read as code, so selecting a column whose name
    // happens to contain a banned phrase is refused although it is valid
    // and leaks nothing. Rename the column, or quote the whole statement
    // out of this layer. Blanking identifiers instead was the bug.
    if (char === '"') {
      at += 1;
      while (at < sql.length) {
        if (sql[at] === '"') {
          // Two in a row are an escaped quote inside the identifier.
          if (sql[at + 1] === '"') {
            out += '"';
            at += 2;
            continue;
          }
          at += 1;
          break;
        }
        out += sql[at] ?? '';
        at += 1;
      }
      continue;
    }
    if (literals && char === "'") {
      // See takesBackslashEscapes above: only a standalone E prefix makes
      // backslashes escape.
      const escapes = takesBackslashEscapes(out);
      at += 1;
      while (at < sql.length) {
        if (sql[at] === "'") {
          if (sql[at + 1] === "'") {
            at += 2;
            continue;
          }
          at += 1;
          break;
        }
        if (escapes && sql[at] === '\\') {
          at += 2;
          continue;
        }
        at += 1;
      }
      out += ' ';
      continue;
    }
    out += char;
    at += 1;
  }
  return out;
}

export function stripLiteralsAndComments(sql: string): string {
  return blank(sql, { literals: true });
}

// Reads one quoted literal starting at `from`, returning it with its quotes.
function readQuoted(sql: string, from: number, escapes = false): { text: string; next: number } {
  const quote = sql[from] ?? "'";
  let text = quote;
  let at = from + 1;
  while (at < sql.length) {
    const char = sql[at] ?? '';
    text += char;
    if (char === quote) {
      if (sql[at + 1] === quote) {
        text += quote;
        at += 2;
        continue;
      }
      at += 1;
      break;
    }
    // Backslash escapes exist only in an E string; see blank() above.
    if (quote === "'" && char === '\\' && escapes) {
      text += sql[at + 1] ?? '';
      at += 2;
      continue;
    }
    at += 1;
  }
  return { text, next: at };
}

// The arguments of every set_config call in the statement, split at the top
// level so a nested call or a comma inside a literal stays with its argument.
export function setConfigArguments(sql: string): string[][] {
  const calls: string[][] = [];
  const pattern = /\bset_config\s*\(/giu;
  let match = pattern.exec(sql);
  while (match !== null) {
    let at = match.index + match[0].length;
    let depth = 1;
    let current = '';
    const args: string[] = [];
    while (at < sql.length && depth > 0) {
      const char = sql[at] ?? '';
      if (char === "'" || char === '"') {
        // The same question as in blank(), answered by the same expression.
        const escapes = char === "'" && takesBackslashEscapes(current);
        const quoted = readQuoted(sql, at, escapes);
        current += quoted.text;
        at = quoted.next;
        continue;
      }
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          at += 1;
          break;
        }
      } else if (char === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
        at += 1;
        continue;
      }
      current += char;
      at += 1;
    }
    args.push(current.trim());
    calls.push(args);
    pattern.lastIndex = at;
    match = pattern.exec(sql);
  }
  return calls;
}

// True when any set_config call is not plainly transaction local.
function hasSessionScopedSetConfig(sql: string): boolean {
  return setConfigArguments(sql).some((args) => {
    if (args.length !== 3) return true;
    return !LOCAL_FLAGS.has((args[2] ?? '').toLowerCase());
  });
}

// The SET of an UPDATE, and of ON CONFLICT DO UPDATE, assigns columns of a
// row and changes nothing about the session, but reads exactly like a SET
// statement to the first pattern above: `update t set body = $1` was refused.
// These forms are taken out before the patterns run. Only the keyword that
// belongs to the update goes, so a real SET statement after it, in the same
// string, is still read and refused.
const UPDATE_SET_CLAUSES: readonly RegExp[] = [
  /\bupdate\s+(?:only\s+)?[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?\s*\*?(?:\s+(?:as\s+)?(?!set\b)[a-z_][a-z0-9_$]*)?\s+set\b/g,
  /\bdo\s+update\s+set\b/g,
];

function withoutUpdateSetClauses(sql: string): string {
  return UPDATE_SET_CLAUSES.reduce((text, pattern) => text.replace(pattern, ' update '), sql);
}

// True when the statement would change state that outlives its transaction.
export function holdsSessionState(sql: string): boolean {
  const code = withoutUpdateSetClauses(stripLiteralsAndComments(sql).toLowerCase());
  if (BANNED.some((pattern) => pattern.test(code))) {
    return true;
  }
  return hasSessionScopedSetConfig(blank(sql, { literals: false }));
}

// Throws when the statement would change session state. The statement is
// not repeated in the message: it can carry a tenant identifier, and the
// caller knows what it passed.
export function assertNoSessionState(sql: string): void {
  if (holdsSessionState(sql)) {
    throw new SessionStateError(
      'refused: the statement changes session level state, which leaks across pooled connections; send transaction local context instead',
    );
  }
}
