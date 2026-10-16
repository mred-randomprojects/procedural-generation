#!/usr/bin/env node
// The third-party code this site runs is served from the site itself, out of
// vendor/, never from a CDN. Every app under mred-randomprojects.github.io
// shares one browser origin (see CLAUDE.md), so any script a page runs can read
// every app's storage and Firebase sessions, and a file on a CDN is only as safe
// as the CDN. The one pin a module import can carry, import-map "integrity", is
// ignored by Safari before 18, Chrome before 127 and Firefox before 138: those
// run whatever bytes the CDN sends.
//
//   node scripts/check-vendor.mjs             every vendor/ file still has its pinned
//                                             hash, vendor/ holds nothing unpinned or
//                                             unused, and no page loads a script from
//                                             another host. npm test runs it
//                                             (tests/check-vendor.test.mjs), and so
//                                             does the deploy.
//   node scripts/check-vendor.mjs --upstream  also downloads each release below and
//                                             checks it is the same bytes. Run it after
//                                             adding or bumping a file.
//
// To add or bump one: save the release's file as vendor/<name>-<version>.js,
// point the page at it, list it below with the hash that
//   echo "sha384-$(openssl dgst -sha384 -binary vendor/<file> | openssl base64 -A)"
// prints, delete the old file, and run with --upstream.
//
// No dependencies; Node 18 or later.

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, basename, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const VENDORED = [
  {
    // three@0.160.0, build/three.module.js: the file in the npm tarball (whose sha512
    // is the registry's dist.integrity) and at the r160 tag of mrdoob/three.js.
    file: "vendor/three-0.160.0.module.js",
    sha384: "sha384-61S/Nu32S3E5+n+KpCOTb2eRYps6fVKm+9Gz1QBvSePFthb46f063Aa/qe/lykFZ",
    upstream: [
      "https://unpkg.com/three@0.160.0/build/three.module.js",
      "https://raw.githubusercontent.com/mrdoob/three.js/d04539a76736ff500cae883d6a38b3dd8643c548/build/three.module.js",
    ],
  },
  {
    // github:mred-randomprojects/cmd-s#v1.0.0, dist/cmd-s.js, by its commit and by
    // its tag: a moved tag shows up here as a mismatch.
    file: "vendor/cmd-s-1.0.0.js",
    sha384: "sha384-PFN7FojT4754YsJFOeWsOSVw3uxilW0wmkUVMnae3Xfny7DPcGRZ/Z3fmm4LNfM5",
    upstream: [
      "https://raw.githubusercontent.com/mred-randomprojects/cmd-s/3a4f874a6b703c16ad56acf36fb9203f34c68a38/dist/cmd-s.js",
      "https://raw.githubusercontent.com/mred-randomprojects/cmd-s/v1.0.0/dist/cmd-s.js",
    ],
  },
];

// Not pages: tooling, tests, and the pinned files themselves.
const SKIP_DIRS = new Set(["node_modules", "vendor", "scripts", "tests", "steam"]);
const PAGE_FILE = /\.(html|js|mjs)$/;

const REMOTE = String.raw`(?:https?:)?//`;
const REMOTE_LOADS = [
  ["loads a <script src> from another host", String.raw`<script\b[^>]*\bsrc\s*=\s*["']?\s*${REMOTE}`],
  ["imports a module from another host", String.raw`\b(?:import|from)\s*["'\`]\s*${REMOTE}`],
  ["imports a module from another host", String.raw`\bimport\s*\(\s*["'\`]\s*${REMOTE}`],
  ["preloads a script from another host", String.raw`<link\b(?=[^>]*\brel\s*=\s*["']?(?:modulepreload|preload)\b)(?=[^>]*\bhref\s*=\s*["']?\s*${REMOTE})`],
  ["runs a worker script from another host", String.raw`\b(?:importScripts\s*\(|new\s+(?:Shared)?Worker\s*\()\s*["'\`]\s*${REMOTE}`],
  ["builds a <script> element at runtime", String.raw`\bcreateElement\(\s*["'\`]script["'\`]\s*\)`],
  ["sets a <base> on another host, so every relative script loads from there", String.raw`<base\b[^>]*\bhref\s*=\s*["']?\s*${REMOTE}`],
].map(([what, source]) => [what, new RegExp(source, "gi")]);

const sri = (bytes) => "sha384-" + createHash("sha384").update(bytes).digest("base64");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Every place in a page (HTML or JS) that would run a script fetched from another host. */
export function findRemoteScripts(text) {
  const found = [];
  for (const [what, re] of REMOTE_LOADS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) found.push({ line: lineOf(text, m.index), what });
  }
  const maps = /<script\b[^>]*\btype\s*=\s*["']?importmap\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (let m; (m = maps.exec(text)); ) {
    const line = lineOf(text, m.index);
    let map;
    try {
      map = JSON.parse(m[1]);
    } catch (e) {
      found.push({ line, what: `has an import map that is not valid JSON (${e.message})` });
      continue;
    }
    const targets = [map.imports, ...Object.values(map.scopes || {})].flatMap((o) => Object.values(o || {}));
    for (const t of targets) {
      if (typeof t === "string" && new RegExp(`^\\s*${REMOTE}`, "i").test(t)) {
        found.push({ line, what: `maps a module to another host (${t})` });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function filesUnder(dir, skip) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith(".") || skip.has(e.name) ? [] : filesUnder(path, skip);
    return e.isFile() ? [path] : [];
  });
}

/** Everything wrong with the site's third-party code, as messages; empty when all is well. */
export function check(root = ROOT, vendored = VENDORED) {
  const problems = [];
  const rel = (path) => relative(root, path).split(sep).join("/");

  for (const v of vendored) {
    let bytes;
    try {
      bytes = readFileSync(join(root, v.file));
    } catch {
      problems.push(`${v.file} is missing`);
      continue;
    }
    const got = sri(bytes);
    if (got !== v.sha384) problems.push(`${v.file} is not the pinned release: it hashes to ${got}, the pin is ${v.sha384}`);
  }
  const pinned = new Set(vendored.map((v) => v.file));
  for (const f of filesUnder(join(root, "vendor"), new Set())) {
    if (!pinned.has(rel(f)) && !basename(f).startsWith(".")) {
      problems.push(`${rel(f)} is in vendor/ but has no pin in scripts/check-vendor.mjs`);
    }
  }

  const pages = filesUnder(root, SKIP_DIRS)
    .filter((f) => PAGE_FILE.test(f))
    .map((f) => ({ file: rel(f), text: readFileSync(f, "utf8") }));
  for (const { file, text } of pages) {
    for (const { line, what } of findRemoteScripts(text)) problems.push(`${file}:${line} ${what}`);
  }
  for (const v of vendored) {
    if (!pages.some(({ text }) => text.includes(basename(v.file)))) {
      problems.push(`${v.file} is pinned but no page loads it: point a page at it or delete it and its pin`);
    }
  }
  return problems;
}

/** Downloads every release listed and returns what does not match its pin. */
export async function checkUpstream(vendored = VENDORED) {
  const problems = [];
  for (const v of vendored) {
    for (const url of v.upstream) {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          problems.push(`${url}: HTTP ${res.status}`);
          continue;
        }
        const got = sri(Buffer.from(await res.arrayBuffer()));
        if (got === v.sha384) console.log(`✓ ${url}`);
        else problems.push(`${url} serves ${got}, not the pinned ${v.sha384} of ${v.file}`);
      } catch (e) {
        problems.push(`${url}: ${e.message}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = check();
  if (process.argv.includes("--upstream")) problems.push(...(await checkUpstream()));
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error(`\n${problems.length} problem(s) with third-party code; see the top of scripts/check-vendor.mjs`);
    process.exit(1);
  }
  const pins = VENDORED.length === 1 ? "matches its pin" : "match their pins";
  console.log(`✓ ${VENDORED.map((v) => v.file).join(", ")} ${pins}; no page loads a script from another host`);
}
