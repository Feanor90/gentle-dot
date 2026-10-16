import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, win32 } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { companionsSetupEnv, validateCompanionsTemplate } from "../lib.mjs";

const CACHE = join(process.cwd(), ".cache", "package");
const SANDBOX_PREFIX = "companions-setup-";

const fixtures: string[] = [];
afterAll(() => {
	for (const dir of fixtures) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	for (const dir of fixtures) expect(existsSync(dir)).toBe(false);
});

function fixture() {
	const dir = mkdtempSync(join(process.cwd(), ".companions-fixture-"));
	fixtures.push(dir);
	return dir;
}

function write(path: string, text: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** A home as gentle-shell setup leaves it: settings, npm with companions, no gentle-pi. */
function template(home: string) {
	write(join(home, ".gentle-shell-home"), "owned\n");
	write(join(home, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram", "npm:pi-btw"] }));
	write(
		join(home, "npm", "package.json"),
		JSON.stringify({ dependencies: { "gentle-engram": "0.4.2", "pi-btw": "^0.8.0" } }),
	);
	write(
		join(home, "npm", "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": { dependencies: { "gentle-engram": "0.4.2", "pi-btw": "^0.8.0" } },
				"node_modules/gentle-engram": { version: "0.4.2" },
				"node_modules/pi-btw": { version: "0.8.0" },
			},
		}),
	);
	write(join(home, "npm", "node_modules", "gentle-engram", "index.js"), "export {};\n");
	write(join(home, "npm", "node_modules", ".bin", "pi-btw"), "#!/bin/sh\nexec node ../pi-btw/cli.js\n");
}

function sandboxes() {
	return existsSync(CACHE) ? readdirSync(CACHE).filter((name) => name.startsWith(SANDBOX_PREFIX)) : [];
}

describe("companionsSetupEnv", () => {
	const sandbox = "C:\\repo\\.cache\\package\\companions-setup-abc";
	const windows = () =>
		companionsSetupEnv({
			platform: "win32",
			sandbox,
			runtimeBin: "C:\\rt\\bin",
			nodeBin: "C:\\rt\\node\\bin",
			gitBin: "C:\\Program Files\\Git\\cmd",
			env: {
				PATH: "C:\\Users\\me\\go\\bin;C:\\Windows\\System32",
				APPDATA: "C:\\Users\\me\\AppData\\Roaming",
				GENTLE_DOT_FAKE_SECRET: "leak",
				SystemRoot: "C:\\Windows",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				PATHEXT: ".COM;.EXE",
			},
		});

	it("is built from scratch, with every profile, cache and config folder inside the sandbox", () => {
		const env = windows();
		expect(env).toEqual({
			HOME: win32.join(sandbox, "home"),
			USERPROFILE: win32.join(sandbox, "home"),
			APPDATA: win32.join(sandbox, "home", "AppData", "Roaming"),
			LOCALAPPDATA: win32.join(sandbox, "home", "AppData", "Local"),
			TEMP: win32.join(sandbox, "tmp"),
			TMP: win32.join(sandbox, "tmp"),
			npm_config_cache: win32.join(sandbox, "npm-cache"),
			npm_config_userconfig: win32.join(sandbox, "npmrc"),
			npm_config_prefix: win32.join(sandbox, "npm-prefix"),
			npm_config_registry: "https://registry.npmjs.org/",
			npm_config_update_notifier: "false",
			GENTLE_SHELL_CONFIG: win32.join(sandbox, "gentle-shell", "config.json"),
			GENTLE_PI_CONFIG_HOME: win32.join(sandbox, "gentle-ai"),
			ENGRAM_DATA_DIR: win32.join(sandbox, "engram"),
			DO_NOT_TRACK: "1",
			GENTLE_AI_TELEMETRY: "0",
			GENTLE_AI_NO_SELF_UPDATE: "1",
			GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "1",
			GENTLE_SHELL_NO_AUTO_SETUP: "1",
			SystemRoot: "C:\\Windows",
			windir: "C:\\Windows",
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
			PATHEXT: ".COM;.EXE",
			PATH: "C:\\rt\\bin;C:\\rt\\node\\bin;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows",
		});
		expect(env).not.toHaveProperty("GENTLE_DOT_FAKE_SECRET");
	});

	it("puts the runtime's own pi and engram first, then the staged Node, git and system folders on Unix", () => {
		const unix = companionsSetupEnv({
			platform: "linux",
			sandbox: "/repo/.cache/package/companions-setup-abc",
			runtimeBin: "/rt/bin",
			nodeBin: "/rt/node/bin",
			gitBin: "/usr/bin",
			env: { PATH: "/home/me/bin:/usr/bin", TMPDIR: "/var/tmp", GENTLE_DOT_FAKE_SECRET: "leak" },
		});
		expect(unix.PATH).toBe("/rt/bin:/rt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
		expect(unix.HOME).toBe("/repo/.cache/package/companions-setup-abc/home");
		expect(unix).toHaveProperty("TMPDIR", "/repo/.cache/package/companions-setup-abc/tmp");
		expect(unix.GENTLE_AI_TELEMETRY).toBe("0");
		expect(unix).not.toHaveProperty("GENTLE_DOT_FAKE_SECRET");
	});
});

describe("validateCompanionsTemplate", () => {
	it("accepts a set-up home and returns its installed companion versions", () => {
		const sandbox = fixture();
		const home = join(sandbox, "agent-home");
		template(home);
		expect(validateCompanionsTemplate(home, sandbox)).toEqual({
			"gentle-engram": "0.4.2",
			"pi-btw": "0.8.0",
		});
	});

	it("rejects a home without settings.json", () => {
		const sandbox = fixture();
		const home = join(sandbox, "agent-home");
		template(home);
		rmSync(join(home, "settings.json"));
		expect(() => validateCompanionsTemplate(home, sandbox)).toThrow(
			new Error("The companion template has no settings.json."),
		);
	});

	it("rejects a settings.json that does not parse", () => {
		const sandbox = fixture();
		const home = join(sandbox, "agent-home");
		template(home);
		writeFileSync(join(home, "settings.json"), "{");
		expect(() => validateCompanionsTemplate(home, sandbox)).toThrow(
			/^The companion template's settings\.json does not parse: /,
		);
	});

	it("rejects a home without npm", () => {
		const sandbox = fixture();
		const home = join(sandbox, "agent-home");
		template(home);
		rmSync(join(home, "npm"), { recursive: true });
		expect(() => validateCompanionsTemplate(home, sandbox)).toThrow(
			new Error("The companion template has no npm folder."),
		);
	});

	it("rejects a leftover gentle-pi under npm/node_modules", () => {
		const sandbox = fixture();
		const home = join(sandbox, "agent-home");
		template(home);
		write(join(home, "npm", "node_modules", "gentle-pi", "package.json"), "{}");
		expect(() => validateCompanionsTemplate(home, sandbox)).toThrow(
			new Error(
				"The companion template still has npm/node_modules/gentle-pi; gentle-shell setup removes it, so a leftover means a gentle-pi version mismatch.",
			),
		);
	});

	it("rejects a link or junction anywhere in the home", () => {
		const sandbox = fixture();
		const home = join(sandbox, "agent-home");
		template(home);
		symlinkSync(
			join(home, "npm", "node_modules", "gentle-engram"),
			join(home, "npm", "node_modules", "linked"),
			"junction",
		);
		expect(() => validateCompanionsTemplate(home, sandbox)).toThrow(
			new Error("The companion template contains a link: npm/node_modules/linked."),
		);
	});

	it("rejects a script or JSON file that names the sandbox", () => {
		const sandbox = fixture();
		const home = join(sandbox, "agent-home");
		template(home);
		writeFileSync(join(home, "npm", "node_modules", "gentle-engram", "index.js"), `// ${sandbox}\n`);
		expect(() => validateCompanionsTemplate(home, sandbox)).toThrow(
			new Error(
				"The companion template is not relocatable: npm/node_modules/gentle-engram/index.js names the setup sandbox.",
			),
		);
	});

	it("rejects a JSON-escaped or slash-separated sandbox path, and extensionless bin shims", () => {
		const sandbox = fixture();
		const home = join(sandbox, "agent-home");
		template(home);
		writeFileSync(
			join(home, "npm", "node_modules", ".bin", "pi-btw"),
			`exec ${sandbox.replaceAll("\\", "/")}\n`,
		);
		expect(() => validateCompanionsTemplate(home, sandbox)).toThrow(
			new Error(
				"The companion template is not relocatable: npm/node_modules/.bin/pi-btw names the setup sandbox.",
			),
		);
		template(home);
		writeFileSync(join(home, "settings.json"), JSON.stringify({ home: sandbox }));
		expect(() => validateCompanionsTemplate(home, sandbox)).toThrow(
			new Error("The companion template is not relocatable: settings.json names the setup sandbox."),
		);
	});

	it("rejects a companion the lockfile does not record as installed", () => {
		const sandbox = fixture();
		const home = join(sandbox, "agent-home");
		template(home);
		write(join(home, "npm", "package.json"), JSON.stringify({ dependencies: { "pi-web-access": "*" } }));
		expect(() => validateCompanionsTemplate(home, sandbox)).toThrow(
			new Error("npm/package-lock.json has no installed version of pi-web-access."),
		);
	});
});

type Mode = "ok" | "fail" | "leftover";

/** A daemon folder whose gentle-shell is a stand-in: it records how it ran, then prepares (or fails) the home. */
function fakeDaemon(mode: Mode) {
	const root = fixture();
	const gentlePi = join(root, "daemon", "node_modules", "gentle-pi");
	write(join(gentlePi, "package.json"), JSON.stringify({ name: "gentle-pi", version: "9.8.7" }));
	write(join(gentlePi, "runtime", "gentle-ai-binary.mjs"), 'export const GENTLE_AI_VERSION = "6.5.4";\n');
	write(
		join(gentlePi, "bin", "gentle-shell.mjs"),
		`import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(root, "dump.json"))}, JSON.stringify({ args, env: process.env, cwd: process.cwd() }));
const home = args[args.indexOf("--home") + 1];
const put = (rel, text) => {
	mkdirSync(join(home, rel, ".."), { recursive: true });
	writeFileSync(join(home, rel), text);
};
put(".gentle-shell-home", "owned\\n");
put("settings.json", JSON.stringify({ packages: ["npm:gentle-engram"] }));
put("npm/package.json", JSON.stringify({ dependencies: { "gentle-engram": "0.4.2" } }));
put("npm/package-lock.json", JSON.stringify({ packages: { "node_modules/gentle-engram": { version: "0.4.2" } } }));
put("npm/node_modules/gentle-engram/index.js", "export {};\\n");
${mode === "leftover" ? 'put("npm/node_modules/gentle-pi/package.json", "{}");' : ""}
console.log("fake setup done");
${mode === "fail" ? "process.exit(3);" : ""}
`,
	);
	return { root, daemon: join(root, "daemon"), out: join(root, "runtime", "companions") };
}

function cli(...args: string[]) {
	return spawnSync(process.execPath, ["scripts/package/companions.mjs", ...args], {
		encoding: "utf8",
		env: { ...process.env, GENTLE_DOT_FAKE_SECRET: "leak" },
	});
}

describe("companions CLI", () => {
	it("stages the set-up home and its manifest, then removes the sandbox", () => {
		const before = sandboxes();
		const { root, daemon, out } = fakeDaemon("ok");
		const result = cli(daemon, process.execPath, out);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("fake setup done\n");
		expect(
			result.stdout.endsWith("Companions: gentle-pi 9.8.7, Gentle AI 6.5.4; gentle-engram 0.4.2\n"),
		).toBe(true);
		expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe(
			`${JSON.stringify({ schema: 1, gentlePi: "9.8.7", gentleAi: "6.5.4" }, null, "\t")}\n`,
		);
		expect(readdirSync(out).sort()).toEqual(["agent-home", "manifest.json"]);
		expect(
			readFileSync(join(out, "agent-home", "npm", "node_modules", "gentle-engram", "index.js"), "utf8"),
		).toBe("export {};\n");
		expect(existsSync(join(out, "agent-home", "settings.json"))).toBe(true);

		const dump = JSON.parse(readFileSync(join(root, "dump.json"), "utf8"));
		const home = dump.args[1];
		const sandbox = dirname(home);
		expect(dump.args).toEqual(["--home", join(sandbox, "agent-home"), "setup"]);
		expect(dirname(sandbox)).toBe(CACHE);
		expect(sandbox.slice(CACHE.length + 1).startsWith(SANDBOX_PREFIX)).toBe(true);
		expect(dump.cwd).toBe(sandbox);
		expect(dump.env.GENTLE_DOT_FAKE_SECRET).toBeUndefined();
		expect(dump.env.HOME).toBe(join(sandbox, "home"));
		expect(dump.env.GENTLE_AI_TELEMETRY).toBe("0");
		expect(dump.env.DO_NOT_TRACK).toBe("1");
		const path = dump.env.PATH.split(process.platform === "win32" ? ";" : ":");
		// The runtime's own `pi` and `engram` come before the Node that runs them.
		expect(path[0]).toBe(join(dirname(daemon), "bin"));
		expect(path[1]).toBe(dirname(process.execPath));
		expect(existsSync(sandbox)).toBe(false);
		expect(sandboxes()).toEqual(before);
	});

	it("fails without a partial output when setup fails, and removes the sandbox", () => {
		const before = sandboxes();
		const { root, daemon, out } = fakeDaemon("fail");
		const result = cli(daemon, process.execPath, out);
		expect(result.status).toBe(1);
		expect(result.stderr).toBe("companions: gentle-shell setup failed (exit 3).\n");
		expect(existsSync(out)).toBe(false);
		const sandbox = dirname(JSON.parse(readFileSync(join(root, "dump.json"), "utf8")).args[1]);
		expect(existsSync(sandbox)).toBe(false);
		expect(sandboxes()).toEqual(before);
	});

	it("refuses a template that fails validation", () => {
		const before = sandboxes();
		const { daemon, out } = fakeDaemon("leftover");
		const result = cli(daemon, process.execPath, out);
		expect(result.status).toBe(1);
		expect(result.stderr).toBe(
			"companions: The companion template still has npm/node_modules/gentle-pi; gentle-shell setup removes it, so a leftover means a gentle-pi version mismatch.\n",
		);
		expect(existsSync(out)).toBe(false);
		expect(sandboxes()).toEqual(before);
	});

	it("refuses an output folder that already exists", () => {
		const { daemon, out } = fakeDaemon("ok");
		mkdirSync(out, { recursive: true });
		const result = cli(daemon, process.execPath, out);
		expect(result.status).toBe(1);
		expect(result.stderr).toBe(`companions: ${out} already exists.\n`);
		expect(readdirSync(out)).toEqual([]);
	});

	it("prints the usage without arguments", () => {
		const result = cli();
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("usage: companions <daemon-dir> <node-executable> <out-companions-dir>\n");
	});
});
