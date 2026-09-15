/**
 * GET /api/preview/<...>   — authenticated HLS preview proxy.
 *
 * The relay (chalybclip-live MediaMTX) serves HLS on its PRIVATE Railway
 * address only — never publicly. This route is the single public door:
 *
 *   1. Verify the session cookie → tenant.
 *   2. Look up the tenant's stream key.
 *   3. Proxy the request to  <internal>/live/<streamKey>/<...path>  and
 *      stream the bytes back.
 *
 * The browser only ever talks to ChalybOBS (same origin, no CORS), the stream
 * key never appears in a browser URL, and a tenant can only ever reach
 * their OWN stream. The player requests /api/preview/index.m3u8; the
 * relative segment URLs in the manifest resolve back under /api/preview/.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/server-session";
import { getStreamKey } from "@/lib/data";

export const dynamic = "force-dynamic";

function internalBase(): string | null {
  const base = process.env.CHALYBOBS_RELAY_INTERNAL_HLS;
  return base ? base.replace(/\/+$/, "") : null;
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse | Response> {
  const base = internalBase();
  if (!base) {
    return NextResponse.json({ error: "preview_not_configured" }, { status: 503 });
  }

  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const streamKey = await getStreamKey(session.tenant_id);
  if (!streamKey) {
    return NextResponse.json({ error: "no_stream" }, { status: 404 });
  }

  const { path } = await ctx.params;
  // Guard against path traversal — only forward simple segment names.
  const safe = path.filter((p) => p !== ".." && p !== ".");
  const sub = safe.join("/");
  const upstream = `${base}/live/${encodeURIComponent(streamKey)}/${sub}${request.nextUrl.search}`;

  let res: Response;
  try {
    res = await fetch(upstream, {
      // Private-network fetch; no caching of live segments.
      cache: "no-store",
      headers: { accept: request.headers.get("accept") ?? "*/*" },
    });
  } catch {
    // Relay unreachable / no publisher yet → 404 so the player retries.
    return NextResponse.json({ error: "upstream_unreachable" }, { status: 404 });
  }

  if (!res.ok) {
    return NextResponse.json({ error: "upstream_error" }, { status: res.status });
  }

  const headers = new Headers();
  const ct = res.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("cache-control", "no-store");

  return new Response(res.body, { status: 200, headers });
}
