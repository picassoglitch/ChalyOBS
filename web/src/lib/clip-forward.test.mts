import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClipEnded } from "./clip-forward.ts";

test("ChalyClip ended: 2xx/4xx final; 5xx and failed calls retried", () => {
  assert.equal(classifyClipEnded({ status: 200 }), "done");
  assert.equal(classifyClipEnded({ status: 404 }), "done");
  assert.equal(classifyClipEnded({ status: 500 }), "retry");
  assert.equal(classifyClipEnded({ status: 503 }), "retry");
  // No status: refused, reset, timeout or a lost response.
  assert.equal(classifyClipEnded({}), "retry");
});
