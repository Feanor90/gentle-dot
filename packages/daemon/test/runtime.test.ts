import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { bundledMcpCli } from "../src/connectors.ts";
import { isolatedAgentEnv } from "../src/isolation.ts";
import { engramKnownDirs, resolveEngramBin } from "../src/runtime.ts";

const { shellAnswers, execFileSync } = vi.hoisted(() => ({
	shellAnswers: new Map<string, string | undefined>(),
	execFileSync: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync }));
beforeEach(() => {
	execFileSync.mockReset().mockImplementation((shell: string) => {
		const answer = shellAnswers.get(shell);
		if (answer === undefined) throw new Error("No login Engram");
		return `Welcome\n${answer}\n`;
	});
});

const ownedDirs: string[] = [];
afterAll(() => {
	for (const dir of ownedDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const dir = mkdtempSync(join(root, ".runtime-test-"));
	ownedDirs.push(dir);
	return dir;
}

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const ENGINE_CLI = join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

function touch(path: string, content = "", mode = 0o644): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, mode);
	return path;
}

/** An installed runtime folder (S29.5) with the engine files the daemon looks for. */
function fakeRuntime(): string {
	const runtime = tempDir();
	const modules = join(runtime, "daemon", "node_modules");
	touch(join(modules, "gentle-pi", "bin", "gentle-shell.mjs"));
	touch(join(modules, ENGINE_CLI));
	mkdirSync(join(runtime, "bin"), { recursive: true });
	return runtime;
}

/** A login shell that answers `command -v engram` with `answer`, or fails when it is undefined. */
function fakeShell(answer: string | undefined): string {
	const shell = join(tempDir(), "shell");
	shellAnswers.set(shell, answer);
	return shell;
}

describe("installed runtime (GENTLE_DOT_RUNTIME)", () => {
	it("serves the runtime's web UI, and GENTLE_DOT_UI_DIR still wins", () => {
		const runtime = fakeRuntime();
		const dataDir = tempDir();
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_RUNTIME: runtime }).uiDir).toBe(
			join(runtime, "ui"),
		);
		expect(
			loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_RUNTIME: runtime, GENTLE_DOT_UI_DIR: "/ui" })
				.uiDir,
		).toBe(resolve("/ui"));
	});

	it("runs the launcher and the engine's command line from the runtime's node_modules", () => {
		const runtime = fakeRuntime();
		const modules = join(runtime, "daemon", "node_modules");
		const config = loadConfig({ GENTLE_DOT_DATA_DIR: tempDir(), GENTLE_DOT_RUNTIME: runtime });
		expect(config.agentCommand).toBe(process.execPath);
		expect(config.agentArgs).toEqual([join(modules, "gentle-pi", "bin", "gentle-shell.mjs")]);
		expect(bundledMcpCli({ GENTLE_DOT_RUNTIME: runtime })).toEqual({
			command: process.execPath,
			args: [join(modules, ENGINE_CLI)],
		});
	});

	it("never falls back to the build machine's engine when the runtime lacks it", () => {
		const runtime = tempDir();
		expect(() => loadConfig({ GENTLE_DOT_DATA_DIR: tempDir(), GENTLE_DOT_RUNTIME: runtime })).toThrow(
			join(runtime, "daemon", "node_modules"),
		);
		expect(() => bundledMcpCli({ GENTLE_DOT_RUNTIME: runtime })).toThrow("assistant engine is missing");
	});

	it("puts the runtime's `pi` first on the engine's PATH, never the pnpm one", () => {
		const runtime = fakeRuntime();
		const base = {
			PATH: ["/usr/bin", "/bin"].join(delimiter),
			HOME: tempDir(),
			GENTLE_DOT_RUNTIME: runtime,
			ENGRAM_BIN: "/x/engram",
		};
		const env = isolatedAgentEnv(base, tempDir());
		expect(env.PATH).toBe([join(runtime, "bin"), "/usr/bin", "/bin"].join(delimiter));
		const again = isolatedAgentEnv({ ...base, PATH: env.PATH }, tempDir());
		expect(again.PATH).toBe(env.PATH);
	});

	it("passes the user's ENGRAM_BIN to the engine and keeps the global memory", () => {
		const realHome = tempDir();
		const env = isolatedAgentEnv(
			{ PATH: "/bin", HOME: realHome, GENTLE_DOT_RUNTIME: fakeRuntime(), ENGRAM_BIN: "/x/engram" },
			tempDir(),
		);
		expect(env).toMatchObject({ ENGRAM_BIN: "/x/engram", ENGRAM_DATA_DIR: join(realHome, ".engram") });
	});

	it("finds the user's Engram through the login shell before the bundled one", () => {
		const runtime = fakeRuntime();
		const userEngram = touch(join(tempDir(), "engram"), "", 0o755);
		const env = isolatedAgentEnv(
			{ PATH: "/bin", HOME: tempDir(), GENTLE_DOT_RUNTIME: runtime, SHELL: fakeShell(userEngram) },
			tempDir(),
		);
		expect(env.ENGRAM_BIN).toBe(
			process.platform === "win32" ? join(runtime, "bin", "engram.exe") : userEngram,
		);
	});
});

describe("resolveEngramBin", () => {
	it("prefers ENGRAM_BIN, then the login PATH, then the known folders, then the runtime's own", () => {
		const runtime = fakeRuntime();
		const home = tempDir();
		const known = tempDir();
		const loginEngram = touch(join(tempDir(), "engram"), "", 0o755);
		const failing = fakeShell(undefined);
		const options = { platform: "linux" as const, home, knownDirs: [join(home, "missing"), known] };
		expect(resolveEngramBin({ ENGRAM_BIN: "/x/engram", SHELL: failing }, runtime, options)).toBe("/x/engram");
		expect(resolveEngramBin({ SHELL: fakeShell(loginEngram) }, runtime, options)).toBe(loginEngram);
		expect(resolveEngramBin({ SHELL: failing }, runtime, options)).toBe(join(runtime, "bin", "engram"));
		const knownEngram = touch(join(known, "engram"), "", 0o755);
		expect(resolveEngramBin({ SHELL: failing }, runtime, options)).toBe(knownEngram);
		// A login shell answer that is not an executable file is ignored.
		expect(resolveEngramBin({ SHELL: fakeShell("/nowhere/engram") }, runtime, options)).toBe(knownEngram);
	});

	it("looks in ~/go/bin, Homebrew, /usr/local/bin and ~/.local/bin by default", () => {
		const home = tempDir();
		const userEngram = touch(join(home, "go", "bin", "engram"), "", 0o755);
		expect(
			resolveEngramBin({ SHELL: fakeShell(undefined) }, fakeRuntime(), { home, platform: "linux" }),
		).toBe(userEngram);
		expect(engramKnownDirs(home, "linux")).toEqual([
			join(home, "go", "bin"),
			"/opt/homebrew/bin",
			"/usr/local/bin",
			join(home, ".local", "bin"),
		]);
	});
});

describe("Windows Engram resolution", () => {
	it("preserves an explicit override verbatim without probing a shell", () => {
		const runtime = fakeRuntime();
		expect(
			resolveEngramBin({ ENGRAM_BIN: "custom-command", PATH: runtime }, runtime, { platform: "win32" }),
		).toBe("custom-command");
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it("searches semicolon-separated PATH before known folders, using only .exe files", () => {
		const runtime = fakeRuntime();
		const first = tempDir();
		const second = tempDir();
		const known = tempDir();
		touch(join(first, "engram"), "", 0o755);
		mkdirSync(join(first, "engram.exe"));
		const fromPath = touch(join(second, "engram.exe"), "", 0o755);
		const fromKnown = touch(join(known, "engram.exe"), "", 0o755);
		const env = { PATH: `;relative;${first};${second}`, SHELL: fakeShell(join(first, "engram")) };
		expect(resolveEngramBin(env, runtime, { platform: "win32", knownDirs: [known] })).toBe(fromPath);
		expect(
			resolveEngramBin({ ...env, PATH: first }, runtime, { platform: "win32", knownDirs: [known] }),
		).toBe(fromKnown);
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it("prefers original user PATH and home bins over the launch-prefixed bundled executable", () => {
		const runtime = fakeRuntime();
		const home = tempDir();
		const custom = tempDir();
		const bundled = touch(join(runtime, "bin", "engram.exe"), "", 0o755);
		const fromCustom = touch(join(custom, "engram.exe"), "", 0o755);
		const fromHome = touch(join(home, "go", "bin", "engram.exe"), "", 0o755);
		const env = {
			PATH: `${join(runtime, "bin")};${join(runtime, "node", "bin")}`,
			GENTLE_DOT_USER_PATH: custom,
			HOME: home,
		};
		expect(resolveEngramBin(env, runtime, { platform: "win32" })).toBe(fromCustom);
		expect(resolveEngramBin({ ...env, GENTLE_DOT_USER_PATH: "" }, runtime, { platform: "win32" })).toBe(
			fromHome,
		);
		expect(
			resolveEngramBin({ ...env, GENTLE_DOT_USER_PATH: "" }, runtime, {
				platform: "win32",
				knownDirs: [],
			}),
		).toBe(bundled);
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it("excludes its own runtime PATH entries during standalone Windows resolution", () => {
		const runtime = fakeRuntime();
		const custom = tempDir();
		const home = tempDir();
		const bundled = touch(join(runtime, "bin", "engram.exe"), "", 0o755);
		touch(join(runtime, "node", "bin", "engram.exe"), "", 0o755);
		const fromCustom = touch(join(custom, "engram.exe"), "", 0o755);
		const fromHome = touch(join(home, "go", "bin", "engram.exe"), "", 0o755);
		const path = `${join(runtime, "bin")};${join(runtime, "node", "bin")}`;
		expect(resolveEngramBin({ PATH: `${path};${custom}`, HOME: home }, runtime, { platform: "win32" })).toBe(
			fromCustom,
		);
		expect(resolveEngramBin({ PATH: path, HOME: home }, runtime, { platform: "win32" })).toBe(fromHome);
		expect(resolveEngramBin({ PATH: path }, runtime, { platform: "win32", knownDirs: [] })).toBe(bundled);
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it("uses Windows home-local known folders and USERPROFILE, preserving HOME precedence", () => {
		const runtime = fakeRuntime();
		const home = tempDir();
		const profile = tempDir();
		const go = touch(join(profile, "go", "bin", "engram.exe"), "", 0o755);
		const local = touch(join(home, ".local", "bin", "engram.exe"), "", 0o755);
		expect(engramKnownDirs(home, "win32")).toEqual([join(home, "go", "bin"), join(home, ".local", "bin")]);
		expect(resolveEngramBin({ USERPROFILE: profile }, runtime, { platform: "win32" })).toBe(go);
		expect(resolveEngramBin({ HOME: home, USERPROFILE: profile }, runtime, { platform: "win32" })).toBe(
			local,
		);
		expect(execFileSync).not.toHaveBeenCalled();
	});

	it("falls back to the bundled .exe without /bin/sh even when SHELL is absent", () => {
		const runtime = fakeRuntime();
		expect(resolveEngramBin({}, runtime, { platform: "win32", home: tempDir(), knownDirs: [] })).toBe(
			join(runtime, "bin", "engram.exe"),
		);
		expect(execFileSync).not.toHaveBeenCalled();
	});
});

describe("source checkout (no GENTLE_DOT_RUNTIME)", () => {
	it("keeps the workspace UI, the pnpm engine, the pnpm `pi`, and no ENGRAM_BIN", () => {
		const config = loadConfig({ GENTLE_DOT_DATA_DIR: tempDir() });
		expect(config.uiDir).toBe(join(PACKAGE, "..", "ui", "dist", "app"));
		expect(config.agentArgs).toEqual([join(PACKAGE, "node_modules", "gentle-pi", "bin", "gentle-shell.mjs")]);
		expect(bundledMcpCli({}).args).toEqual([join(PACKAGE, "node_modules", ENGINE_CLI)]);
		const env = isolatedAgentEnv({ PATH: ["/usr/bin", "/bin"].join(delimiter), HOME: tempDir() }, tempDir());
		expect(env.PATH).toBe([join(PACKAGE, "node_modules", ".bin"), "/usr/bin", "/bin"].join(delimiter));
		expect(env.ENGRAM_BIN).toBeUndefined();
	});
});
