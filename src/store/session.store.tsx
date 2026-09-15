import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { backend } from "@/backend";
import type { ChalybSession, OperatorRole } from "@/backend";
import { signInWithGoogle as googleSignIn } from "@/lib/auth/google";
import { kv } from "@/store/kv";

const ROLE_KEY = "chalyb.activeRole.v1";

export type SessionPhase =
  | "loading" // hydrating Supabase session
  | "loggedOut" // no Supabase user
  | "needsRole" // logged in, no ChalybOBS role picked yet
  | "ready"; // role picked

export interface SessionState {
  phase: SessionPhase;
  /** Joined Supabase user + Chalyb profile row. */
  session: ChalybSession | null;
  /** Local-only — which mode of ChalybOBS the user is running this session. */
  role: OperatorRole | null;
  error: string | null;
}

interface SessionActions {
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  selectRole: (role: OperatorRole) => Promise<void>;
  /** Drops the role choice but keeps the auth (back from a role home). */
  clearRole: () => Promise<void>;
}

const Ctx = createContext<(SessionState & SessionActions) | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    phase: "loading",
    session: null,
    role: null,
    error: null,
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const safeSet = useCallback((patch: Partial<SessionState>) => {
    if (!mounted.current) return;
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const computePhase = useCallback(
    (session: ChalybSession | null, role: OperatorRole | null): SessionPhase => {
      if (!session) return "loggedOut";
      if (!role) return "needsRole";
      return "ready";
    },
    [],
  );

  // Hydrate + subscribe to auth changes -------------------------------------
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    (async () => {
      try {
        const [session, roleStr] = await Promise.all([
          backend.getCurrentSession(),
          kv.get(ROLE_KEY),
        ]);
        const role: OperatorRole | null =
          roleStr === "streamer" || roleStr === "operator" ? roleStr : null;
        safeSet({ session, role, phase: computePhase(session, role) });
      } catch (err) {
        safeSet({
          phase: "loggedOut",
          error: err instanceof Error ? err.message : "hydrate failed",
        });
      }

      unsubscribe = backend.onAuthChange(async (next) => {
        // Auth state can change out from under us (token refresh, sign-out from
        // another tab on a future web companion, etc.) — keep local state synced.
        const roleStr = await kv.get(ROLE_KEY);
        const role: OperatorRole | null =
          roleStr === "streamer" || roleStr === "operator" ? roleStr : null;
        safeSet({ session: next, role, phase: computePhase(next, role) });
      });
    })();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [safeSet, computePhase]);

  // Actions -----------------------------------------------------------------
  const signIn = useCallback<SessionActions["signIn"]>(
    async (email, password) => {
      safeSet({ error: null });
      const session = await backend.signInWithPassword(email, password);
      // Pre-warm the local role so the lobby can highlight what they used last
      // in a future enhancement. For now we always re-pick.
      safeSet({ session, role: null, phase: "needsRole" });
    },
    [safeSet],
  );

  const signInWithGoogle = useCallback<
    SessionActions["signInWithGoogle"]
  >(async () => {
    safeSet({ error: null });
    await googleSignIn();
    // onAuthChange listener (set up above) picks the new session up async;
    // we don't need to set state here. Phase transitions to needsRole as
    // soon as the listener fires.
  }, [safeSet]);

  const signOut = useCallback<SessionActions["signOut"]>(async () => {
    await backend.signOut().catch(() => {});
    await kv.remove(ROLE_KEY);
    safeSet({ session: null, role: null, phase: "loggedOut" });
  }, [safeSet]);

  const selectRole = useCallback<SessionActions["selectRole"]>(
    async (role) => {
      await kv.set(ROLE_KEY, role);
      safeSet({ role, phase: "ready" });
    },
    [safeSet],
  );

  const clearRole = useCallback<SessionActions["clearRole"]>(async () => {
    await kv.remove(ROLE_KEY);
    safeSet({ role: null, phase: "needsRole" });
  }, [safeSet]);

  const value = useMemo(
    () => ({
      ...state,
      signIn,
      signInWithGoogle,
      signOut,
      selectRole,
      clearRole,
    }),
    [state, signIn, signInWithGoogle, signOut, selectRole, clearRole],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
