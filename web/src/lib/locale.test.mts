import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultStreamTitle, hubPath, langFromAcceptLanguage, normalizeLang } from "./locale.ts";

test("normalizeLang", () => {
  const cases: [string | null | undefined, string | null][] = [
    ["en", "en"], ["EN", "en"], ["en-US", "en"], ["en_GB", "en"], ["es", "es"], ["es-MX", "es"],
    ["fr", null], ["", null], [null, null], [undefined, null], ["english", null],
  ];
  for (const [raw, want] of cases) assert.equal(normalizeLang(raw), want, String(raw));
});

test("Accept-Language: first supported entry wins", () => {
  assert.equal(langFromAcceptLanguage("fr-FR,en-US;q=0.8,es;q=0.5"), "en");
  assert.equal(langFromAcceptLanguage("es-MX,es;q=0.9,en;q=0.8"), "es");
  assert.equal(langFromAcceptLanguage("de,fr"), null);
  assert.equal(langFromAcceptLanguage(null), null);
});

test("default stream title: English only for en; Spanish unchanged", () => {
  assert.equal(defaultStreamTitle("en"), "My live stream");
  assert.equal(defaultStreamTitle("es"), "Mi transmisión en vivo");
  assert.equal(defaultStreamTitle(null), "Mi transmisión en vivo");
  assert.equal(defaultStreamTitle(undefined), "Mi transmisión en vivo");
});

test("hubPath prefixes only English", () => {
  assert.equal(hubPath("/app/en-vivo", "en"), "/en/app/en-vivo");
  assert.equal(hubPath("/app/en-vivo", "es"), "/app/en-vivo");
  assert.equal(hubPath("/app/en-vivo", null), "/app/en-vivo");
});
