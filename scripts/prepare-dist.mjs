import fs from "node:fs/promises";
import path from "node:path";

const root = new URL("../", import.meta.url);
const rootDir = path.resolve(root.pathname);
const distDir = path.join(rootDir, "dist");

await fs.mkdir(distDir, { recursive: true });
await fs.copyFile(
  path.join(rootDir, "openclaw.plugin.json"),
  path.join(distDir, "openclaw.plugin.json"),
);
