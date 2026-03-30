#!/usr/bin/env node

import { Cli } from "./cli.js";

async function main() {
  const cli = new Cli();
  await cli.run(process.argv.slice(2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
