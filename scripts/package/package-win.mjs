#!/usr/bin/env node
// Builds the Windows installer: stages the runtime, builds the release app and its
// NSIS installer with Tauri inside the MSVC environment, and checks the result
// without installing it: `node scripts/package/package-win.mjs [--skip-stage]`.
// The bundler's NSIS download is cached in `apps/desktop/src-tauri/target/.tauri`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertHostTarget,
	formatSize,
	goMeetsMinimum,
	manifestFromPe,
	nsisFileName,
	parseEnvironment,
	parseWinArgs,
	sha256File,
	tauriWindowsReleaseConfig,
	usesCommonControls6,
	vcvars64Path,
	WINDOWS_GO_REQUIRED,
} from "./lib.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TARGET = "win32-x64";
const DESKTOP = join(REPO, "apps", "desktop");
const TAURI = join(DESKTOP, "src-tauri");
const HERE = join(REPO, "scripts", "package");
const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

const say = (line) => process.stdout.write(`${line}\n`);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.status !== 0)
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}).`,
		);
	return result;
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error.message}`);
	}
}

/** Regular files under `dir`, relative to it, with their sizes. */
function filesIn(dir, prefix = "", found = new Map()) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) filesIn(join(dir, entry.name), relative, found);
		else if (entry.isFile()) found.set(relative, statSync(join(dir, entry.name)).size);
	}
	return found;
}

/** Fails before staging when the host's Go cannot build gentle-pi's Gentle AI binary. */
function checkGo() {
	let version = "";
	try {
		const go = execFileSync(join(SYSTEM32, "where.exe"), ["go.exe"], { encoding: "utf8", timeout: 5000 })
			.split(/\r?\n/)[0]
			.trim();
		version = execFileSync(go, ["version"], { encoding: "utf8", timeout: 10000 });
	} catch {}
	if (!goMeetsMinimum(version)) throw new Error(`${WINDOWS_GO_REQUIRED} Found: ${version.trim() || "none"}.`);
	say(`Using ${version.trim()}`);
}

/**
 * The environment of a Visual Studio x64 developer prompt: the C parts of the build
 * (bzip2, lzma) need `cl.exe` with its INCLUDE and LIB. Kept when already set up.
 */
function msvcEnvironment() {
	if (process.env.VCINSTALLDIR) return process.env;
	const vswhere = join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio",
		"Installer",
		"vswhere.exe",
	);
	let installation = "";
	if (existsSync(vswhere))
		installation = execFileSync(
			vswhere,
			[
				"-latest",
				"-products",
				"*",
				"-requires",
				"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
				"-property",
				"installationPath",
			],
			{ encoding: "utf8" },
		).trim();
	const vcvars = installation && vcvars64Path(installation);
	if (!vcvars || !existsSync(vcvars))
		throw new Error(
			"No Visual Studio C++ x64 build tools found (vswhere, vcvars64.bat); install Visual Studio Build Tools with the C++ workload.",
		);
	say(`MSVC environment from ${vcvars}`);
	const output = execFileSync(
		join(SYSTEM32, "cmd.exe"),
		["/d", "/s", "/c", `"call "${vcvars}" >nul && set"`],
		{
			encoding: "utf8",
			windowsVerbatimArguments: true,
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	const env = parseEnvironment(output);
	if (!env.VCINSTALLDIR) throw new Error(`${vcvars} did not set up the MSVC environment.`);
	return env;
}

/** Checks the built app and installer without installing; returns the installer's path. */
async function verify(runtime) {
	const { productName, version } = readJson(join(TAURI, "tauri.conf.json"));
	const release = join(TAURI, "target", "release");
	const installer = join(release, "bundle", "nsis", nsisFileName(productName, version, "x64"));
	if (!existsSync(installer)) throw new Error(`Tauri left no ${installer}.`);

	const exe = join(release, "gentle-dot.exe");
	const manifest = manifestFromPe(readFileSync(exe));
	if (!manifest || !usesCommonControls6(manifest))
		throw new Error(`${exe} does not embed a manifest that depends on Common Controls 6.`);
	say(`App: ${exe}: embedded manifest depends on Microsoft.Windows.Common-Controls 6.0.0.0`);

	const staged = filesIn(runtime);
	const bundled = filesIn(join(release, "runtime"));
	const differences = [...staged]
		.filter(([relative, size]) => bundled.get(relative) !== size)
		.map(([relative]) => relative);
	if (differences.length > 0)
		throw new Error(`The app's runtime differs from the staged one: ${differences.slice(0, 10).join(", ")}`);
	say(`  runtime: every staged file present with its size (${staged.size} files)`);

	const tools = join(TAURI, "target", ".tauri", "NSIS");
	if (!existsSync(tools)) throw new Error(`The bundler's NSIS is not in ${tools}.`);
	say(`  NSIS tools: ${tools}`);
	const userTools = join(process.env.LOCALAPPDATA ?? "", "tauri");
	if (process.env.LOCALAPPDATA && existsSync(userTools))
		throw new Error(`${userTools} exists: the bundler may have cached its tools outside the project.`);
	say(`  no user-wide tool cache (${userTools})`);

	const size = statSync(installer).size;
	say(`Installer: ${installer}: ${formatSize(size)} (${size} bytes), sha256 ${await sha256File(installer)}`);
	say("Not installed: run the installer only on a machine where installing Gentle Dot is intended.");
}

async function main() {
	const options = parseWinArgs(process.argv.slice(2));
	assertHostTarget(TARGET);

	// The Tauri CLI asks rustc for its version itself.
	if (spawnSync("rustc", ["--version"]).status !== 0)
		throw new Error(
			"rustc is not on PATH; the Tauri CLI needs it (install Rust with rustup, or add it to PATH).",
		);

	const runtime = join(REPO, "build", "runtime", TARGET);
	if (options.skipStage) {
		const manifest = join(runtime, "MANIFEST.json");
		if (!existsSync(manifest) || readJson(manifest).target !== TARGET)
			throw new Error(`--skip-stage needs a staged ${TARGET} runtime in ${runtime}; run without it once.`);
		say(`Using the staged runtime in ${runtime}`);
	} else {
		checkGo();
		run(process.execPath, [join(HERE, "stage-runtime.mjs"), "--target", TARGET, "--out", runtime]);
	}

	const env = msvcEnvironment();
	const config = tauriWindowsReleaseConfig({ runtime });
	say("tauri build --bundles nsis (release, per-user installer, tools in target/.tauri)");
	// The CLI's own script under this Node: no shell, so the JSON reaches it unquoted.
	run(
		process.execPath,
		[
			join(DESKTOP, "node_modules", "@tauri-apps", "cli", "tauri.js"),
			"build",
			"--bundles",
			"nsis",
			"--config",
			JSON.stringify(config),
		],
		{ cwd: DESKTOP, env },
	);
	await verify(runtime);
}

main().catch((error) => {
	process.stderr.write(`package-win: ${error.message}\n`);
	process.exit(1);
});
