// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The signed in corner of the header: the organisation and the open project,
// and behind it the other projects, a new project, the wallet and sign out.

import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';

import { explorerAccount, useApp } from '../app/context';
import { useAction } from '../app/hooks';
import type { Session } from '../app/session';
import { checkName, type Principal, type Project } from '../lib/auth';
import { shortAddress } from '../lib/strkey';
import { WALLET_NAMES } from '../lib/wallet';
import { Icon, Spinner } from './ui';

/** Two letters for the organisation tile, from its first two words. */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  const letters =
    words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.trim().slice(0, 2);
  return letters.toUpperCase() || '?';
}

function NewProject({
  principal,
  onCreate,
  onDone,
}: {
  principal: Principal;
  onCreate: (principalId: string, name: string) => Promise<void>;
  onDone: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const action = useAction(async (name: string) => {
    await onCreate(principal.id, name);
    onDone();
  });
  useEffect(() => {
    input.current?.focus();
  }, []);
  const send = (e: SyntheticEvent) => {
    e.preventDefault();
    const checked = checkName(value, 'a project name');
    if (!checked.ok) {
      setInvalid(checked.error);
      return;
    }
    setInvalid(null);
    void action.run(checked.name);
  };
  const problem = invalid ?? action.error;
  return (
    <form className="session-new" onSubmit={send} noValidate>
      <label htmlFor={id} className="small">
        Project name
      </label>
      <input
        ref={input}
        id={id}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(null);
        }}
        aria-invalid={invalid !== null}
        aria-describedby={problem === null ? undefined : `${id}-error`}
        autoComplete="off"
        spellCheck={false}
      />
      {problem === null ? null : (
        <p className="error-text" id={`${id}-error`} role="alert">
          {problem}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn btn-small" onClick={onDone} disabled={action.busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-small" disabled={action.busy}>
          {action.busy ? <Spinner /> : null}
          {action.busy ? 'Creating' : 'Create'}
        </button>
      </div>
    </form>
  );
}

function ProjectGroup({
  principal,
  projects,
  current,
  onPick,
  onCreate,
}: {
  principal: Principal;
  projects: readonly Project[];
  current: Project;
  onPick: (id: string) => void;
  onCreate: (principalId: string, name: string) => Promise<void>;
}) {
  const id = useId();
  const [adding, setAdding] = useState(false);
  return (
    <div role="group" aria-labelledby={id} className="session-group">
      <p id={id} className="session-group-name">
        {principal.name}
      </p>
      <ul>
        {projects.map((p) => {
          const on = p.id === current.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                className="session-item"
                aria-current={on ? 'true' : undefined}
                onClick={() => {
                  onPick(p.id);
                }}
              >
                <span className="session-item-name">{p.name}</span>
                {on ? (
                  <>
                    <Icon name="check" size={16} />
                    <span className="sr-only"> (open)</span>
                  </>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <NewProject
          principal={principal}
          onCreate={onCreate}
          onDone={() => {
            setAdding(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="session-item session-add"
          onClick={() => {
            setAdding(true);
          }}
        >
          <Icon name="plus" size={16} />
          New project
          <span className="sr-only"> in {principal.name}</span>
        </button>
      )}
    </div>
  );
}

export function SessionMenu({ session }: { session: Session }) {
  const { config, wallet } = useApp();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const signOut = useAction(session.signOut);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && wrap.current?.contains(e.target) !== true) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const address = session.member.address;
  return (
    <div className="session" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="session-btn"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        <span className="session-tile" aria-hidden="true">
          {initials(session.principal.name)}
        </span>
        <span className="session-text">
          <span className="session-org">{session.principal.name}</span>
          <span className="session-project">{session.project.name}</span>
        </span>
        <Icon name="chevron" size={16} />
        <span className="sr-only">. Switch project or sign out</span>
      </button>
      <div id={menuId} className="session-pop" hidden={!open}>
        {session.principals.map((p) => (
          <ProjectGroup
            key={p.id}
            principal={p}
            projects={session.projects.filter((x) => x.principalId === p.id)}
            current={session.project}
            onPick={(id) => {
              session.selectProject(id);
              setOpen(false);
              button.current?.focus();
            }}
            onCreate={async (principalId, name) => {
              await session.createProject(principalId, name);
              setOpen(false);
              button.current?.focus();
            }}
          />
        ))}
        <div className="session-sep" aria-hidden="true" />
        <p className="session-who">
          <span className="wallet-dot" aria-hidden="true" />
          <a
            className="mono-link"
            href={explorerAccount(config, address)}
            target="_blank"
            rel="noreferrer"
            title={address}
          >
            {shortAddress(address)}
            <span className="sr-only">, your wallet, opens Stellar Expert</span>
          </a>
          <span className="muted">{wallet === null ? 'Signed in' : WALLET_NAMES[wallet.kind]}</span>
        </p>
        <button
          type="button"
          className="session-item"
          onClick={() => void signOut.run()}
          disabled={signOut.busy}
        >
          {signOut.busy ? <Spinner /> : <Icon name="power" size={16} />}
          {signOut.busy ? 'Signing out' : 'Sign out'}
        </button>
        {signOut.error === null ? null : (
          <p className="error-text session-error" role="alert">
            {signOut.error}
          </p>
        )}
      </div>
    </div>
  );
}
