/**
 * Running the gateway as a service that outlives the shell:
 *
 *   understudy start      install + start (launchd on macOS, systemd --user
 *                         on Linux, a detached process with a pidfile elsewhere)
 *   understudy stop       stop and uninstall the service
 *   understudy restart    stop, then start
 *   understudy logs       tail the gateway log (-n N, -f)
 *
 * `start` is idempotent and returns only once /health answers (or after a
 * timeout, with a non-zero exit), so an agent can chain it with `status`.
 * Config (.env), data, and logs all live in the gateway home - the
 * directory the launcher cd's into (~/.understudy for an installed copy).
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Manager = "launchd" | "systemd" | "pidfile";

export const LAUNCHD_LABEL = "cc.understudy.gateway";
export const SYSTEMD_UNIT = "understudy";

export interface ServicePaths {
  /** Gateway home: cwd of the launcher; holds .env, data/, logs/. */
  home: string;
  node: string;
  cli: string;
  log: string;
  pidfile: string;
  plist: string;
  unit: string;
}

export function servicePaths(userHome = homedir(), gatewayHome = process.cwd()): ServicePaths {
  return {
    home: gatewayHome,
    node: process.execPath,
    cli: resolve(process.argv[1] ?? "dist/cli.js"),
    log: join(gatewayHome, "logs", "understudy.log"),
    pidfile: join(gatewayHome, "understudy.pid"),
    plist: join(userHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    unit: join(userHome, ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`),
  };
}

export function detectManager(os: NodeJS.Platform = platform()): Manager {
  // Escape hatch for containers, CI, and tests: UNDERSTUDY_SERVICE=pidfile.
  const forced = process.env.UNDERSTUDY_SERVICE;
  if (forced === "launchd" || forced === "systemd" || forced === "pidfile") return forced;
  if (os === "darwin" && onPath("launchctl")) return "launchd";
  if (os === "linux" && onPath("systemctl")) {
    // A user manager needs a session bus; containers and bare SSH often lack one.
    const probe = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" });
    if (probe.status === 0) return "systemd";
  }
  return "pidfile";
}

function onPath(cmd: string): boolean {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

// ---------------------------------------------------------------------------
// Unit files (pure)

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist(p: Pick<ServicePaths, "node" | "cli" | "home" | "log">): string {
  const pathEnv = [dirname(p.node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.node)}</string>
    <string>${xml(p.cli)}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(p.home)}</string>
  <key>StandardOutPath</key><string>${xml(p.log)}</string>
  <key>StandardErrorPath</key><string>${xml(p.log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export function systemdUnit(p: Pick<ServicePaths, "node" | "cli" | "home" | "log">): string {
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=understudy - LLM failover gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${p.home}
ExecStart=${q(p.node)} ${q(p.cli)} serve
Restart=always
RestartSec=2
StandardOutput=append:${p.log}
StandardError=append:${p.log}

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// Status

export interface ServiceStatus {
  manager: Manager;
  /** A unit/plist/pidfile is on disk for the gateway. */
  installed: boolean;
  running: boolean;
  pid: number | null;
  log: string;
}

export function serviceStatus(paths = servicePaths(), manager = detectManager()): ServiceStatus {
  const base = { manager, log: paths.log };
  if (manager === "launchd") {
    const installed = existsSync(paths.plist);
    const out = spawnSync("launchctl", ["print", `gui/${uid()}/${LAUNCHD_LABEL}`], {
      encoding: "utf8",
    });
    const running = out.status === 0 && /state = running/.test(out.stdout);
    const pid = Number(out.stdout?.match(/\bpid = (\d+)/)?.[1]) || null;
    return { ...base, installed, running, pid };
  }
  if (manager === "systemd") {
    const installed = existsSync(paths.unit);
    const active = spawnSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT], {
      encoding: "utf8",
    });
    const running = active.stdout?.trim() === "active";
    const show = spawnSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", SYSTEMD_UNIT], {
      encoding: "utf8",
    });
    const pid = Number(show.stdout?.trim()) || null;
    return { ...base, installed, running, pid };
  }
  const pid = readPid(paths.pidfile);
  const running = pid !== null && alive(pid);
  return { ...base, installed: pid !== null, running, pid: running ? pid : null };
}

function uid(): number {
  return process.getuid?.() ?? 501;
}

function readPid(pidfile: string): number | null {
  try {
    const n = Number(readFileSync(pidfile, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Actions

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export function installAndStart(paths: ServicePaths, manager: Manager): void {
  mkdirSync(dirname(paths.log), { recursive: true });
  if (manager === "launchd") {
    mkdirSync(dirname(paths.plist), { recursive: true });
    writeFileSync(paths.plist, launchdPlist(paths));
    run("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]); // ignore: may not be loaded
    const r = run("launchctl", ["bootstrap", `gui/${uid()}`, paths.plist]);
    if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`);
    return;
  }
  if (manager === "systemd") {
    mkdirSync(dirname(paths.unit), { recursive: true });
    writeFileSync(paths.unit, systemdUnit(paths));
    run("systemctl", ["--user", "daemon-reload"]);
    const r = run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    if (!r.ok) throw new Error(`systemctl enable --now failed: ${r.out}`);
    run("systemctl", ["--user", "restart", SYSTEMD_UNIT]); // pick up a rewritten unit
    return;
  }
  const existing = readPid(paths.pidfile);
  if (existing && alive(existing)) return;
  const fd = openSync(paths.log, "a");
  const child = spawn(paths.node, [paths.cli, "serve"], {
    cwd: paths.home,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  writeFileSync(paths.pidfile, `${child.pid}\n`);
}

export function stopAndUninstall(paths: ServicePaths, manager: Manager): boolean {
  if (manager === "launchd") {
    const was = existsSync(paths.plist);
    run("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
    if (was) rmSync(paths.plist, { force: true });
    return was;
  }
  if (manager === "systemd") {
    const was = existsSync(paths.unit);
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    if (was) rmSync(paths.unit, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    return was;
  }
  const pid = readPid(paths.pidfile);
  if (pid && alive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (existsSync(paths.pidfile)) unlinkSync(paths.pidfile);
  return pid !== null;
}

export function gatewayBaseUrl(home = process.cwd()): string {
  let port = Number(process.env.PORT ?? 0);
  if (!port) {
    try {
      port = Number(readFileSync(join(home, ".env"), "utf8").match(/^PORT=(\d+)/m)?.[1] ?? 42986);
    } catch {
      port = 42986;
    }
  }
  return `http://localhost:${port}`;
}

export async function healthUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthUp(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function waitForDown(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await healthUp(baseUrl))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ---------------------------------------------------------------------------
// CLI

export async function runService(
  action: "start" | "stop" | "restart" | "logs",
  args: string[],
): Promise<void> {
  const json = args.includes("--json");
  const paths = servicePaths();
  const manager = detectManager();
  const baseUrl = gatewayBaseUrl(paths.home);

  if (paths.cli.endsWith(".ts")) {
    console.error(
      "service commands need the installed `understudy` command (from install.sh); in a source checkout use `npm run dev`.",
    );
    process.exit(1);
  }

  if (action === "logs") {
    const n = Number(args[args.indexOf("-n") + 1]) || 50;
    if (!existsSync(paths.log)) {
      console.log(`no log yet at ${paths.log} - start the gateway with \`understudy start\``);
      return;
    }
    if (args.includes("-f")) {
      const tail = spawn("tail", ["-n", String(n), "-f", paths.log], { stdio: "inherit" });
      await new Promise((r) => tail.on("exit", r));
      return;
    }
    const lines = readFileSync(paths.log, "utf8").trimEnd().split("\n");
    console.log(lines.slice(-n).join("\n"));
    return;
  }

  if (action === "stop" || action === "restart") {
    const was = stopAndUninstall(paths, manager);
    const down = await waitForDown(baseUrl, 5000);
    if (action === "stop") {
      const status = serviceStatus(paths, manager);
      if (json) console.log(JSON.stringify({ ...status, base_url: baseUrl, stopped: was }, null, 2));
      else if (!was && down) console.log(`gateway   not installed as a service (nothing answering at ${baseUrl})`);
      else if (!down)
        console.log(
          `gateway   still answering at ${baseUrl} - something other than the service is running it (\`understudy serve\` in a terminal?)`,
        );
      else console.log(`gateway   stopped (${manager}). House lights up; harness routing is unchanged - \`understudy disable\` to hand agents back their direct connections.`);
      return;
    }
  }

  // start (or the second half of restart)
  if (!existsSync(join(paths.home, ".env"))) {
    console.error(
      `no .env in ${paths.home} - run \`understudy setup --yes ...\` first (see AGENTS.md for the flags)`,
    );
    process.exit(1);
  }
  const alreadyUp = await healthUp(baseUrl);
  const before = serviceStatus(paths, manager);
  if (alreadyUp && !before.installed) {
    const msg = `gateway   already answering at ${baseUrl} but not as a ${manager} service - stop that process first, then \`understudy start\``;
    if (json) console.log(JSON.stringify({ ...before, base_url: baseUrl, up: true, started: false, note: msg }, null, 2));
    else console.log(msg);
    process.exit(1);
  }
  try {
    installAndStart(paths, manager);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const up = await waitForHealth(baseUrl, 15000);
  const status = serviceStatus(paths, manager);
  if (json) {
    console.log(JSON.stringify({ ...status, base_url: baseUrl, up, started: true }, null, 2));
  } else if (up) {
    console.log(`🎭 understudy is in the wings - ${baseUrl} (${manager}${status.pid ? `, pid ${status.pid}` : ""})`);
    console.log(`   logs: understudy logs -f   (${paths.log})`);
  } else {
    console.error(`gateway did not answer at ${baseUrl} within 15s - check \`understudy logs\``);
  }
  if (!up) process.exit(1);
}
