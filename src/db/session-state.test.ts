// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { SessionStateError } from './errors.js';
import {
  assertNoSessionState,
  holdsSessionState,
  setConfigArguments,
  stripLiteralsAndComments,
} from './session-state.js';

describe('session state guard', () => {
  it.each([
    'set ujira.principal_id = $1',
    "SET ujira.principal_id TO 'x'",
    'set session ujira.scope = 1',
    'SET LOCAL ujira.principal_id = 1',
    'reset ujira.principal_id',
    'RESET ALL',
    "select set_config('ujira.principal_id', $1, false)",
    "select set_config('ujira.principal_id', $1, FALSE)",
    "select set_config('ujira.principal_id', $1, 'f')",
    'set role app',
    'SET ROLE NONE',
    'set session authorization app',
    'discard all',
    "alter role app set statement_timeout = '1s'",
    "alter database postgres set statement_timeout = '1s'",
    'set search_path = public',
    'set time zone utc',
    "set_config('ujira.principal_id', $1, false)",
  ])('refuses %s', (sql) => {
    expect(holdsSessionState(sql)).toBe(true);
    expect(() => {
      assertNoSessionState(sql);
    }).toThrow(SessionStateError);
  });

  it('refuses it whatever the spacing, case or comments around it', () => {
    for (const sql of [
      '  \n\t set   ujira.principal_id = 1',
      '/* comment */ set ujira.principal_id = 1',
      '-- leading line comment\nset ujira.principal_id = 1',
      'SeT uJiRa.principal_id = 1',
      "select 1; set ujira.principal_id = 'x'",
      "select set_config('ujira.principal_id',\n  $1,\n  false\n)",
    ]) {
      expect(holdsSessionState(sql), sql).toBe(true);
    }
  });

  it.each([
    'select 1',
    'select * from payout where id = $1',
    "select set_config('ujira.principal_id', $1, true)",
    "select set_config('ujira.principal_id', $1, TRUE)",
    "select set_config('ujira.txid', txid_current()::text, true)",
    'begin',
    'commit',
    'rollback',
    // Words that merely contain the banned ones.
    'select offset_reset from job',
    'select * from settings',
    "insert into audit (action) values ('reset')",
    "select 'set role app' as example",
  ])('allows %s', (sql) => {
    expect(holdsSessionState(sql)).toBe(false);
    expect(() => {
      assertNoSessionState(sql);
    }).not.toThrow();
  });

  it('names what it refused without quoting the statement', () => {
    let message = '';
    try {
      assertNoSessionState("set ujira.principal_id = 'p'");
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('session level');
    expect(message).not.toContain('ujira.principal_id');
  });

  it('treats a string literal holding a banned word as text, not as state', () => {
    // A literal cannot change session state, and refusing it would stop
    // legitimate writes such as an audit row that records the word.
    expect(holdsSessionState("insert into audit (sql) values ('set role app')")).toBe(false);
    // But a real statement after a literal is still caught.
    expect(holdsSessionState("insert into audit (sql) values ('x'); set role app")).toBe(true);
  });

  it('reads a quoted argument whatever is inside it', () => {
    // These exercise the literal reader: a doubled quote, a backslash
    // escape, a double quoted identifier and an unterminated literal, each
    // of which could otherwise end a scan in the wrong place.
    expect(holdsSessionState("select set_config('ujira.x', 'it''s fine', true)")).toBe(false);
    // Under standard_conforming_strings this literal ends at the second
    // quote, so what follows is not the argument list it looks like and the
    // call cannot be verified. The guard fails closed on that rather than
    // guessing.
    expect(holdsSessionState("select set_config('ujira.x', 'a\\'b', true)")).toBe(true);
    // Written as an E string, the quote really is escaped and the call reads
    // as intended.
    expect(holdsSessionState("select set_config('ujira.x', E'a\\'b', true)")).toBe(false);
    expect(holdsSessionState('select set_config("ujira.x", \'v\', true)')).toBe(false);
    expect(holdsSessionState("select set_config('ujira.x', 'unterminated")).toBe(true);
    // A doubled quote inside the third argument still has to be a local flag.
    expect(holdsSessionState("select set_config('ujira.x', 'v', 'f''alse')")).toBe(true);
  });

  it('counts the arguments, so a call with the wrong shape is refused', () => {
    expect(setConfigArguments("select set_config('a', 'b', true)")).toEqual([
      ["'a'", "'b'", 'true'],
    ]);
    expect(holdsSessionState("select set_config('ujira.x', 'v')")).toBe(true);
    expect(holdsSessionState('select set_config()')).toBe(true);
    // Two calls, one of them session scoped.
    expect(
      holdsSessionState(
        "select set_config('ujira.a', 'v', true), set_config('ujira.b', 'v', false)",
      ),
    ).toBe(true);
  });

  it('strips a nested block comment without losing what follows', () => {
    expect(stripLiteralsAndComments('/* a /* b */ c */ set x = 1')).toContain('set x = 1');
    expect(holdsSessionState('/* a /* b */ c */ set ujira.principal_id = 1')).toBe(true);
    // An unterminated comment runs to the end, as Postgres reads it.
    expect(holdsSessionState('/* unterminated set ujira.principal_id = 1')).toBe(false);
  });

  it('refuses a set inside a dollar quoted body, even as a bare literal', () => {
    // This expectation changed direction after code review proved a tenant
    // key set inside a dollar quoted body survived the transaction. Nothing
    // here can tell an executed body from a string that looks like one, so
    // both are refused: a false refusal is a review conversation, a false
    // pass is a tenant leak.
    expect(holdsSessionState('$$ set ujira.principal_id = 1 $$')).toBe(true);
  });
});

describe('spellings that got past the first version of this guard', () => {
  // Measured by security review. Each one changes session state, and each
  // failed in the miss direction: the guard said it was safe.
  it.each([
    ['a quoted tenant key', 'set "ujira.principal_id" = \'p\''],
    ['a quoted tenant key with session', 'set session "ujira.principal_id" = \'p\''],
    ['a quoted role', 'set "role" = \'app\''],
    ['a quoted session authorization', 'set "session_authorization" = \'app\''],
    ['a reset of a quoted tenant key', 'reset "ujira.principal_id"'],
  ])('refuses %s, because a double quote delimits an identifier, not a string', (_name, sql) => {
    expect(holdsSessionState(sql)).toBe(true);
  });

  it('refuses a statement after a literal that ends in a backslash', () => {
    // With standard_conforming_strings on, which is the default, Postgres
    // ends this literal at the second quote. Treating the backslash as an
    // escape ran the scan past the end of the statement and missed what
    // followed.
    expect(holdsSessionState("select 'a\\'; set ujira.principal_id = 'p'")).toBe(true);
    expect(holdsSessionState("insert into t (c) values ('x\\'); reset all")).toBe(true);
  });

  it('still reads a backslash escape inside an E string, where Postgres does', () => {
    // E'...' keeps backslash escapes, so there the quote really is escaped
    // and the literal continues.
    expect(holdsSessionState("select E'a\\'' as escaped")).toBe(false);
    expect(holdsSessionState("select e'a\\'' as escaped")).toBe(false);
  });

  it('keeps an identifier readable rather than blanking it', () => {
    expect(stripLiteralsAndComments('select "ujira.principal_id" from t')).toContain(
      'ujira.principal_id',
    );
    // A string literal is still blanked, so a banned word inside one is text.
    expect(stripLiteralsAndComments("select 'set role app' from t")).not.toContain('set role');
  });
});

describe('the three forms code review proved against a live server', () => {
  // Each left the tenant key set after the transaction committed, with the
  // guard allowing the statement. Each gets its own case so a later rewrite
  // of the scanner cannot quietly drop one.
  it('refuses a quoted tenant key assignment', () => {
    expect(holdsSessionState('set "ujira.principal_id" = \'attacker\'')).toBe(true);
  });

  it('refuses a quoted function name', () => {
    expect(holdsSessionState("select \"set_config\"('ujira.principal_id','attacker',false)")).toBe(
      true,
    );
  });

  it('refuses a dollar quoted body that sets a tenant key', () => {
    expect(
      holdsSessionState(
        "do $$ begin perform set_config('ujira.principal_id','attacker',false); end $$",
      ),
    ).toBe(true);
  });

  it('refuses a tagged dollar quoted body too', () => {
    expect(
      holdsSessionState(
        "do $body$ begin perform set_config('ujira.principal_id','attacker',false); end $body$",
      ),
    ).toBe(true);
  });

  it('refuses a session level set inside a dollar quoted body', () => {
    expect(holdsSessionState('do $$ begin set role app; end $$')).toBe(true);
  });
});

describe('the type prefixed literal code review proved live', () => {
  // Postgres accepts a type name immediately followed by a literal, and
  // some type names end in the letter e. An escape rule that looked only at
  // the character before the quote read `name'` as an E string, ran past
  // the literal's real end and swallowed the injected statement. The
  // tenant key was still set after the commit.
  it.each([
    "select name'a\\'; set ujira.principal_id = 'attacker'",
    "select varchar'a\\'; set ujira.principal_id = 'attacker'",
    "select bytea'a\\'; reset all",
    "select date'a\\'; set role app",
  ])('refuses %s', (sql) => {
    expect(holdsSessionState(sql)).toBe(true);
  });

  it('still allows a genuine escape string, where the backslash does escape', () => {
    expect(holdsSessionState("select E'a\\'' as escaped")).toBe(false);
    expect(holdsSessionState("select e'a\\'' as escaped")).toBe(false);
    // An E that is part of a longer word is not an escape string prefix.
    expect(holdsSessionState("select table'a\\'; set role app")).toBe(true);
  });
});

describe("an update's set clause", () => {
  // The SET of an UPDATE assigns columns of a row and changes nothing about
  // the session. The guard read it as a session level SET, so every update
  // the query layer sent was refused, which the tenant context tests found.
  it.each([
    'update ujira.notes set principal_id = $1, project_id = $2 where body = $3',
    'update "ujira"."notes" set "body" = $1 where "id" = $2',
    'update only ujira.notes set body = $1',
    'update ujira.notes as n set body = $1 from ujira.other o where o.id = n.id',
    'update ujira.notes n set body = $1',
    'insert into ujira.notes (id, body) values ($1, $2) on conflict (id) do update set body = excluded.body',
    'with moved as (update ujira.notes set body = $1 returning id) select id from moved',
  ])('allows %s', (sql) => {
    expect(holdsSessionState(sql)).toBe(false);
  });

  it.each([
    "update ujira.notes set body = 'x'; set ujira.principal_id = 'attacker'",
    "update ujira.notes set body = 'x'; set role app",
    "insert into ujira.notes values (1) on conflict do nothing; set ujira.scope = 'all'",
    "select 1 from updates set_x; set ujira.principal_id = 'attacker'",
  ])('still refuses a session set that follows one: %s', (sql) => {
    expect(holdsSessionState(sql)).toBe(true);
  });
});
