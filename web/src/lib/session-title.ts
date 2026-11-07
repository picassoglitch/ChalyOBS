import { defaultStreamTitle, type Lang } from "./locale.ts";

/** Who opens the session: a screen in a known language (null = Spanish hub,
 *  which sends no lang), or a background path with no screen at all. */
export type SessionLang = Lang | null | "unknown";

// broadcast_meta flag on a row a screen-less path created (ChalyClip's switch): its
// default title still waits for the first screen's language (2026-11-07).
export const LANG_PENDING_KEY = "langPending";

export function isLangPending(meta: unknown): boolean {
  return !!meta && typeof meta === "object" && (meta as Record<string, unknown>)[LANG_PENDING_KEY] === true;
}

/** The broadcast_meta a new row is inserted with. */
export function freshMetaBlob<M extends object>(meta: M, lang: SessionLang): M {
  return lang === "unknown" ? { ...meta, [LANG_PENDING_KEY]: true } : meta;
}

export type PendingTitleFix =
  | null
  /** The first English screen: the untouched Spanish default becomes English. */
  | { kind: "retitle"; title: string }
  /** The first Spanish screen (or a title already changed): the default stays. */
  | { kind: "settle" };

/** What the first screen in a known language does to a row still waiting for one;
 *  rows a screen already opened never change (their title is the person's). */
export function pendingTitleFix(
  row: { title: string; broadcast_meta: unknown },
  lang: SessionLang,
): PendingTitleFix {
  if (lang === "unknown" || !isLangPending(row.broadcast_meta)) return null;
  const unknownDefault = defaultStreamTitle(null);
  const wanted = defaultStreamTitle(lang);
  if (wanted !== unknownDefault && row.title === unknownDefault) return { kind: "retitle", title: wanted };
  return { kind: "settle" };
}

export type OpenedSession<R> =
  | { kind: "found"; row: R }
  | { kind: "created" }
  | { kind: "lost"; row: R | null; insertError: { message: string } };

/** Read, else insert; on a lost insert race, read the winner's row. Every existing
 *  row, found or won by another request, goes through `settle` (pendingTitleFix). */
export async function openSession<R>(io: {
  read: () => Promise<R | null>;
  insert: () => Promise<{ message: string } | null>;
  settle: (row: R) => Promise<R>;
}): Promise<OpenedSession<R>> {
  const found = await io.read();
  if (found) return { kind: "found", row: await io.settle(found) };
  const insertError = await io.insert();
  if (!insertError) return { kind: "created" };
  const winner = await io.read();
  return { kind: "lost", row: winner ? await io.settle(winner) : null, insertError };
}
