// Owner 2026-11-06: the product is "Chalyb" / "En vivo", never an OBS-branded
// name. OBS Studio (the app people stream from) and identifiers stay.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OLD_BRAND = /chaly\w*\s?obs/gi;

// The slug `chalybobs` and env vars `CHALYBOBS_*` are identifiers, not brand.
function oldBrandHits(text: string): string[] {
  return (text.match(OLD_BRAND) ?? []).filter(
    (m) => m !== m.toLowerCase() && m !== m.toUpperCase(),
  );
}

test("the old-brand rule spares identifiers and OBS Studio", () => {
  for (const bad of ["ChalyOBS", "ChalybOBS", "Chalyb OBS", "ChalyObs", "Chalyobs"])
    assert.deepEqual(oldBrandHits(`Entrar a ${bad}`), [bad]);
  for (const ok of ["chalybobs", "CHALYBOBS_SSO_SECRET", "OBS Studio", "Chalyb En vivo"])
    assert.deepEqual(oldBrandHits(ok), []);
});

test("web/src shows no OBS-branded product name outside comments", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const hits: string[] = [];
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.(tsx?|mts)$/.test(rel) || rel.endsWith("brand.test.mts")) continue;
    readFileSync(join(root, rel), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
        const code = line.replace(/\s\/\/\s.*$/, "");
        for (const m of oldBrandHits(code)) hits.push(`src/${rel}:${i + 1}: ${m}`);
      });
  }
  assert.deepEqual(hits, []);
});
