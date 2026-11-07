import { test } from "node:test";
import assert from "node:assert/strict";
import { freshMetaBlob, isLangPending, LANG_PENDING_KEY, pendingTitleFix } from "./session-title.ts";

const ES = "Mi transmisión en vivo";
const EN = "My live stream";
const pendingMeta = { title: ES, description: "", [LANG_PENDING_KEY]: true };

test("only a screen-less create (ChalyClip's switch) marks the row as waiting for a language", () => {
  assert.equal(isLangPending(freshMetaBlob({ title: ES }, "unknown")), true);
  assert.equal(isLangPending(freshMetaBlob({ title: ES }, null)), false, "Spanish hub sends no lang: known");
  assert.equal(isLangPending(freshMetaBlob({ title: EN }, "en")), false);
  assert.deepEqual(freshMetaBlob({ title: ES }, null), { title: ES }, "Spanish rows are stored exactly as before");
});

test("Clips first, then the first English screen: the untouched Spanish default becomes English", () => {
  assert.deepEqual(pendingTitleFix({ title: ES, broadcast_meta: pendingMeta }, "en"), { kind: "retitle", title: EN });
});

test("Clips first, then a Spanish screen: the title stays, the row stops waiting", () => {
  assert.deepEqual(pendingTitleFix({ title: ES, broadcast_meta: pendingMeta }, null), { kind: "settle" });
  assert.deepEqual(pendingTitleFix({ title: ES, broadcast_meta: pendingMeta }, "es"), { kind: "settle" });
});

test("a row any screen has opened is never retitled, whatever the language", () => {
  assert.equal(pendingTitleFix({ title: ES, broadcast_meta: { title: ES } }, "en"), null, "user/es-screen default kept");
  assert.equal(pendingTitleFix({ title: "Mi show", broadcast_meta: { title: "Mi show" } }, "en"), null);
  assert.equal(pendingTitleFix({ title: ES, broadcast_meta: null }, "en"), null);
  assert.equal(pendingTitleFix({ title: ES, broadcast_meta: { [LANG_PENDING_KEY]: "true" } }, "en"), null, "only boolean true");
});

test("a waiting row whose title is no longer the default is only settled, never retitled", () => {
  assert.deepEqual(pendingTitleFix({ title: "Mi show", broadcast_meta: pendingMeta }, "en"), { kind: "settle" });
});

test("a screen-less path never settles or retitles", () => {
  assert.equal(pendingTitleFix({ title: ES, broadcast_meta: pendingMeta }, "unknown"), null);
});
