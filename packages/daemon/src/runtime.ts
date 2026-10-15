import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";

/**
 * The installed app's runtime folder (`GENTLE_DOT_RUNTIME`), or undefined in a
 * source checkout. It holds `node/`, `bin/` (`engram`, `pi`),
 * `daemon/` (this bundle and its `node_modules/`) and `ui/`.
 */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.GENTLE_DOT_RUNTIME ? resolve(env.GENTLE_DOT_RUNTIME) : undefined;
}

/** The runtime's flat install of the daemon's external dependencies. */
export function runtimeModules(runtime: string): string {
	return join(runtime, "daemon", "node_modules");
}

/** Where a user's own Engram usually lives, after their PATH. */
export function engramKnownDirs(home: string, platform: NodeJS.Platform = process.platform): string[] {
	if (platform === "win32") return [join(home, "go", "bin"), join(home, ".local", "bin")];
	return [join(home, "go", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin")];
}

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * The `engram` the user's login shell finds. The app starts with a fixed PATH,
 * so the shell builds the user's own from their profile, starting from the system one.
 */
function loginShellEngram(env: NodeJS.ProcessEnv, home: string): string | undefined {
	try {
		const output = execFileSync(env.SHELL || "/bin/sh", ["-l", "-c", "command -v engram"], {
			env: { ...env, HOME: home, PATH: SYSTEM_PATH },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		const found = output.trim().split("\n").at(-1)?.trim() ?? "";
		return isAbsolute(found) && isExecutableFile(found) ? found : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The Engram binary of an installed app: `ENGRAM_BIN`, then an `engram` on the
 * user's login PATH (GENTLE_DOT_USER_PATH, or PATH minus this runtime's bins,
 * on Windows) or in the usual folders,
 * so the user's own version keeps serving `~/.engram`, and only then the one
 * the runtime carries. Windows searches for `engram.exe` without invoking a shell.
 */
export function resolveEngramBin(
	env: NodeJS.ProcessEnv,
	runtime: string,
	options: { home?: string; knownDirs?: string[]; platform?: NodeJS.Platform } = {},
): string {
	if (env.ENGRAM_BIN) return env.ENGRAM_BIN;
	const platform = options.platform ?? process.platform;
	const windows = platform === "win32";
	const home = options.home ?? (env.HOME || (windows ? env.USERPROFILE : undefined) || homedir());
	const executable = windows ? "engram.exe" : "engram";
	if (!windows) {
		const fromLogin = loginShellEngram(env, home);
		if (fromLogin) return fromLogin;
	}
	// Like the desktop's Windows bootstrap, prefer the user's PATH, never the
	// current directory (empty or relative entries), over the bundled binary.
	const runtimeBins = [join(runtime, "bin"), join(runtime, "node", "bin")].map((dir) =>
		win32.resolve(dir).toLowerCase(),
	);
	const pathDirs = windows
		? (env.GENTLE_DOT_USER_PATH ?? env.PATH ?? "")
				.split(";")
				.filter((dir) => isAbsolute(dir) && !runtimeBins.includes(win32.resolve(dir).toLowerCase()))
		: [];
	for (const dir of [...pathDirs, ...(options.knownDirs ?? engramKnownDirs(home, platform))]) {
		const bin = join(dir, executable);
		if (isExecutableFile(bin)) return bin;
	}
	return join(runtime, "bin", executable);
}
