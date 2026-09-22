/**
 * Ingest endpoints shown in the encoder panel.
 *
 * The relay base is the address the encoder pushes to (the ChalyOBS relay
 * fans out to enabled destinations). It MUST be the raw reachable RTMP
 * endpoint — the relay host's raw TCP host:port (e.g.
 * rtmp://relay.example.com:1935/live), NOT an HTTP-only custom domain
 * (a domain that only carries HTTP can't take RTMP on 1935).
 *
 * RTMP only: MediaMTX has SRT/WebRTC off and the relay's TCP proxy can't
 * carry UDP, so we don't advertise endpoints that wouldn't connect.
 *
 * Set CHALYBOBS_RELAY_RTMP_URL to that base. The value is read server-side
 * and passed into the client, so it never hardcodes a proxy port that can
 * change.
 */

export interface IngestCredentials {
  /** Server field for OBS/vMix (no key). */
  rtmpUrl: string;
  /** Single-field encoders (DJI Osmo / Mimo, GoPro, phones): server + key
   *  combined into one URL. */
  fullRtmpUrl: string;
  streamKey: string;
}

/** Fallback used only when CHALYBOBS_RELAY_RTMP_URL isn't set. */
const DEFAULT_RELAY_RTMP = "rtmp://ingest.chalyb.com/live";

export function buildIngest(
  streamKey: string,
  relayRtmp: string = DEFAULT_RELAY_RTMP,
): IngestCredentials {
  const base = relayRtmp.replace(/\/+$/, "");
  return {
    rtmpUrl: base,
    fullRtmpUrl: `${base}/${streamKey}`,
    streamKey,
  };
}
