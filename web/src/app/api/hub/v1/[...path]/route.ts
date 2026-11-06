/**
 * /api/hub/v1/*  — server-to-server JSON API for the Chalyb hub (En vivo
 * inside www.chalyb.com). Bearer = hub-minted HMAC token with an `aud`
 * claim; see lib/hub-api/auth.ts and lib/hub-api/handlers.ts. No cookies.
 */

import { NextRequest } from "next/server";
import { resolvePublicOrigin } from "@/lib/env";
import { handleHubApi } from "@/lib/hub-api/handlers";
import { realHubApiDeps } from "@/lib/hub-api/deps";

export const dynamic = "force-dynamic";

async function handle(
  request: NextRequest,
  ctx: RouteContext<"/api/hub/v1/[...path]">,
): Promise<Response> {
  const { path } = await ctx.params;
  let body: unknown;
  if (request.method !== "GET" && request.method !== "DELETE") {
    body = await request.json().catch(() => undefined);
  }
  return handleHubApi(
    {
      method: request.method,
      path,
      authorization: request.headers.get("authorization"),
      body,
      search: request.nextUrl.search,
      accept: request.headers.get("accept"),
    },
    realHubApiDeps(resolvePublicOrigin(request)),
  );
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
