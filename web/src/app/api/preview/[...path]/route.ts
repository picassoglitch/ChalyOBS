/**
 * GET /api/preview/<...>   — authenticated HLS preview proxy.
 *
 * The relay (chalybclip-live MediaMTX) serves HLS on a PRIVATE address
 * only — never publicly. This route is the single public door:
 *
 *   1. Verify the session cookie → tenant.
 *   2. Look up the tenant's stream key.
 *   3. Proxy the request to  <internal>/live/<streamKey>/<...path>  and
 *      stream the bytes back.
 *
 * The browser only ever talks to ChalyOBS (same origin, no CORS), the stream
 * key never appears in a browser URL, and a tenant can only ever reach
 * their OWN stream. The player requests /api/preview/index.m3u8; the
 * relative segment URLs in the manifest resolve back under /api/preview/.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/server-session";
import { getStreamKey } from "@/lib/data";
import { proxyPreview } from "@/lib/preview-proxy";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse | Response> {
  if (!process.env.CHALYBOBS_RELAY_INTERNAL_HLS) {
    return NextResponse.json({ error: "preview_not_configured" }, { status: 503 });
  }

  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { path } = await ctx.params;
  // Shared with the hub's preview (/api/hub/v1/preview): same path guard,
  // same upstream, same headers.
  return proxyPreview({
    base: process.env.CHALYBOBS_RELAY_INTERNAL_HLS,
    streamKey: await getStreamKey(session.tenant_id),
    path,
    search: request.nextUrl.search,
    accept: request.headers.get("accept"),
  });
}
