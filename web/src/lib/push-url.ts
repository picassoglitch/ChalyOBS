/**
 * Pure helpers for the URLs that carry stream keys — dependency-free so they
 * unit-test under plain `node --test` (see push-url.test.mts).
 */

/** Schemes the relay can push to. Its legs are `ffmpeg -c copy -f flv <url>`,
 *  and ffmpeg also opens file:, http:, tcp:, pipe: … — so a destination URL
 *  outside this list would make the relay write files on its own disk or
 *  call arbitrary hosts from inside the VPC. */
const PUSH_SCHEMES = new Set(["rtmp:", "rtmps:", "srt:"]);

/** True when `url` is a destination ingest URL the relay may push to. */
export function isAllowedIngestUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return PUSH_SCHEMES.has(parsed.protocol.toLowerCase()) && parsed.hostname.length > 0;
}

/** Complete push URL for one destination, or null when it isn't pushable.
 *  SRT carries the credential as ?streamid=…, not as a path segment; if the
 *  user's URL already embeds it, it's complete as-is. */
export function buildPushUrl(ingestUrl: string, streamKey: string): string | null {
  const base = ingestUrl.trim().replace(/\/+$/, "");
  const key = streamKey.trim();
  if (!key || !isAllowedIngestUrl(base)) return null;
  if (base.toLowerCase().startsWith("srt://")) {
    if (base.includes("streamid=")) return base;
    return `${base}${base.includes("?") ? "&" : "?"}streamid=${key}`;
  }
  return `${base}/${key}`;
}

/** Replace every occurrence of the stream key in `text` with bullets, so a
 *  value that embeds it (the single-field "full URL") can be shown on screen
 *  without leaking the key. */
export function maskStreamKey(text: string, streamKey: string): string {
  if (!streamKey) return text;
  return text.split(streamKey).join("•".repeat(Math.min(streamKey.length, 24)));
}

/** Path segments the HLS preview proxy may forward: plain file names only
 *  (index.m3u8, segment/part names). Anything else — "..", an encoded "/",
 *  a backslash — is refused so the upstream URL can't escape the tenant's
 *  own live/<key>/ prefix. */
export function safePreviewPath(segments: string[]): string | null {
  if (segments.length === 0) return null;
  for (const s of segments) {
    if (!/^[A-Za-z0-9_.-]+$/.test(s) || s === "." || s === "..") return null;
  }
  return segments.join("/");
}
