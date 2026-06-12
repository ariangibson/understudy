#!/usr/bin/env node
// Entry point for `npx github:ariangibson/understudy` and the installed bin.
// dist/ is produced by the package's prepare script at install time.
import("../dist/cli.js").catch((err) => {
  console.error("understudy: build output missing - run `npm run build` first.");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
