"use strict";
/* Security audit script — checks for credential leaks in source files */
const fs = require("fs");
const path = require("path");

const DANGER = [
  { re: /sk-[a-zA-Z0-9]{20,}/, label: "OpenAI API key" },
  { re: /AIza[a-zA-Z0-9_-]{35}/, label: "Google API key" },
  { re: /ghp_[a-zA-Z0-9]{36}/, label: "GitHub PAT" },
  { re: /xoxb-[a-zA-Z0-9-]+/, label: "Slack token" },
  { re: /sk_live_[a-zA-Z0-9]{20,}/, label: "Stripe live key" },
];

// False-positive allowlist (test/example strings that are intentionally fake)
const FP_ALLOWLIST = [
  /test-pass-123/,
  /my-passphrase/,
  /workflow-a-pass/,
  /correct/,
  /wrong/,
];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (["node_modules", ".git", "icons", "package-lock.json"].includes(name)) return [];
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return walk(full);
    if (/\.(js|json|html|md|css|txt)$/.test(name)) return [full];
    return [];
  });
}

let leaks = 0;
const files = walk(".");
for (const file of files) {
  let content;
  try { content = fs.readFileSync(file, "utf8"); } catch (e) { continue; }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, label } of DANGER) {
      if (!re.test(line)) continue;
      // Skip allowlisted false positives
      if (FP_ALLOWLIST.some((fp) => fp.test(line))) continue;
      console.log(`LEAK: ${label} in ${path.relative(".", file)}:${i + 1}`);
      console.log("  " + line.trim().slice(0, 100));
      leaks++;
    }
  }
}

const evalUsage = [];
for (const file of files) {
  if (file.includes("node_modules") || file.includes("eslintrc")) continue;
  let content;
  try { content = fs.readFileSync(file, "utf8"); } catch (e) { continue; }
  // Detect eval() usage (not in comments)
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/\/\/.*/, "");
    if (/\beval\s*\(/.test(trimmed) || /new\s+Function\s*\(/.test(trimmed)) {
      // Allowed only in test files (jsdom uses eval internally)
      if (!file.includes("tests") && !file.includes("run.js")) {
        evalUsage.push(`${path.relative(".", file)}:${i + 1}: ${lines[i].trim().slice(0, 80)}`);
      }
    }
  }
}

console.log("\n=== Security Scan Results ===");
console.log(`Credentials detected: ${leaks}`);
console.log(`Unsafe eval() usage: ${evalUsage.length}`);
if (evalUsage.length) {
  evalUsage.forEach((l) => console.log("  EVAL: " + l));
}
console.log(`Files scanned: ${files.length}`);
console.log(leaks === 0 && evalUsage.length === 0 ? "RESULT: CLEAN" : "RESULT: ISSUES FOUND");
process.exit(leaks > 0 || evalUsage.length > 0 ? 1 : 0);
