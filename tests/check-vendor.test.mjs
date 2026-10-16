// scripts/check-vendor.mjs is what keeps third-party code on this site to the
// pinned copies in vendor/ (its header says why). These tests run it on the
// repo, so `npm test` and the deploy fail with it, and pin what it catches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, findRemoteScripts, VENDORED } from "../scripts/check-vendor.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("every vendored file is its pinned release, and no page loads a script from another host", () => {
  assert.deepEqual(check(), []);
});

test("the page head as it was (three.js from unpkg, cmd-s from jsDelivr) is caught", () => {
  const head = `
  <script type="importmap">
    { "imports": { "three": "https://unpkg.com/three@0.160.0/build/three.module.js" } }
  </script>
  <script type="module">
    import { interceptSave } from "https://cdn.jsdelivr.net/gh/mred-randomprojects/cmd-s@1.0.0/dist/cmd-s.js";
    interceptSave();
  </script>`;
  assert.deepEqual(
    findRemoteScripts(head).map((f) => f.line),
    [2, 6],
  );
});

test("every way a page can run a script from another host is caught", () => {
  for (const page of [
    `<script src="https://cdn.example/x.js"></script>`,
    `<script async src=//cdn.example/x.js></script>`,
    `<script type="module" src="http://cdn.example/x.js"></script>`,
    `const m = await import("https://esm.example/x.js");`,
    `import "https://cdn.example/side-effect.js";`,
    `export * from 'https://cdn.example/x.js';`,
    `<link rel="modulepreload" href="https://cdn.example/x.js">`,
    `new Worker("https://cdn.example/w.js")`,
    `importScripts("https://cdn.example/w.js")`,
    `const s = document.createElement("script");`,
    `<script type="importmap">{ "imports": {}, "scopes": { "/": { "x": "https://cdn.example/x.js" } } }</script>`,
    `<SCRIPT SRC="HTTPS://cdn.example/x.js"></SCRIPT>`,
    `import { x } from "HTTPS://cdn.example/x.js";`,
    `<base href="https://cdn.example/">`,
  ]) {
    assert.equal(findRemoteScripts(page).length, 1, page);
  }
});

test("an import map that is not JSON is reported: the browser would drop it and \"three\" would not resolve", () => {
  const [found] = findRemoteScripts(`<script type="importmap">{ "imports": { "three": "./x.js", } }</script>`);
  assert.match(found.what, /not valid JSON/);
});

test("same-origin modules, links, stylesheets and data fetches are left alone", () => {
  const page = `
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
  <a href="https://github.com/mrdoob/three.js" target="_blank">three.js</a>
  <script type="importmap">{ "imports": { "three": "./vendor/three-0.160.0.module.js" } }</script>
  <base href="./">
  <script src="js/noise.js" defer></script>
  <script type="module">
    import { interceptSave } from "./vendor/cmd-s-1.0.0.js";
    import * as THREE from "three";
    fetch("https://example.com/data.json");
  </script>`;
  assert.deepEqual(findRemoteScripts(page), []);
});

test("a vendored file that is not its release, an unpinned one, or an unused one fails the check", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-vendor-"));
  try {
    mkdirSync(join(dir, "vendor"));
    for (const v of VENDORED) copyFileSync(join(ROOT, v.file), join(dir, v.file));
    const page = VENDORED.map((v) => `<script type="module" src="./${v.file}"></script>`).join("\n");
    writeFileSync(join(dir, "index.html"), page);
    assert.deepEqual(check(dir), []);

    appendFileSync(join(dir, VENDORED[0].file), "\n// one more line\n");
    writeFileSync(join(dir, "vendor", "extra.js"), "export {};\n");
    writeFileSync(join(dir, "index.html"), page.split("\n").slice(0, -1).join("\n"));
    const problems = check(dir);
    assert.ok(problems.some((p) => p.startsWith(`${VENDORED[0].file} is not the pinned release`)), problems.join("\n"));
    assert.ok(problems.some((p) => p.startsWith("vendor/extra.js is in vendor/ but has no pin")), problems.join("\n"));
    assert.ok(problems.some((p) => p.startsWith(`${VENDORED.at(-1).file} is pinned but no page loads it`)), problems.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
