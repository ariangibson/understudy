/**
 * The understudy command:
 *
 *   understudy                     start the gateway (default)
 *   understudy setup               interactive wizard: keys, chain, harness wiring
 *   understudy enable [harness]    route harnesses through the gateway (default: all)
 *   understudy disable [harness]   hand harnesses back their direct connections
 *   understudy status              gateway health + who's routed through it
 *   understudy login <provider>    OAuth login for subscription providers
 */

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case undefined:
    case "serve":
      await import("./index.js");
      return;
    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup();
      return;
    }
    case "enable":
    case "disable": {
      const { runToggle } = await import("./harnesses.js");
      await runToggle(command, process.argv[3]);
      return;
    }
    case "status": {
      const { runStatus } = await import("./harnesses.js");
      await runStatus();
      return;
    }
    case "login": {
      const { runLogin } = await import("./login.js");
      await runLogin(process.argv[3]);
      return;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error(
        "usage: understudy [serve|setup|enable [harness]|disable [harness]|status|login <provider>]",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
