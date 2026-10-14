"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const errors = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

check(Array.isArray(manifest.host_permissions), "host permissions are missing");
check(manifest.host_permissions.length >= 7, "host permissions do not cover the supported AI set");
check(!manifest.permissions.includes("<all_urls>"), "broad host permission should not be used");
check(fs.existsSync(path.join(root, manifest.background.service_worker)), "background service worker exists");
check(fs.existsSync(path.join(root, "README.md")), "README.md exists");

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
check(readme.includes("## Installation for end users"), "README includes installation steps");
check(readme.includes("## Testing and verification"), "README includes testing section");

if (errors.length) {
  console.error("smoke validation failed:");
  for (const message of errors) console.error(" - " + message);
  process.exit(1);
}

console.log("smoke validation passed");
