/**
 * The understudy command:
 *
 *   understudy                     start the gateway in the foreground
 *                                  (first run: setup wizard at a TTY,
 *                                  non-interactive setup otherwise)
 *   understudy start|stop|restart  run the gateway as a service that
 *                                  outlives the shell (launchd / systemd)
 *   understudy logs [-n N] [-f]    tail the service log
 *   understudy setup [flags]       (re-)run setup; --yes for no prompts,
 *                                  --json for a machine-readable report
 *   understudy enable [harness]    route harnesses through the gateway (default: all)
 *   understudy disable [harness]   hand harnesses back their direct connections
 *   understudy status [--json]     gateway health + service + who's routed
 *   understudy doctor [--json]     check everything, print the fix for each miss
 *   understudy login <provider>    OAuth login for subscription providers
 *                                  (repeat to add seats; --reset to forget)
 *
 * Agents: AGENTS.md at the repo root (also https://understudy.cc/AGENTS.md)
 * is the runbook for doing all of this on someone's behalf.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Every subcommand works relative to the gateway home (.env, data/, logs/):
// UNDERSTUDY_HOME if set, else the cwd when it holds a .env (the installed
// launcher cd's into ~/.understudy; a source checkout has its own), else
// ~/.understudy when that has been set up, else the cwd (first run).
const HOME_CANDIDATES = [
  process.env.UNDERSTUDY_HOME,
  existsSync(".env") ? process.cwd() : undefined,
  existsSync(join(homedir(), ".understudy", ".env")) ? join(homedir(), ".understudy") : undefined,
].filter((p): p is string => Boolean(p));
if (HOME_CANDIDATES[0] && HOME_CANDIDATES[0] !== process.cwd()) {
  process.chdir(HOME_CANDIDATES[0]);
  if (!process.env.UNDERSTUDY_HOME) {
    console.error(`understudy: using gateway home ${HOME_CANDIDATES[0]} (set UNDERSTUDY_HOME to override)`);
  }
}

const command = process.argv[2];
const rest = process.argv.slice(3);

const USAGE = `usage: understudy [serve|start|stop|restart|logs|setup|enable|disable|status|doctor|login] [flags]

  serve                 run in the foreground (default)
  start|stop|restart    run as a service (launchd on macOS, systemd --user on Linux)
  logs [-n N] [-f]      show the service log
  setup [--yes] [--json] [--<provider>-key K] [--chain a,b] [--gateway-key K|generate]
        [--port N] [--set KEY=VALUE] [--enable all|none|claude,codex,...]
  enable|disable [harness]
  status [--json]
  doctor [--json]
  login chatgpt|anthropic|copilot [--reset]

Agent runbook: https://understudy.cc/AGENTS.md`;

async function main(): Promise<void> {
  switch (command) {
    case undefined:
    case "serve":
      // First run (no .env yet): a human at a TTY gets the wizard; anything
      // else (an agent, a service manager, a pipe) gets non-interactive
      // setup from flags and env vars. Then raise the curtain. The launcher
      // runs us from the gateway's home, so .env sits in cwd.
      if (!existsSync(".env")) {
        const { runSetup } = await import("./setup.js");
        await runSetup({ firstRun: true, args: rest });
      }
      await import("./index.js");
      return;
    case "start":
    case "stop":
    case "restart":
    case "logs": {
      const { runService } = await import("./service.js");
      await runService(command, rest);
      return;
    }
    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup({ args: rest });
      return;
    }
    case "enable":
    case "disable": {
      const { runToggle } = await import("./harnesses.js");
      await runToggle(command, rest[0]);
      return;
    }
    case "status": {
      const { runStatus } = await import("./harnesses.js");
      await runStatus(rest);
      return;
    }
    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor(rest);
      return;
    }
    case "login": {
      const { runLogin } = await import("./login.js");
      await runLogin(rest[0], rest.slice(1));
      return;
    }
    case "version":
    case "--version":
    case "-v": {
      const pkg = JSON.parse(
        readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
      ) as { version: string };
      console.log(pkg.version);
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
