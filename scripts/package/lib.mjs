// Pure helpers for staging the installed app's runtime (`stage-runtime.mjs`).
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync } from "node:fs";
import { join, win32 } from "node:path";

/**
 * The targets a runtime can be staged for, with the names Node's and Engram's
 * release assets use for each.
 */
export const TARGETS = Object.freeze({
	"darwin-arm64": { platform: "darwin", arch: "arm64", node: "darwin-arm64", engram: "darwin_arm64" },
	"linux-arm64": { platform: "linux", arch: "arm64", node: "linux-arm64", engram: "linux_arm64" },
	"linux-x64": { platform: "linux", arch: "x64", node: "linux-x64", engram: "linux_amd64" },
	"win32-x64": { platform: "win32", arch: "x64", node: "win-x64", engram: "windows_amd64" },
});

/** The Node release staged when `.nvmrc` names only a major version; it must stay on that major. */
export const PINNED_NODE_VERSION = "24.14.1";

export const USAGE =
	"usage: stage-runtime --target <darwin-arm64|linux-arm64|linux-x64|win32-x64> [--out <dir>] [--engram-version <x.y.z>]";

/** Parses the command line; throws with the usage on anything unexpected. */
export function parseArgs(argv) {
	const args = argv.filter((arg) => arg !== "--");
	const options = {};
	const names = { "--target": "target", "--out": "out", "--engram-version": "engramVersion" };
	for (let i = 0; i < args.length; i += 2) {
		const name = names[args[i]];
		const value = args[i + 1];
		if (!name || value === undefined || value.startsWith("--"))
			throw new Error(`Unexpected argument ${args[i]}.\n${USAGE}`);
		options[name] = value;
	}
	if (!options.target) throw new Error(`Missing --target.\n${USAGE}`);
	if (!Object.hasOwn(TARGETS, options.target))
		throw new Error(`Unknown target ${options.target}; expected one of ${Object.keys(TARGETS).join(", ")}.`);
	if (options.engramVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(options.engramVersion))
		throw new Error(`--engram-version must be x.y.z, got ${options.engramVersion}.`);
	return options;
}

/** The target this machine is, or undefined when it is none of the supported ones. */
export function hostTarget(platform = process.platform, arch = process.arch) {
	return Object.keys(TARGETS).find(
		(name) => TARGETS[name].platform === platform && TARGETS[name].arch === arch,
	);
}

/**
 * Throws when `target` is not the machine staging it: the daemon's dependencies
 * carry native, per-platform pieces that npm installs for the machine it runs on.
 */
export function assertHostTarget(target, host = hostTarget()) {
	if (target === host) return;
	throw new Error(
		`Cannot stage ${target} on ${host ?? `${process.platform}-${process.arch}`}: the runtime's dependencies ` +
			`include native pieces for the machine that installs them. Stage ${target} on a ${target} machine ` +
			"or container (Linux targets are staged inside a container).",
	);
}

/** The exact Node version: `.nvmrc` when it is exact, else the pinned one, which must share its major. */
export function nodeVersion(nvmrc, pinned = PINNED_NODE_VERSION) {
	const wanted = nvmrc.trim().replace(/^v/, "");
	if (/^\d+\.\d+\.\d+$/.test(wanted)) return wanted;
	if (/^\d+$/.test(wanted) && pinned.split(".")[0] === wanted) return pinned;
	throw new Error(`.nvmrc asks for Node ${wanted}, but the pinned release is ${pinned}; update one of them.`);
}

export function nodeArchiveName(version, target) {
	return `node-v${version}-${TARGETS[target].node}.${TARGETS[target].platform === "win32" ? "zip" : "tar.gz"}`;
}

export function engramArchiveName(version, target) {
	return `engram_${version}_${TARGETS[target].engram}.${TARGETS[target].platform === "win32" ? "zip" : "tar.gz"}`;
}

/**
 * The members staged from a Node archive and where each lands under `node/`. The
 * Windows ZIP keeps `node.exe` and npm at its top level; they land in the Unix layout.
 */
export function nodeArchiveEntries(version, target) {
	const root = nodeArchiveName(version, target).replace(/\.(tar\.gz|zip)$/, "");
	const windows = TARGETS[target].platform === "win32";
	const entries = windows
		? [
				{ member: `${root}/node.exe`, path: "bin/node.exe" },
				{ member: `${root}/node_modules/npm`, path: "lib/node_modules/npm" },
			]
		: [
				{ member: `${root}/bin/node`, path: "bin/node" },
				{ member: `${root}/lib/node_modules/npm`, path: "lib/node_modules/npm" },
			];
	return { root, entries: [...entries, { member: `${root}/LICENSE`, path: "LICENSE" }] };
}

/** The Engram executable inside its release archive. */
export function engramBinaryName(target) {
	return TARGETS[target].platform === "win32" ? "engram.exe" : "engram";
}

/** The Windows folder, from the environment, else its default. */
function windowsRoot(env) {
	return env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
}

/**
 * The `tar` that unpacks a target's archives. On Windows it is the system's own
 * `tar.exe` (bsdtar), which reads ZIP; the GNU tar Git Bash puts first on PATH does not.
 */
export function archiveExtractor(target, env = process.env) {
	if (TARGETS[target].platform !== "win32") return { command: "tar", flags: "-xzf" };
	return { command: win32.join(windowsRoot(env), "System32", "tar.exe"), flags: "-xf" };
}

/**
 * The environment of the staging `npm install`: no user npmrc, a cache of its own, and a
 * scratch profile for install scripts, all under `cache`. Windows gets a project-local
 * profile and temp folder, and a PATH of the staged Node, the host's Go (`goBin`; gentle-pi
 * builds its Gentle AI binary from source there), and the system folders only.
 * @param {{ platform: string, nodeBin: string, cache: string, goBin?: string, env?: Record<string, string | undefined> }} options
 */
export function npmInstallEnv({ platform, nodeBin, cache, goBin, env = process.env }) {
	const path = platform === "win32" ? win32 : { join };
	const npmConfig = {
		npm_config_userconfig: path.join(cache, "npmrc"),
		npm_config_cache: path.join(cache, "npm-cache"),
		npm_config_registry: "https://registry.npmjs.org/",
		npm_config_update_notifier: "false",
	};
	const home = path.join(cache, "npm-home");
	if (platform !== "win32")
		return {
			HOME: home,
			PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
			TMPDIR: env.TMPDIR ?? "/tmp",
			...npmConfig,
		};
	const root = windowsRoot(env);
	const scratch = win32.join(cache, "tmp");
	return {
		HOME: home,
		USERPROFILE: home,
		APPDATA: win32.join(home, "AppData", "Roaming"),
		LOCALAPPDATA: win32.join(home, "AppData", "Local"),
		TEMP: scratch,
		TMP: scratch,
		SystemRoot: root,
		windir: root,
		ComSpec: env.ComSpec || win32.join(root, "System32", "cmd.exe"),
		PATHEXT: env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
		PATH: [nodeBin, goBin, win32.join(root, "System32"), root].filter(Boolean).join(";"),
		...npmConfig,
	};
}

/**
 * How to spawn a command found on PATH. Windows finds `pnpm.cmd` only through its
 * shell, so the command line is quoted for `cmd.exe`; characters it would expand are refused.
 */
export function hostCommand(command, args, platform = process.platform) {
	if (platform !== "win32") return { command, args, shell: false };
	const quote = (arg) => {
		if (/["%^&|<>\r\n]/.test(arg)) throw new Error(`Cannot pass ${arg} through the Windows shell.`);
		return arg === "" || /[\s()]/.test(arg) ? `"${arg}"` : arg;
	};
	return { command: [command, ...args].map(quote).join(" "), args: [], shell: true };
}

/** The SHA-256 a `SHASUMS256.txt` / `checksums.txt` listing gives `fileName`; throws when it is absent. */
export function checksumFor(listing, fileName) {
	for (const line of listing.split("\n")) {
		const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
		if (match && match[2] === fileName) return match[1];
	}
	throw new Error(`The checksum list has no entry for ${fileName}.`);
}

export function sha256File(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}

/** Throws when the file's SHA-256 is not `expected`. */
export async function verifyChecksum(path, expected) {
	const actual = await sha256File(path);
	if (actual !== expected)
		throw new Error(`Checksum mismatch for ${path}: expected ${expected}, got ${actual}.`);
}

/**
 * The release version in `engram version` output, or undefined when it is not
 * a release (a development build prints a Go pseudo-version such as `3.0.0-2026…-8e52…`).
 */
export function engramReleaseVersion(output) {
	return /^engram v?(\d+\.\d+\.\d+)\s*$/.exec(output.trim())?.[1];
}

/** The `x.y.z` of a GitHub `…/releases/tag/vx.y.z` URL. */
export function versionFromReleaseUrl(url) {
	const version = /\/releases\/tag\/v?(\d+\.\d+\.\d+)$/.exec(url ?? "")?.[1];
	if (!version) throw new Error(`Not a release URL: ${url}`);
	return version;
}

/** Bytes under `dir`, counting links as themselves and never following them. */
export function treeSize(dir) {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		total += entry.isDirectory() ? treeSize(path) : lstatSync(path).size;
	}
	return total;
}

/** Symbolic links under `dir`, relative to it. */
export function symlinksIn(dir, prefix = "") {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink()) found.push(relative);
		else if (entry.isDirectory()) found.push(...symlinksIn(join(dir, entry.name), relative));
	}
	return found;
}

export function formatSize(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The runtime's `MANIFEST.json` content. */
export function buildManifest({ target, versions, daemonCommit, sizeBytes, stagedAt }) {
	for (const key of ["node", "engram", "gentlePi"])
		if (!versions[key]) throw new Error(`The manifest needs the ${key} version.`);
	if (!daemonCommit) throw new Error("The manifest needs the daemon commit.");
	return {
		name: "gentle-dot-runtime",
		target,
		versions,
		daemonCommit,
		sizeBytes,
		size: formatSize(sizeBytes),
		stagedAt,
	};
}

/** A `bin/npm` or `bin/npx` that runs the staged Node's own npm, wherever the folder is copied. */
export function npmWrapper(cli) {
	return `#!/bin/sh
# Runs the npm bundled with this Node; a script rather than Node's symlink, so copies that follow links work.
self=$0
while [ -L "$self" ]; do
	link=$(readlink "$self")
	case $link in
		/*) self=$link ;;
		*) self=$(dirname "$self")/$link ;;
	esac
done
bin=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd -P) || exit 1
exec "$bin/node" "$bin/../lib/node_modules/npm/bin/${cli}" "$@"
`;
}

/** A Windows `bin\npm.cmd` or `bin\npx.cmd` that runs the staged Node's own npm, wherever the folder is copied. */
export function npmCmdWrapper(cli) {
	return [
		"@echo off",
		"rem Runs the npm bundled with this Node, wherever the runtime folder is copied.",
		`"%~dp0node.exe" "%~dp0..\\lib\\node_modules\\npm\\bin\\${cli}" %*`,
		"",
	].join("\r\n");
}

// macOS installer (`package-mac.mjs`).

export const MAC_USAGE =
	"usage: package-mac [--sign <identity>] [--skip-stage] [--check] [--check-dmg <dmg>] [--finder-layout]";

/** The ad hoc signing identity: no certificate, and no identity that survives a rebuild. */
export const AD_HOC = "-";

/**
 * Parses package-mac's command line. The signing identity is `--sign`, else
 * `GENTLE_DOT_SIGN_IDENTITY`, else ad hoc.
 */
export function parseMacArgs(argv, env = process.env) {
	const args = argv.filter((arg) => arg !== "--");
	const options = { skipStage: false, check: false, finderLayout: false };
	const switches = { "--skip-stage": "skipStage", "--check": "check", "--finder-layout": "finderLayout" };
	const values = { "--sign": "sign", "--check-dmg": "checkDmg" };
	for (let i = 0; i < args.length; i++) {
		if (switches[args[i]]) {
			options[switches[args[i]]] = true;
			continue;
		}
		const name = values[args[i]];
		const value = args[i + 1];
		if (!name || value === undefined || value === "" || value.startsWith("--"))
			throw new Error(`Unexpected argument ${args[i]}.\n${MAC_USAGE}`);
		options[name] = value;
		i++;
	}
	const identity = options.sign ?? (env.GENTLE_DOT_SIGN_IDENTITY || AD_HOC);
	delete options.sign;
	return { ...options, identity };
}

/**
 * Whether a file's first bytes are a Mach-O header: thin 32/64-bit, or universal.
 * A universal header shares Java's class-file magic; it counts its architectures,
 * a small number, where a class file has its version, 45 or more.
 */
export function isMachO(bytes) {
	if (bytes.length < 8) return false;
	const magic = bytes.readUInt32BE(0);
	if ([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface].includes(magic)) return true;
	if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
	const architectures = bytes.readUInt32BE(4);
	return architectures > 0 && architectures < 20;
}

/**
 * Runtime binaries that must keep their own signature: re-signing changes their
 * bytes, and gentle-pi refuses a Gentle AI binary whose SHA-256 is not its pinned release's.
 */
export function keepsOwnSignature(relative) {
	return /(^|\/)node_modules\/gentle-pi\/\.gentle-ai\//.test(relative);
}

/** Signing order for nested code: the deepest paths first, so nothing is signed before what it holds. */
export function insideOut(paths) {
	const depth = (path) => path.split("/").length;
	return [...paths].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

/**
 * The configuration `tauri build --config` merges for a release: the staged runtime
 * as the app's `runtime` resource, and the signing identity. They stay out of
 * `tauri.macos.conf.json` because tauri-build copies resources on every build, so a
 * source build (`cargo test`, `tauri dev`) would need a staged runtime.
 */
export function tauriReleaseConfig({ runtime, identity }) {
	return {
		bundle: {
			resources: { [runtime]: "runtime" },
			macOS: { signingIdentity: identity },
		},
	};
}

/** The DMG name Tauri's bundler gives a product, version, and Node-style arch. */
export function dmgFileName(productName, version, arch) {
	const names = { arm64: "aarch64", x64: "x64" };
	if (!names[arch]) throw new Error(`No DMG for arch ${arch}.`);
	return `${productName}_${version}_${names[arch]}.dmg`;
}

/**
 * Files whose permission bits differ between the staged runtime and the app's copy,
 * or that the copy lacks. Both maps are relative path → mode.
 */
export function modeDifferences(staged, bundled) {
	const differences = [];
	for (const [path, mode] of staged) {
		if (!bundled.has(path)) differences.push(`${path} (missing)`);
		else if ((bundled.get(path) & 0o777) !== (mode & 0o777))
			differences.push(
				`${path} (${(mode & 0o777).toString(8)} → ${(bundled.get(path) & 0o777).toString(8)})`,
			);
	}
	return differences;
}
