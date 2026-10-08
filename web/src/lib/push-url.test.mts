import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPushUrl,
  isAllowedIngestUrl,
  maskStreamKey,
  safePreviewPath,
} from "./push-url.ts";

test("ingest URL: only rtmp / rtmps / srt with a host", () => {
  assert.equal(isAllowedIngestUrl("rtmp://live.twitch.tv/app"), true);
  assert.equal(isAllowedIngestUrl("rtmps://x.global-contribute.live-video.net:443/app"), true);
  assert.equal(isAllowedIngestUrl("srt://srt.example.com:9000"), true);
  assert.equal(isAllowedIngestUrl("  RTMP://a.rtmp.youtube.com/live2 "), true);
  assert.equal(isAllowedIngestUrl("file:///scripts"), false);
  assert.equal(isAllowedIngestUrl("http://metadata.google.internal/x"), false);
  assert.equal(isAllowedIngestUrl("tcp://10.0.0.2:1935"), false);
  assert.equal(isAllowedIngestUrl("pipe:1"), false);
  assert.equal(isAllowedIngestUrl("rtmp://"), false);
  assert.equal(isAllowedIngestUrl(""), false);
  assert.equal(isAllowedIngestUrl("not a url"), false);
});

test("push URL: rtmp appends the key, srt uses ?streamid=", () => {
  assert.equal(buildPushUrl("rtmp://live.twitch.tv/app/", "k1"), "rtmp://live.twitch.tv/app/k1");
  assert.equal(buildPushUrl("srt://h:9000", "k2"), "srt://h:9000?streamid=k2");
  assert.equal(buildPushUrl("srt://h:9000?latency=200", "k"), "srt://h:9000?latency=200&streamid=k");
  assert.equal(buildPushUrl("srt://h:9000?streamid=abc", "k"), "srt://h:9000?streamid=abc");
});

test("push URL: refuses non-relay schemes and empty keys", () => {
  assert.equal(buildPushUrl("file:///scripts", "env.sh"), null);
  assert.equal(buildPushUrl("http://169.254.169.254", "k"), null);
  assert.equal(buildPushUrl("rtmp://live.twitch.tv/app", "  "), null);
  assert.equal(buildPushUrl("", "k"), null);
});

test("maskStreamKey hides every occurrence of the key", () => {
  const key = "chalyb_live_0123456789abcdef";
  const masked = maskStreamKey(`rtmp://ingest.chalyb.com/live/${key}`, key);
  assert.ok(!masked.includes(key));
  assert.ok(masked.startsWith("rtmp://ingest.chalyb.com/live/•"));
  assert.equal(maskStreamKey("abc", ""), "abc");
});

test("preview path: plain file names only", () => {
  assert.equal(safePreviewPath(["index.m3u8"]), "index.m3u8");
  assert.equal(safePreviewPath(["abc_seg1.mp4"]), "abc_seg1.mp4");
  assert.equal(safePreviewPath(["..", "other", "index.m3u8"]), null);
  assert.equal(safePreviewPath(["../other"]), null);
  assert.equal(safePreviewPath(["..%2Fother"]), null);
  assert.equal(safePreviewPath(["a\\b"]), null);
  assert.equal(safePreviewPath([]), null);
});
