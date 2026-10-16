#!/usr/bin/env node
// Prepares the runtime's packaged companions (S17, odd/tasks/windows-support.md T8e2-B1): a real
// `gentle-shell --home <dir> setup` of the staged gentle-pi, run with the staged Node in a
// throwaway sandbox, checked, then copied to `<out>/agent-home` with `<out>/manifest.json` last.
// `node scripts/package/companions.mjs <daemon-dir> <node-executable> <out-companions-dir>`.
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { companionsSetupEnv, validateCompanionsTemplate } from "./lib.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CACHE = join(REPO, ".cache", "package");
const SETUP_TIMEOUT_MS = 20 * 60 * 1000;

const [daemonArg, nodeArg, outArg] = process.argv.slice(2);
if (!daemonArg || !nodeArg || !outArg) {
	process.stderr.write("usage: companions <daemon-dir> <node-executable> <out-companions-dir>\n");
	process.exit(2);
}

/** The folder of git on the host's PATH: gentle-shell setup installs packages with npm, which may need it. */
function gitBin() {
	const name = process.platform === "win32" ? "git.exe" : "git";
	const dir = (process.env.PATH ?? "")
		.split(delimiter)
		.find((entry) => entry && existsSync(join(entry, name)));
	if (!dir) throw new Error("Staging the companions needs git on PATH.");
	return dir;
}

/** The versions gentle-shell checks a provisioned home against: its package's, and its pinned Gentle AI. */
async function bundledVersions(gentlePi) {
	let version;
	let GENTLE_AI_VERSION;
	try {
		({ version } = JSON.parse(readFileSync(join(gentlePi, "package.json"), "utf8")));
		({ GENTLE_AI_VERSION } = await import(
			pathToFileURL(join(gentlePi, "runtime", "gentle-ai-binary.mjs")).href
		));
	} catch (error) {
		throw new Error(`Cannot read the staged gentle-pi's versions: ${error.message}`);
	}
	if (typeof version !== "string" || typeof GENTLE_AI_VERSION !== "string")
		throw new Error(`${gentlePi} names no gentle-pi or Gentle AI version.`);
	return { gentlePi: version, gentleAi: GENTLE_AI_VERSION };
}

function setUp(daemon, gentlePi, node, sandbox) {
	const env = companionsSetupEnv({
		platform: process.platform,
		sandbox,
		// The runtime's own `pi` and `engram`, never the build machine's.
		runtimeBin: join(dirname(daemon), "bin"),
		nodeBin: dirname(node),
		gitBin: gitBin(),
	});
	for (const dir of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP ?? env.TMPDIR, env.npm_config_cache])
		mkdirSync(dir, { recursive: true });
	for (const dir of [env.npm_config_prefix, env.GENTLE_PI_CONFIG_HOME, env.ENGRAM_DATA_DIR])
		mkdirSync(dir, { recursive: true });
	mkdirSync(dirname(env.GENTLE_SHELL_CONFIG), { recursive: true });
	writeFileSync(env.npm_config_userconfig, "");
	const home = join(sandbox, "agent-home");
	const result = spawnSync(node, [join(gentlePi, "bin", "gentle-shell.mjs"), "--home", home, "setup"], {
		cwd: sandbox,
		env,
		stdio: ["ignore", "inherit", "inherit"],
		timeout: SETUP_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.error?.code === "ETIMEDOUT")
		throw new Error(`gentle-shell setup did not finish within ${SETUP_TIMEOUT_MS / 60_000} minutes.`);
	if (result.error) throw new Error(`gentle-shell setup failed (${result.error.message}).`);
	if (result.signal) throw new Error(`gentle-shell setup failed (signal ${result.signal}).`);
	if (result.status !== 0) throw new Error(`gentle-shell setup failed (exit ${result.status}).`);
	return home;
}

async function main() {
	const daemon = resolve(daemonArg);
	const node = resolve(nodeArg);
	const out = resolve(outArg);
	if (existsSync(out)) throw new Error(`${out} already exists.`);
	const gentlePi = join(daemon, "node_modules", "gentle-pi");
	const versions = await bundledVersions(gentlePi);
	mkdirSync(CACHE, { recursive: true });
	const sandbox = mkdtempSync(join(CACHE, "companions-setup-"));
	let created = false;
	try {
		const home = setUp(daemon, gentlePi, node, sandbox);
		const companions = validateCompanionsTemplate(home, sandbox);
		mkdirSync(out, { recursive: true });
		created = true;
		cpSync(home, join(out, "agent-home"), { recursive: true, errorOnExist: true, force: false });
		// The manifest is what makes the companions usable, so it appears last and whole.
		const manifest = join(out, "manifest.json");
		writeFileSync(`${manifest}.tmp`, `${JSON.stringify({ schema: 1, ...versions }, null, "\t")}\n`, {
			flag: "wx",
		});
		renameSync(`${manifest}.tmp`, manifest);
		const list = Object.entries(companions).map(([name, version]) => `${name} ${version}`);
		process.stdout.write(
			`Companions: gentle-pi ${versions.gentlePi}, Gentle AI ${versions.gentleAi}; ${list.join(", ")}\n`,
		);
	} catch (error) {
		if (created) rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		throw error;
	} finally {
		rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

main().catch((error) => {
	process.stderr.write(`companions: ${error.message}\n`);
	process.exit(1);
});
