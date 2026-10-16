/**
 * HLS preview proxy, shared by /api/preview (engine session cookie) and
 * /api/hub/v1/preview (hub preview token). The relay serves HLS on a PRIVATE
 * address only; this is the single public door, keyed by the tenant's own
 * stream key, which never appears in a browser URL.
 *
 * Dependency-free so it unit-tests under plain node --test.
 */

/** Plain file names only. Dropping ".." alone isn't enough: a segment like
 *  "..%2Fother" arrives decoded as "../other" and fetch() would normalize it
 *  out of live/<key>/. */
export function safePreviewPath(segments: string[]): string | null {
  if (segments.length === 0) return null;
  for (const s of segments) {
    if (s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/.test(s)) return null;
  }
  return segments.join("/");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function proxyPreview(args: {
  /** CHALYBOBS_RELAY_INTERNAL_HLS, or null when unset. */
  base: string | null | undefined;
  streamKey: string | null;
  path: string[];
  /** Raw query string including "?" (LL-HLS params), or "". */
  search: string;
  accept: string | null;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const base = args.base ? args.base.replace(/\/+$/, "") : null;
  if (!base) return json({ error: "preview_not_configured" }, 503);
  if (!args.streamKey) return json({ error: "no_stream" }, 404);
  const sub = safePreviewPath(args.path);
  if (!sub) return json({ error: "bad_path" }, 400);

  const upstream = `${base}/live/${encodeURIComponent(args.streamKey)}/${sub}${args.search}`;
  let res: Response;
  try {
    res = await (args.fetchImpl ?? fetch)(upstream, {
      cache: "no-store",
      headers: { accept: args.accept ?? "*/*" },
    });
  } catch {
    // Relay unreachable / no publisher yet → 404 so the player retries.
    return json({ error: "upstream_unreachable" }, 404);
  }
  if (!res.ok) return json({ error: "upstream_error" }, res.status);

  const headers = new Headers();
  const ct = res.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("cache-control", "no-store");
  return new Response(res.body, { status: 200, headers });
}
