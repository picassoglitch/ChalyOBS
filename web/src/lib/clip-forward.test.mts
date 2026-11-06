import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClipEnded, fetchErrorCode } from "./clip-forward.ts";

test("ChalyClip ended: only a call that never left is retried", () => {
  assert.equal(classifyClipEnded({ status: 200 }), "done");
  assert.equal(classifyClipEnded({ status: 404 }), "done");
  // ChalyClip may have clipped before failing: a retry could clip twice.
  assert.equal(classifyClipEnded({ status: 500 }), "unknown");
  assert.equal(classifyClipEnded({ status: 503 }), "unknown");
  // Response lost after it was sent (reset, timeout): unknown, never retried.
  assert.equal(classifyClipEnded({ errorCode: "ECONNRESET" }), "unknown");
  assert.equal(classifyClipEnded({ errorCode: "UND_ERR_SOCKET" }), "unknown");
  assert.equal(classifyClipEnded({}), "unknown");
  // Never reached ChalyClip: safe to retry.
  assert.equal(classifyClipEnded({ errorCode: "ECONNREFUSED" }), "retry");
  assert.equal(classifyClipEnded({ errorCode: "ENOTFOUND" }), "retry");
});

test("fetchErrorCode reads undici's cause.code", () => {
  assert.equal(fetchErrorCode({ cause: { code: "ECONNREFUSED" } }), "ECONNREFUSED");
  assert.equal(fetchErrorCode(new Error("x")), undefined);
  assert.equal(fetchErrorCode(null), undefined);
});
