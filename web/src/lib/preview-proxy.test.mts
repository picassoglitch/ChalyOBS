import { test } from "node:test";
import assert from "node:assert/strict";
import { safePreviewPath } from "./preview-proxy.ts";

test("preview path: plain file names only", () => {
  assert.equal(safePreviewPath(["index.m3u8"]), "index.m3u8");
  assert.equal(safePreviewPath(["abc_seg1.mp4"]), "abc_seg1.mp4");
  assert.equal(safePreviewPath(["..", "other", "index.m3u8"]), null);
  assert.equal(safePreviewPath(["../other"]), null);
  assert.equal(safePreviewPath(["..%2Fother"]), null);
  assert.equal(safePreviewPath(["a\\b"]), null);
  assert.equal(safePreviewPath([]), null);
});
