#!/usr/bin/env node
// Stages the installed app's `runtime/` folder (S29.5) for one target:
// `node scripts/package/stage-runtime.mjs --target darwin-arm64 [--out <dir>]`.
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	createWriteStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
	archiveExtractor,
	assertHostTarget,
	buildManifest,
	checksumFor,
	engramArchiveName,
	engramBinaryName,
	engramReleaseVersion,
	formatSize,
	hostCommand,
	nodeArchiveEntries,
	nodeArchiveName,
	nodeVersion,
	npmCmdWrapper,
	npmInstallEnv,
	npmWrapper,
	parseArgs,
	symlinksIn,
	TARGETS,
	treeSize,
	verifyChecksum,
	versionFromReleaseUrl,
} from "./lib.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CACHE = join(REPO, ".cache", "package");
const ENGRAM_RELEASES = "https://github.com/Gentleman-Programming/engram/releases";

const isWindows = (target) => TARGETS[target].platform === "win32";

const say = (line) => process.stdout.write(`${line}\n`);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.status !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}).`,
		);
	return result;
}

/** `run` for a command found on PATH, such as `pnpm`, which is `pnpm.cmd` on Windows. */
function runOnPath(command, args, options = {}) {
	const spawn = hostCommand(command, args);
	return run(spawn.command, spawn.args, spawn.shell ? { ...options, shell: true } : options);
}

async function download(url, destination) {
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`GET ${url} answered ${response.status}.`);
	const partial = `${destination}.part`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
	renameSync(partial, destination);
}

async function text(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`GET ${url} answered ${response.status}.`);
	return response.text();
}

/** A cached download of `url` whose SHA-256 is `expected`, fetched again when the cached copy differs. */
async function verifiedDownload(url, name, expected) {
	const file = join(CACHE, name);
	if (existsSync(file)) {
		try {
			await verifyChecksum(file, expected);
			say(`  cached ${name} (sha256 verified)`);
			return file;
		} catch {
			unlinkSync(file);
		}
	}
	say(`  downloading ${url}`);
	await download(url, file);
	try {
		await verifyChecksum(file, expected);
	} catch (error) {
		unlinkSync(file);
		throw error;
	}
	say(`  sha256 verified ${name}`);
	return file;
}

/** An empty output folder; a runtime staged earlier is replaced, anything else is refused. */
function prepareOut(out) {
	if (existsSync(out) && readdirSync(out).length > 0) {
		const manifest = join(out, "MANIFEST.json");
		const previous = existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name;
		if (previous !== "gentle-dot-runtime")
			throw new Error(`${out} is not empty and holds no staged runtime; choose an empty folder.`);
		rmSync(out, { recursive: true });
	}
	mkdirSync(out, { recursive: true });
}

async function stageNode(out, target) {
	const version = nodeVersion(readFileSync(join(REPO, ".nvmrc"), "utf8"));
	const base = `https://nodejs.org/dist/v${version}`;
	const archiveName = nodeArchiveName(version, target);
	say(`Node ${version}`);
	const archive = await verifiedDownload(
		`${base}/${archiveName}`,
		archiveName,
		checksumFor(await text(`${base}/SHASUMS256.txt`), archiveName),
	);
	const node = join(out, "node");
	mkdirSync(join(node, "bin"), { recursive: true });
	const { entries } = nodeArchiveEntries(version, target);
	const { command, flags } = archiveExtractor(target);
	// Only the binary, npm, and the license: headers, docs, and corepack are left out.
	const members = entries.map((entry) => entry.member);
	if (isWindows(target)) {
		// The ZIP keeps node.exe and npm at its top level: unpack them aside, then place them.
		const extracted = mkdtempSync(join(CACHE, "node-"));
		run(command, [flags, archive, "-C", extracted, ...members]);
		for (const { member, path } of entries)
			cpSync(join(extracted, member), join(node, path), { recursive: true });
		rmSync(extracted, { recursive: true });
		writeFileSync(join(node, "bin", "npm.cmd"), npmCmdWrapper("npm-cli.js"));
		writeFileSync(join(node, "bin", "npx.cmd"), npmCmdWrapper("npx-cli.js"));
		return version;
	}
	run(command, [flags, archive, "-C", node, "--strip-components=1", ...members]);
	writeFileSync(join(node, "bin", "npm"), npmWrapper("npm-cli.js"), { mode: 0o755 });
	writeFileSync(join(node, "bin", "npx"), npmWrapper("npx-cli.js"), { mode: 0o755 });
	return version;
}

/** The engine's packaged Gentle AI binary: readable and runnable by every user, as an installed app needs. */
function openGentleAi(daemon) {
	const dir = join(daemon, "node_modules", "gentle-pi", ".gentle-ai");
	if (!existsSync(dir)) throw new Error(`gentle-pi's postinstall left no ${dir}.`);
	const open = (path) => {
		const stat = lstatSync(path);
		if (stat.isDirectory()) {
			chmodSync(path, 0o755);
			for (const name of readdirSync(path)) open(join(path, name));
		} else if (stat.isFile()) chmodSync(path, stat.mode & 0o111 ? 0o755 : 0o644);
	};
	// Windows has no mode bits to open: installed files take the install folder's ACL.
	if (process.platform !== "win32") open(dir);
	const versions = readdirSync(dir);
	const integrity = JSON.parse(readFileSync(join(dir, versions[0] ?? "", "integrity.json"), "utf8"));
	return integrity;
}

/**
 * The folder of the host's `go.exe`. gentle-pi has no Windows release archive and builds
 * its Gentle AI binary from source with the local Go, which the clean npm PATH would hide.
 */
function windowsGoBin() {
	let found;
	try {
		found = execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"), ["go.exe"], {
			encoding: "utf8",
			timeout: 5000,
		})
			.split(/\r?\n/)
			.find((line) => win32.isAbsolute(line.trim()));
	} catch {}
	if (!found)
		throw new Error(
			"Staging win32-x64 needs Go 1.25.10 or newer on PATH: gentle-pi builds its Gentle AI binary from source on Windows.",
		);
	return win32.dirname(found.trim());
}

function installDaemonModules(out, target) {
	const daemon = join(out, "daemon");
	// A clean npm setup: no user npmrc, a cache of its own, and a scratch HOME for install scripts.
	const env = npmInstallEnv({
		platform: TARGETS[target].platform,
		nodeBin: join(out, "node", "bin"),
		cache: CACHE,
		goBin: isWindows(target) ? windowsGoBin() : undefined,
	});
	for (const dir of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP])
		if (dir) mkdirSync(dir, { recursive: true });
	writeFileSync(env.npm_config_userconfig, "");
	say("Daemon dependencies (npm install --omit=dev)");
	const result = spawnSync(
		join(out, "node", "bin", isWindows(target) ? "node.exe" : "node"),
		[
			join(out, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
			"install",
			"--omit=dev",
			"--no-bin-links",
			"--no-audit",
			"--no-fund",
			"--foreground-scripts",
		],
		{
			cwd: daemon,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			env,
		},
	);
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	if (result.status !== 0) throw new Error(`npm install failed (exit ${result.status}).`);
	const postinstall = `${result.stdout}\n${result.stderr}`
		.split("\n")
		.filter((line) => /Gentle AI|gentle-pi/.test(line) && !/^>/.test(line.trim()));
	const gentleAi = openGentleAi(daemon);
	say(`  gentle-pi postinstall: ${postinstall.join(" | ") || "(no output)"}`);
	// Windows has no release archive: gentle-pi records a verified Go source build instead.
	say(
		`  gentle-ai ${gentleAi.version} from ${gentleAi.asset ?? `${gentleAi.method} ${gentleAi.module}@${gentleAi.tag} (${gentleAi.goVersion})`} ` +
			`(sha256 ${gentleAi.assetSha256 ?? gentleAi.binarySha256})`,
	);
	const pkg = (name) =>
		JSON.parse(readFileSync(join(daemon, "node_modules", name, "package.json"), "utf8")).version;
	return {
		gentlePi: pkg("gentle-pi"),
		engine: pkg("@earendil-works/pi-coding-agent"),
		gentleAi: gentleAi.version,
	};
}

/** The Engram release to carry: the flag, else the user's own release version, else the latest release. */
async function engramVersion(requested) {
	if (requested) return { version: requested, source: "--engram-version" };
	let installed;
	try {
		installed = engramReleaseVersion(
			execFileSync("engram", ["version"], { encoding: "utf8", timeout: 5000 }),
		);
	} catch {}
	if (installed) {
		const response = await fetch(`${ENGRAM_RELEASES}/download/v${installed}/checksums.txt`, {
			method: "HEAD",
		});
		if (response.ok) return { version: installed, source: "installed engram" };
	}
	const latest = await fetch(`${ENGRAM_RELEASES}/latest`, { redirect: "manual" });
	return { version: versionFromReleaseUrl(latest.headers.get("location")), source: "latest release" };
}

async function stageEngram(out, target, requested) {
	const { version, source } = await engramVersion(requested);
	say(`Engram ${version} (${source})`);
	const base = `${ENGRAM_RELEASES}/download/v${version}`;
	const archiveName = engramArchiveName(version, target);
	const archive = await verifiedDownload(
		`${base}/${archiveName}`,
		archiveName,
		checksumFor(await text(`${base}/checksums.txt`), archiveName),
	);
	const extracted = mkdtempSync(join(CACHE, "engram-"));
	const { command, flags } = archiveExtractor(target);
	const name = engramBinaryName(target);
	run(command, [flags, archive, "-C", extracted, name]);
	const binary = join(extracted, name);
	if (!lstatSync(binary).isFile()) throw new Error(`${archiveName} has no regular ${name} binary.`);
	copyFileSync(binary, join(out, "bin", name));
	if (!isWindows(target)) chmodSync(join(out, "bin", name), 0o755);
	rmSync(extracted, { recursive: true });
	return { version, source };
}

function daemonCommit() {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
	const dirty = execFileSync("git", ["status", "--porcelain", "--", "packages"], {
		cwd: REPO,
		encoding: "utf8",
	});
	return dirty.trim() ? `${commit}-dirty` : commit;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const { target } = options;
	assertHostTarget(target);
	const out = resolve(
		process.env.INIT_CWD ?? process.cwd(),
		options.out ?? join(REPO, "build", "runtime", target),
	);
	mkdirSync(CACHE, { recursive: true });
	prepareOut(out);
	say(`Staging the ${target} runtime in ${out}`);

	const node = await stageNode(out, target);
	say("Daemon (build:runtime)");
	runOnPath("pnpm", ["--filter", "@gentle-dot/daemon", "build:runtime", "--", "--out", out], { cwd: REPO });
	const modules = installDaemonModules(out, target);
	const engram = await stageEngram(out, target, options.engramVersion);
	say("Web UI");
	runOnPath("pnpm", ["--filter", "@gentle-dot/ui", "build"], { cwd: REPO });
	cpSync(join(REPO, "packages", "ui", "dist", "app"), join(out, "ui"), { recursive: true });

	const links = symlinksIn(out);
	if (links.length > 0)
		say(`warning: ${links.length} symbolic links remain, e.g. ${links.slice(0, 5).join(", ")}`);
	const manifest = buildManifest({
		target,
		versions: { node, engram: engram.version, engramSource: engram.source, ...modules },
		daemonCommit: daemonCommit(),
		sizeBytes: treeSize(out),
		stagedAt: new Date().toISOString(),
	});
	writeFileSync(join(out, "MANIFEST.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	say(`Staged ${out}: ${formatSize(manifest.sizeBytes)} (${manifest.sizeBytes} bytes)`);
}

main().catch((error) => {
	process.stderr.write(`stage-runtime: ${error.message}\n`);
	process.exit(1);
});
