import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("../", import.meta.url).pathname);
const pkgPath = path.join(root, "node_modules", "openclaw", "package.json");
const minimum = [2026, 3, 24];

function parseVersion(version) {
  const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return match.slice(1).map((part) => Number(part));
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

if (!fs.existsSync(pkgPath)) {
  console.error("[r2-relay-channel] openclaw is not installed in node_modules. Install a compatible version before building.");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = String(pkg.version || "unknown");
const parsed = parseVersion(version);

console.log(`[r2-relay-channel] Detected openclaw ${version}`);

if (!parsed) {
  console.error(`[r2-relay-channel] Could not parse OpenClaw version: ${version}`);
  process.exit(1);
}

if (compareVersions(parsed, minimum) < 0) {
  console.error(`[r2-relay-channel] This plugin requires openclaw >= ${minimum.join(".")}. Detected ${version}.`);
  process.exit(1);
}
