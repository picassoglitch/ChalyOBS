import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { kv, secrets } from "@/store/kv";
import {
  DestinationConfig,
  PLATFORM_ORDER,
  PlatformId,
  emptyDestination,
} from "./types";

const NON_SECRET_KEY = "chalyb.destinations.v1";
const SECRET_KEY_PREFIX = "chalyb.destinations.secret.v1.";

/**
 * Phase 0 storage strategy:
 *   - Non-secret fields (channelSlug, ingestUrl, oauthToken's existence,
 *     enabled flag) live in `kv` (AsyncStorage) as one JSON blob.
 *   - Secret fields (streamKey, oauthToken value) live in `secrets`
 *     (also AsyncStorage in Phase 0; promoted to Keychain/Keystore in the
 *     Phase 1 dev build via the secrets KvStore swap).
 *
 * The split exists so we can light up real Keychain without rewriting any
 * consumer.
 */

interface NonSecretRow {
  channelSlug: string;
  ingestUrl: string;
  enabled: boolean;
  /** Stored as boolean so the JSON blob never accidentally contains the token. */
  hasOauth: boolean;
}

type NonSecretMap = Record<string, NonSecretRow>;

interface DestinationsState {
  destinations: Record<PlatformId, DestinationConfig>;
  loaded: boolean;
}

interface DestinationsActions {
  update: (id: PlatformId, patch: Partial<DestinationConfig>) => Promise<void>;
  toggleEnabled: (id: PlatformId) => Promise<void>;
  clearAll: () => Promise<void>;
}

const Ctx = createContext<(DestinationsState & DestinationsActions) | null>(null);

function blankMap(): Record<PlatformId, DestinationConfig> {
  const out = {} as Record<PlatformId, DestinationConfig>;
  for (const id of PLATFORM_ORDER) out[id] = emptyDestination(id);
  return out;
}

export function DestinationsRuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [destinations, setDestinations] = useState<
    Record<PlatformId, DestinationConfig>
  >(blankMap());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const blob = await kv.get(NON_SECRET_KEY);
      const next = blankMap();
      if (blob) {
        try {
          const parsed = JSON.parse(blob) as NonSecretMap;
          for (const id of PLATFORM_ORDER) {
            const row = parsed[id];
            if (!row) continue;
            const streamKey = (await secrets.get(`${SECRET_KEY_PREFIX}${id}.streamKey`)) ?? "";
            const oauthToken = row.hasOauth
              ? ((await secrets.get(`${SECRET_KEY_PREFIX}${id}.oauthToken`)) ?? "")
              : "";
            next[id] = {
              platformId: id,
              channelSlug: row.channelSlug ?? "",
              ingestUrl: row.ingestUrl ?? "",
              enabled: !!row.enabled,
              streamKey,
              oauthToken,
            };
          }
        } catch {
          // Corrupted blob — start fresh.
        }
      }
      setDestinations(next);
      setLoaded(true);
    })();
  }, []);

  const persist = useCallback(
    async (next: Record<PlatformId, DestinationConfig>) => {
      const nonSecret: NonSecretMap = {};
      for (const id of PLATFORM_ORDER) {
        const d = next[id];
        nonSecret[id] = {
          channelSlug: d.channelSlug,
          ingestUrl: d.ingestUrl,
          enabled: d.enabled,
          hasOauth: d.oauthToken.length > 0,
        };
      }
      await kv.set(NON_SECRET_KEY, JSON.stringify(nonSecret));
    },
    [],
  );

  const writeSecret = useCallback(
    async (id: PlatformId, field: "streamKey" | "oauthToken", value: string) => {
      const key = `${SECRET_KEY_PREFIX}${id}.${field}`;
      if (value.length === 0) await secrets.remove(key);
      else await secrets.set(key, value);
    },
    [],
  );

  const update = useCallback<DestinationsActions["update"]>(
    async (id, patch) => {
      const cur = destinations[id];
      const next: DestinationConfig = { ...cur, ...patch };
      const map = { ...destinations, [id]: next };
      setDestinations(map);

      // Persist non-secret + secret fields independently so we never accidentally
      // serialize keys into the JSON blob.
      await persist(map);
      if (patch.streamKey !== undefined) {
        await writeSecret(id, "streamKey", next.streamKey);
      }
      if (patch.oauthToken !== undefined) {
        await writeSecret(id, "oauthToken", next.oauthToken);
      }
    },
    [destinations, persist, writeSecret],
  );

  const toggleEnabled = useCallback<DestinationsActions["toggleEnabled"]>(
    async (id) => {
      const cur = destinations[id];
      const map = { ...destinations, [id]: { ...cur, enabled: !cur.enabled } };
      setDestinations(map);
      await persist(map);
    },
    [destinations, persist],
  );

  const clearAll = useCallback<DestinationsActions["clearAll"]>(async () => {
    const map = blankMap();
    setDestinations(map);
    await kv.remove(NON_SECRET_KEY);
    for (const id of PLATFORM_ORDER) {
      await secrets.remove(`${SECRET_KEY_PREFIX}${id}.streamKey`);
      await secrets.remove(`${SECRET_KEY_PREFIX}${id}.oauthToken`);
    }
  }, []);

  const value = useMemo(
    () => ({ destinations, loaded, update, toggleEnabled, clearAll }),
    [destinations, loaded, update, toggleEnabled, clearAll],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDestinations() {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error(
      "useDestinations must be used inside DestinationsRuntimeProvider",
    );
  return ctx;
}

/** Convenience: list of enabled destinations in display order. */
export function enabledDestinationsList(
  map: Record<PlatformId, DestinationConfig>,
): DestinationConfig[] {
  return PLATFORM_ORDER.map((id) => map[id]).filter((d) => d.enabled);
}
