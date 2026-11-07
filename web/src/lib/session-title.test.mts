import { test } from "node:test";
import assert from "node:assert/strict";
import { freshMetaBlob, isLangPending, LANG_PENDING_KEY, openSession, pendingTitleFix } from "./session-title.ts";

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

type Row = { title: string; broadcast_meta: unknown };
function io(reads: (Row | null)[], insertError: { message: string } | null) {
  const settled: Row[] = [];
  return {
    settled,
    io: {
      read: async () => reads.shift() ?? null,
      insert: async () => insertError,
      // what getOrCreateSession does for an English screen
      settle: async (r: Row) => {
        settled.push(r);
        const fix = pendingTitleFix(r, "en");
        return fix?.kind === "retitle" ? { title: fix.title, broadcast_meta: { title: fix.title } } : r;
      },
    },
  };
}

test("race: ChalyClip's create wins, the English call loses the insert → still settled to English", async () => {
  const winner = { title: ES, broadcast_meta: pendingMeta };
  const { io: x, settled } = io([null, winner], { message: "duplicate key" });
  const out = await openSession(x);
  assert.equal(out.kind, "lost");
  assert.deepEqual(settled, [winner], "the winner's row goes through settle");
  assert.equal(out.kind === "lost" && out.row?.title, EN);
});

test("found row is settled; a won insert needs no settle; lost race with no row left reports it", async () => {
  const a = io([{ title: ES, broadcast_meta: pendingMeta }], null);
  const found = await openSession(a.io);
  assert.equal(found.kind === "found" && found.row.title, EN);

  const b = io([null], null);
  assert.deepEqual(await openSession(b.io), { kind: "created" });
  assert.equal(b.settled.length, 0);

  const c = io([null, null], { message: "rls" });
  const lost = await openSession(c.io);
  assert.equal(lost.kind === "lost" && lost.row, null);
  assert.equal(c.settled.length, 0);
});
