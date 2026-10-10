/* Extract the `const DATA = {...}` object from the Weekly Crypto Brief artifact HTML
   and write it as JSON (default data/brief.json). The literal is evaluated in an empty
   VM context with a timeout, so it can only produce data, not touch this process.
   Usage: node recorder/brief-extract.cjs <artifact.html> [out.json] */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const [src, out = path.join(__dirname, "..", "data", "brief.json")] = process.argv.slice(2);
if (!src) { console.error("usage: brief-extract.cjs <artifact.html> [out.json]"); process.exit(2); }
const html = fs.readFileSync(src, "utf8");
const start = html.indexOf("const DATA");
if (start < 0) { console.error("No `const DATA` found"); process.exit(1); }
const open = html.indexOf("{", start);
// walk to the matching closing brace, skipping strings
let depth = 0, i = open, q = null;
for (; i < html.length; i++) {
  const ch = html[i];
  if (q) { if (ch === "\\") i++; else if (ch === q) q = null; continue; }
  if (ch === '"' || ch === "'" || ch === "`") q = ch;
  else if (ch === "{") depth++;
  else if (ch === "}" && --depth === 0) break;
}
const literal = html.slice(open, i + 1);
const data = vm.runInNewContext("(" + literal + ")", Object.create(null), { timeout: 1000 });
const json = JSON.parse(JSON.stringify(data));
for (const k of ["period", "snapshot", "btc", "events", "tokens", "actions"]) if (!(k in json)) { console.error("Missing field: " + k); process.exit(1); }
json.artifact = "https://claude.ai/artifact/SDiCExUkGBn94iuhEyqmEK";
json.syncedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(json, null, 1));
console.log(`brief: ${json.period} · snapshot ${json.snapshot} · ${json.events.length} event · ${json.tokens.length} token → ${out}`);
