import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { bundledGentleShell } from "./config.ts";
import { directAccess, type EngineAccess } from "./engine-access.ts";
import { resolveEngramBin, runtimeDir } from "./runtime.ts";

/**
 * The folder with the `pi` executable bundled with the daemon. The engine's
 * first-run setup needs `pi` on PATH, and a clean machine has none. An installed
 * app carries a relocatable `pi` in `<runtime>/bin`; pnpm's shim is not relocatable.
 */
function bundledBinDir(base: NodeJS.ProcessEnv): string | undefined {
	const runtime = runtimeDir(base);
	if (runtime) return join(runtime, "bin");
	const require = createRequire(import.meta.url);
	for (const dir of require.resolve.paths("@earendil-works/pi-coding-agent") ?? []) {
		const bin = join(dir, ".bin");
		if (existsSync(join(bin, "pi"))) return bin;
	}
	return undefined;
}

/** Creates `path` with mode 0700, and tightens it to 0700 when it already exists. */
export function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

/** The file gentle-shell writes into a home it created (gentle-pi `bin/gentle-shell.mjs`). */
export const ENGINE_HOME_MARKER = ".gentle-shell-home";

/** The bundled gentle-pi's version, which gentle-shell names in its marker; informational only. */
function engineVersion(): string | undefined {
	try {
		const manifest = join(dirname(bundledGentleShell()), "..", "package.json");
		return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/**
 * Marks the assistant's own engine home as gentle-shell's (S35.3, #13). gentle-shell runs its
 * first-run setup (the companion packages) only in a home it created: one that did not exist, or
 * that holds its marker. The daemon writes `auth.json` and `mcp.json` there before the engine's
 * first start, so without the marker the engine took the home for someone else's and never set
 * it up. The marker has gentle-shell's own format (`{"createdBy":"gentle-shell","version":…}`; it
 * checks only that the file exists). One already there is left as it is. Call it only for the
 * default `<data>/agent`: a home the user chose may be theirs, and is never marked.
 */
export function claimEngineHome(
	agentHome: string,
	log: (line: string) => void = () => {},
	access: EngineAccess = directAccess,
): void {
	const content = `${JSON.stringify({ createdBy: "gentle-shell", version: engineVersion() })}\n`;
	try {
		access(() => {
			ensurePrivateDir(agentHome);
			writeFileSync(join(agentHome, ENGINE_HOME_MARKER), content, { flag: "wx", mode: 0o600 });
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST")
			log(`could not mark the engine's home as its own: ${(error as Error).message}`);
	}
}

/** Variables that could point the engine back at the user's own setup. */
const INHERITED_HOMES = ["PI_CODING_AGENT_DIR", "GENTLE_PI_AGENT_HOME", "GENTLE_SHELL_CONFIG"];

/**
 * What a subagent run sets for its child engines (gentle-pi `lib/agents-runner.ts`), and the command
 * line those children would run instead of the engine. The assistant's engine is never a child, and
 * its children run the same engine as it does.
 */
const SUBAGENT_VARIABLES = [
	"GENTLE_PI_AGENTS_CHILD",
	"GENTLE_PI_AGENTS_OWNED_IPC",
	"GENTLE_PI_AGENTS_PARENT_PERMISSION_FD",
	"GENTLE_PI_AGENTS_PI",
];

/** What only the daemon may hold: the server's connector secrets key (S25.8). */
const DAEMON_ONLY = ["GENTLE_DOT_SECRETS_KEY"];

/** Subagents are on unless `GENTLE_DOT_SUBAGENTS` is `off`, `0`, or `false`. */
export function subagentsEnabled(base: NodeJS.ProcessEnv): boolean {
	const value = base.GENTLE_DOT_SUBAGENTS?.trim().toLowerCase();
	return !(value === "off" || value === "0" || value === "false");
}

/** The memory project every memory the assistant saves or searches belongs to. */
export const MEMORY_PROJECT = "gentle-dot";

/** The memory server port of the private memory (`GENTLE_DOT_ENGRAM=private`). */
export const PRIVATE_ENGRAM_PORT = "7438";

/**
 * Names the memory project of `workspace` through Engram's per-folder setting
 * (`.engram/config.json`), which Engram reads before any other detection.
 */
export function ensureMemoryProject(workspace: string, access: EngineAccess = directAccess): void {
	const file = join(workspace, ".engram", "config.json");
	access(() => {
		ensurePrivateDir(join(workspace, ".engram"));
		// Written next to it and renamed over it: a link planted at its place is replaced, never followed.
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ project_name: MEMORY_PROJECT })}\n`);
		renameSync(temp, file);
	});
}

/**
 * The engine's environment: its own HOME (`<dataDir>/home`, mode 0700) with
 * the XDG folders under it, because parts of the engine write to fixed places
 * under the home folder. PATH is kept, with the bundled `pi` folder first, and so is the user's git identity,
 * through `GIT_CONFIG_GLOBAL` pointing at their real `~/.gitconfig`.
 *
 * Memory is the user's global Engram: Engram ties a server to its data folder
 * (by default under HOME), so `ENGRAM_DATA_DIR` points at the user's real one
 * (`GENTLE_DOT_ENGRAM_DATA_DIR` overrides it) and the memory plugin accepts the
 * user's server. The user's own `ENGRAM_PORT` and `ENGRAM_URL` are kept.
 * `GENTLE_DOT_ENGRAM=private` instead runs a memory of its own under the
 * engine's home, on port 7438 (`GENTLE_DOT_ENGRAM_PORT` overrides it).
 * The server's connector secrets key (`GENTLE_DOT_SECRETS_KEY`, S25.8) is never passed on.
 * Subagents are on (`GENTLE_PI_AGENTS=1`) unless `GENTLE_DOT_SUBAGENTS=off`: their child engines
 * reach connectors only through the daemon's proxy, like the engine itself (S25.4).
 *
 * Without a `TMPDIR` (the installed app's launch on Linux), the engine gets a
 * private one under its home: it caches compiled extensions in the temporary
 * folder, and a shared `/tmp` would let another local user plant that cache.
 * On Windows, USERPROFILE and AppData also live under the engine home; TEMP,
 * TMP and TMPDIR always use its own temporary folder, never inherited profile paths.
 * These environment redirects are not a sandbox. On Windows ensurePrivateDir's
 * modes are no-ops: privacy comes from the data folder's inheritable owner-only
 * DACL, set by the desktop app (win_file.rs), which every folder made here inherits.
 *
 * An installed app (`GENTLE_DOT_RUNTIME`) also names the Engram binary
 * (`ENGRAM_BIN`, see `resolveEngramBin`), since its PATH has no user folders.
 */
export function isolatedAgentEnv(
	base: NodeJS.ProcessEnv,
	dataDir: string,
	access: EngineAccess = directAccess,
): NodeJS.ProcessEnv {
	// Capture the original home before redirecting Windows' profile variables.
	const windows = process.platform === "win32";
	const realHome = base.HOME || (windows ? base.USERPROFILE : undefined) || homedir();
	const home = join(dataDir, "home");
	access(() => ensurePrivateDir(home));
	const env: NodeJS.ProcessEnv = {
		...base,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_STATE_HOME: join(home, ".local", "state"),
	};
	for (const key of [...INHERITED_HOMES, ...SUBAGENT_VARIABLES, ...DAEMON_ONLY]) delete env[key];
	if (windows) {
		env.USERPROFILE = home;
		const roaming = join(home, "AppData", "Roaming");
		const local = join(home, "AppData", "Local");
		env.APPDATA = roaming;
		env.LOCALAPPDATA = local;
		access(() => {
			ensurePrivateDir(roaming);
			ensurePrivateDir(local);
		});
	}
	if (windows || !base.TMPDIR) {
		const tmp = join(home, ".cache", "tmp");
		env.TMPDIR = tmp;
		if (windows) {
			env.TEMP = tmp;
			env.TMP = tmp;
		}
		access(() => ensurePrivateDir(tmp));
	}
	const bin = bundledBinDir(base);
	if (bin) {
		const rest = (base.PATH ?? "").split(delimiter).filter((part) => part && part !== bin);
		env.PATH = [bin, ...rest].join(delimiter);
	}
	// The user's own Gentle Shell setting is not the assistant's.
	env.GENTLE_PI_AGENTS = subagentsEnabled(base) ? "1" : "0";
	if (base.GENTLE_DOT_ENGRAM === "private") {
		env.ENGRAM_PORT = base.GENTLE_DOT_ENGRAM_PORT || PRIVATE_ENGRAM_PORT;
		delete env.ENGRAM_URL;
		delete env.ENGRAM_DATA_DIR;
	} else {
		env.ENGRAM_DATA_DIR =
			base.GENTLE_DOT_ENGRAM_DATA_DIR || base.ENGRAM_DATA_DIR || join(realHome, ".engram");
	}
	const runtime = runtimeDir(base);
	if (runtime) env.ENGRAM_BIN = resolveEngramBin(base, runtime, { home: realHome });
	const gitConfig = join(realHome, ".gitconfig");
	if (!base.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
	return env;
}

/**
 * In private memory mode (`GENTLE_DOT_ENGRAM=private`) the engine's memory plugin starts a memory
 * server on the private port, and it outlives the engine. When nothing listened on that port as the
 * daemon started, the daemon caused it, so `stop()` ends it when the daemon closes: the PID that
 * listens on the port, and only after its `/health` instance id matches the private data folder's
 * (`<dataDir>/home/.engram/.instance-id`). Undefined outside private mode or when it already ran.
 */
export async function privateMemory(
	base: NodeJS.ProcessEnv,
	dataDir: string,
	log: (line: string) => void,
	access: EngineAccess = directAccess,
): Promise<{ stop(): Promise<void> } | undefined> {
	if (base.GENTLE_DOT_ENGRAM !== "private") return undefined;
	const port = base.GENTLE_DOT_ENGRAM_PORT || PRIVATE_ENGRAM_PORT;
	// Only a free port means the daemon caused the server: one owner is not ours, unknown cannot be told.
	if ((await listeningPid(port)).state !== "absent") return undefined;
	return {
		async stop() {
			// Only a single, certain owner may be stopped; no listener or an unknown owner never is.
			const owner = await listeningPid(port);
			if (owner.state !== "one") return;
			const pid = owner.pid;
			let expected: string;
			try {
				const file = join(dataDir, "home", ".engram", ".instance-id");
				expected = access(() => readFileSync(file, "utf8")).trim();
			} catch {
				return;
			}
			const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
				.then((response) => response.json() as Promise<{ instance_id?: unknown }>)
				.catch(() => undefined);
			if (!expected || health?.instance_id !== expected) {
				log(`the memory server on port ${port} serves other data; left running`);
				return;
			}
			try {
				process.kill(pid, "SIGTERM");
				log(`stopped the private memory server (pid ${pid})`);
			} catch {}
		},
	};
}

/** Who listens on a port: nobody, exactly one process, or it cannot be told (never managed or killed). */
export type ListeningPid = { state: "absent" } | { state: "one"; pid: number } | { state: "unknown" };

const ABSENT: ListeningPid = { state: "absent" };
const UNKNOWN: ListeningPid = { state: "unknown" };

/** The PID listening on `port` on this computer: `netstat` on Windows, `lsof` elsewhere. */
export function listeningPid(port: string): Promise<ListeningPid> {
	return process.platform === "win32" ? netstatListeners(port) : lsofListener(port);
}

/** The Unix answer: one PID, or absent for everything else, as the daemon always treated it. */
async function lsofListener(port: string): Promise<ListeningPid> {
	const pid = await lsofPid(port);
	return pid === undefined ? ABSENT : { state: "one", pid };
}

/** The one PID listening on `port` on this computer (`lsof`), if any. */
function lsofPid(port: string): Promise<number | undefined> {
	return new Promise((resolve) => {
		execFile("lsof", ["-t", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN"], (error, stdout) => {
			const pids = [...new Set(String(stdout).trim().split("\n").filter(Boolean))];
			resolve(!error && pids.length === 1 && /^\d+$/.test(pids[0] ?? "") ? Number(pids[0]) : undefined);
		});
	});
}

/**
 * Asks `netstat` by its absolute system path (no shell, no PATH lookup). A tool failure is unknown.
 * No `-p` filter: `-p TCP` lists IPv4 sockets only, so an IPv6 listener would read as absent.
 */
function netstatListeners(port: string): Promise<ListeningPid> {
	const netstat = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\NETSTAT.EXE`;
	return new Promise((resolve) => {
		execFile(
			netstat,
			["-ano"],
			{ windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout) => resolve(error ? UNKNOWN : parseNetstatListeners(String(stdout), port)),
		);
	});
}

/**
 * Reads `netstat -ano` output for the sockets listening on `port` (an exact match, so 74380 and
 * 17438 are not 7438). A listening TCP socket is recognized by its unconnected foreign address
 * (`0.0.0.0:0` or `[::]:0`), not by the state text, which Windows localizes. Distinct PIDs, a
 * malformed TCP row, a non-table output or a bad `port` are unknown; empty output is absent.
 */
export function parseNetstatListeners(output: string, port: string): ListeningPid {
	if (!/^\d+$/.test(port)) return UNKNOWN;
	const wanted = Number(port);
	const pids = new Set<number>();
	let tcpRows = 0;
	for (const line of output.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields[0] !== "TCP") continue;
		tcpRows++;
		// Proto, local, foreign, state (one word in every locale seen), PID.
		if (fields.length < 5) return UNKNOWN;
		const [, local = "", foreign = ""] = fields;
		const localPort = local.slice(local.lastIndexOf(":") + 1);
		if (!/^\d+$/.test(localPort)) return UNKNOWN;
		if (foreign !== "0.0.0.0:0" && foreign !== "[::]:0") continue;
		if (Number(localPort) !== wanted) continue;
		const pid = fields[fields.length - 1] ?? "";
		if (!/^\d+$/.test(pid) || Number(pid) === 0) return UNKNOWN;
		pids.add(Number(pid));
	}
	if (tcpRows === 0) return output.trim() === "" ? ABSENT : UNKNOWN;
	if (pids.size === 0) return ABSENT;
	const [only] = pids;
	return pids.size === 1 && only !== undefined ? { state: "one", pid: only } : UNKNOWN;
}
