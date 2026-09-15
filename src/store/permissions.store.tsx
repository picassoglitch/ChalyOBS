import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Permissions } from "@/backend";
import { defaultPermissions } from "@/backend";
import { kv } from "./kv";

const PERMS_KEY = "chalyb.permissions.v1";

interface PermissionsState {
  permissions: Permissions;
  loaded: boolean;
}

interface PermissionsActions {
  setPermission: (key: keyof Permissions, value: boolean) => Promise<void>;
  replaceAll: (next: Permissions) => Promise<void>;
}

const Ctx = createContext<(PermissionsState & PermissionsActions) | null>(null);

/**
 * Phase 0: permissions live in local kv only. Both Streamer (writer) and
 * Operator (reader) are the same physical device while we're single-device,
 * so a local store works. Phase 1+ moves writes to a Supabase
 * `stream_sessions.permissions` row + realtime channel so the operator on
 * Android sees the streamer's iPhone toggles update live.
 */
export function PermissionsRuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [permissions, setPermissions] =
    useState<Permissions>(defaultPermissions);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const raw = await kv.get(PERMS_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<Permissions>;
          setPermissions({ ...defaultPermissions, ...parsed });
        } catch {
          /* fall through to defaults */
        }
      }
      setLoaded(true);
    })();
  }, []);

  const persist = useCallback(async (next: Permissions) => {
    await kv.set(PERMS_KEY, JSON.stringify(next));
  }, []);

  const setPermission = useCallback<PermissionsActions["setPermission"]>(
    async (key, value) => {
      setPermissions((cur) => {
        const next = { ...cur, [key]: value };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const replaceAll = useCallback<PermissionsActions["replaceAll"]>(
    async (next) => {
      setPermissions(next);
      await persist(next);
    },
    [persist],
  );

  const value = useMemo(
    () => ({ permissions, loaded, setPermission, replaceAll }),
    [permissions, loaded, setPermission, replaceAll],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePermissions() {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error(
      "usePermissions must be used inside PermissionsRuntimeProvider",
    );
  return ctx;
}
