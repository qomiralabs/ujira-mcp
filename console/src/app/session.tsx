// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Who is signed in and which project is open. Signed out, every page shows
// the sign in screen; signed in, the person lands in the project they opened
// last. The session is a cookie the browser keeps; nothing here is a secret.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { errorMessage } from '../lib/api';
import {
  isSessionInvalid,
  pickProject,
  rememberProject,
  type AuthApi,
  type Member,
  type Principal,
  type Project,
  type SessionInfo,
} from '../lib/auth';
import { rememberWallet, type Wallet } from '../lib/wallet';
import {
  AuthFrame,
  FirstProject,
  NameOrganisation,
  SessionProblem,
  SignInScreen,
} from '../screens/SignIn';
import { Skeleton } from '../components/ui';
import { useApp } from './context';

export interface Session {
  readonly member: Member;
  readonly principals: readonly Principal[];
  readonly projects: readonly Project[];
  readonly project: Project;
  /** The organisation the open project belongs to. */
  readonly principal: Principal;
  selectProject: (projectId: string) => void;
  createProject: (principalId: string, name: string) => Promise<void>;
  /** Ends the session on the server, then forgets the wallet and every loaded page. */
  signOut: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

/** The signed in session, or null when the console runs without sign in. */
export function useSession(): Session | null {
  return useContext(SessionContext);
}

type Phase =
  | { readonly kind: 'checking' }
  | { readonly kind: 'check-failed'; readonly error: string }
  | { readonly kind: 'signed-out'; readonly notice: string | null }
  | { readonly kind: 'naming'; readonly info: SessionInfo }
  | { readonly kind: 'loading-projects'; readonly info: SessionInfo }
  | { readonly kind: 'projects-failed'; readonly info: SessionInfo; readonly error: string }
  | { readonly kind: 'no-projects'; readonly info: SessionInfo }
  | {
      readonly kind: 'ready';
      readonly info: SessionInfo;
      readonly projects: readonly Project[];
      readonly projectId: string;
    };

const ENDED = 'Your session has ended. Sign in again.';

export function SessionGate({ auth, children }: { auth: AuthApi; children: ReactNode }) {
  const { setWallet, notify } = useApp();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  // A new session gets a fresh tree, so nothing loaded for the last one survives.
  const [generation, setGeneration] = useState(0);
  const live = useRef(true);
  const focusShell = useRef(false);
  // Only the newest load may move the screen on; an older answer is dropped.
  const seq = useRef(0);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const set = useCallback((p: Phase) => {
    if (live.current) setPhase(p);
  }, []);

  const lost = useCallback(
    (error: unknown, otherwise: (message: string) => Phase) => {
      set(
        isSessionInvalid(error)
          ? { kind: 'signed-out', notice: ENDED }
          : otherwise(errorMessage(error)),
      );
    },
    [set],
  );

  const open = useCallback(
    (info: SessionInfo, projects: readonly Project[], chosen: Project) => {
      auth.useProject(chosen.id);
      rememberProject(info.member.id, chosen.id);
      set({ kind: 'ready', info, projects, projectId: chosen.id });
    },
    [auth, set],
  );

  const loadProjects = useCallback(
    async (info: SessionInfo) => {
      const n = ++seq.current;
      set({ kind: 'loading-projects', info });
      try {
        const projects = await auth.projects();
        if (n !== seq.current) return;
        const chosen = pickProject(projects, info.member.id);
        if (chosen === null) set({ kind: 'no-projects', info });
        else open(info, projects, chosen);
      } catch (error) {
        if (n !== seq.current) return;
        lost(error, (message) => ({ kind: 'projects-failed', info, error: message }));
      }
    },
    [auth, lost, open, set],
  );

  const enter = useCallback(
    (info: SessionInfo) => {
      if (info.principals.length === 0) set({ kind: 'naming', info });
      else void loadProjects(info);
    },
    [loadProjects, set],
  );

  const check = useCallback(async () => {
    const n = ++seq.current;
    set({ kind: 'checking' });
    try {
      const info = await auth.me();
      if (n === seq.current) enter(info);
    } catch (error) {
      if (n !== seq.current) return;
      // No session on arrival is the normal signed out state, not a lost one.
      if (isSessionInvalid(error)) set({ kind: 'signed-out', notice: null });
      else set({ kind: 'check-failed', error: errorMessage(error) });
    }
  }, [auth, enter, lost, set]);

  useEffect(() => {
    void check();
  }, [check]);

  const forget = useCallback(
    (notice: string) => {
      // A load still in flight must not reopen the dashboard.
      seq.current += 1;
      auth.useProject(null);
      rememberWallet(null);
      setWallet(null);
      setGeneration((g) => g + 1);
      set({ kind: 'signed-out', notice });
    },
    [auth, set, setWallet],
  );

  const signOut = useCallback(async () => {
    await auth.endSession();
    forget('You are signed out.');
    notify('Signed out');
  }, [auth, forget, notify]);

  const signedIn = useCallback(
    (info: SessionInfo, wallet: Wallet) => {
      rememberWallet(wallet);
      setWallet(wallet);
      focusShell.current = true;
      enter(info);
    },
    [enter, setWallet],
  );

  const createPrincipal = useCallback(
    async (info: SessionInfo, name: string) => {
      try {
        const created = await auth.createPrincipal(name);
        focusShell.current = true;
        open(
          { ...info, principals: [...info.principals, created.principal] },
          [created.project],
          created.project,
        );
      } catch (error) {
        if (isSessionInvalid(error)) set({ kind: 'signed-out', notice: ENDED });
        throw error;
      }
    },
    [auth, open, set],
  );

  const firstProject = useCallback(
    async (info: SessionInfo, principalId: string, name: string) => {
      try {
        const project = await auth.createProject(principalId, name);
        focusShell.current = true;
        open(info, [project], project);
      } catch (error) {
        if (isSessionInvalid(error)) set({ kind: 'signed-out', notice: ENDED });
        throw error;
      }
    },
    [auth, open, set],
  );

  const session = useMemo<Session | null>(() => {
    if (phase.kind !== 'ready') return null;
    const project = phase.projects.find((p) => p.id === phase.projectId);
    const principal = phase.info.principals.find((p) => p.id === project?.principalId);
    if (project === undefined || principal === undefined) return null;
    return {
      member: phase.info.member,
      principals: phase.info.principals,
      projects: phase.projects,
      project,
      principal,
      selectProject: (projectId) => {
        const next = phase.projects.find((p) => p.id === projectId);
        if (next === undefined || next.id === project.id) return;
        open(phase.info, phase.projects, next);
        notify(`Opened ${next.name}`);
      },
      createProject: async (principalId, name) => {
        try {
          const created = await auth.createProject(principalId, name);
          open(phase.info, [...phase.projects, created], created);
          notify(`Opened ${created.name}`);
        } catch (error) {
          if (isSessionInvalid(error)) forget(ENDED);
          throw error;
        }
      },
      signOut,
    };
  }, [phase, auth, forget, notify, open, signOut]);

  // After signing in, the page title takes focus, as on any page change.
  useEffect(() => {
    if (session === null || !focusShell.current) return;
    focusShell.current = false;
    document.querySelector<HTMLElement>('.top-title')?.focus();
  }, [session]);

  switch (phase.kind) {
    case 'checking':
      return (
        <AuthFrame title="Sign in" focusKey="checking">
          <Skeleton lines={3} label="Checking your sign in" />
        </AuthFrame>
      );
    case 'check-failed':
      return (
        <SessionProblem
          title="Sign in"
          error={phase.error}
          onRetry={() => void check()}
          focusKey="check-failed"
        />
      );
    case 'signed-out':
      return <SignInScreen auth={auth} notice={phase.notice} onSignedIn={signedIn} />;
    case 'naming':
      return (
        <NameOrganisation
          onCreate={(name) => createPrincipal(phase.info, name)}
          onSignOut={signOut}
        />
      );
    case 'loading-projects':
      return (
        <AuthFrame title="Opening your projects" focusKey="loading-projects">
          <Skeleton lines={3} label="Loading your projects" />
        </AuthFrame>
      );
    case 'projects-failed':
      return (
        <SessionProblem
          title="Opening your projects"
          error={phase.error}
          onRetry={() => void loadProjects(phase.info)}
          onSignOut={signOut}
          focusKey="projects-failed"
        />
      );
    case 'no-projects': {
      const principal = phase.info.principals[0];
      return (
        <FirstProject
          principalName={principal?.name ?? ''}
          onCreate={(name) => firstProject(phase.info, principal?.id ?? '', name)}
          onSignOut={signOut}
        />
      );
    }
    case 'ready':
      return session === null ? (
        <SessionProblem
          title="Opening your projects"
          error="That project is no longer here."
          onRetry={() => void loadProjects(phase.info)}
          onSignOut={signOut}
          focusKey="missing"
        />
      ) : (
        <SessionContext.Provider value={session}>
          <SessionTree key={generation}>{children}</SessionTree>
        </SessionContext.Provider>
      );
  }
}

function SessionTree({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
