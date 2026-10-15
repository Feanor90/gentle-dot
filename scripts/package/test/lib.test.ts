import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, win32 } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	archiveExtractor,
	assertHostTarget,
	buildManifest,
	checksumFor,
	engramArchiveName,
	engramBinaryName,
	engramReleaseVersion,
	hostCommand,
	hostTarget,
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
	USAGE,
	verifyChecksum,
	versionFromReleaseUrl,
} from "../lib.mjs";

describe("parseArgs", () => {
	it("accepts the canonical Windows target and advertises it in usage", () => {
		expect(parseArgs(["--target", "win32-x64"])).toEqual({ target: "win32-x64" });
		expect(USAGE).toBe(
			"usage: stage-runtime --target <darwin-arm64|linux-arm64|linux-x64|win32-x64> [--out <dir>] [--engram-version <x.y.z>]",
		);
		expect(() => parseArgs([])).toThrow(`Missing --target.\n${USAGE}`);
		expect(() => parseArgs(["--target", "windows-x64"])).toThrow(
			"Unknown target windows-x64; expected one of darwin-arm64, linux-arm64, linux-x64, win32-x64.",
		);
	});

	it("keeps every existing target accepted", () => {
		for (const target of ["darwin-arm64", "linux-arm64", "linux-x64"])
			expect(parseArgs(["--target", target])).toEqual({ target });
	});

	it("reads the target, the output folder, and an Engram version, ignoring pnpm's --", () => {
		expect(
			parseArgs(["--", "--target", "linux-x64", "--out", "/tmp/r", "--engram-version", "3.2.1"]),
		).toEqual({ target: "linux-x64", out: "/tmp/r", engramVersion: "3.2.1" });
	});

	it("refuses a missing or unknown target, unknown flags, and a flag without a value", () => {
		expect(() => parseArgs(["--out", "/tmp/r"])).toThrow(/Missing --target/);
		expect(() => parseArgs(["--target", "windows-x64"])).toThrow(/Unknown target windows-x64/);
		expect(() => parseArgs(["--target", "linux-x64", "--force", "1"])).toThrow(/Unexpected argument --force/);
		expect(() => parseArgs(["--target", "--out", "/tmp/r"])).toThrow(/Unexpected argument --target/);
		expect(() => parseArgs(["--target", "linux-x64", "--engram-version", "latest"])).toThrow(/x\.y\.z/);
	});
});

describe("host target", () => {
	it("maps only Windows x64 and enforces native staging in both directions", () => {
		expect(TARGETS["win32-x64"]).toEqual({
			platform: "win32",
			arch: "x64",
			node: "win-x64",
			engram: "windows_amd64",
		});
		expect(hostTarget("win32", "x64")).toBe("win32-x64");
		expect(hostTarget("win32", "arm64")).toBeUndefined();
		expect(() => assertHostTarget("win32-x64", "win32-x64")).not.toThrow();
		for (const [target, host] of [
			["win32-x64", "linux-x64"],
			["linux-x64", "win32-x64"],
		])
			expect(() => assertHostTarget(target, host)).toThrow(
				`Cannot stage ${target} on ${host}: the runtime's dependencies include native pieces for the machine that installs them. Stage ${target} on a ${target} machine or container (Linux targets are staged inside a container).`,
			);
	});

	it("maps Node's platform and arch to a target", () => {
		expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
		expect(hostTarget("linux", "x64")).toBe("linux-x64");
		expect(hostTarget("linux", "arm64")).toBe("linux-arm64");
		expect(hostTarget("darwin", "x64")).toBeUndefined();
	});

	it("refuses to stage another platform's runtime, naming the way out", () => {
		expect(() => assertHostTarget("darwin-arm64", "darwin-arm64")).not.toThrow();
		expect(() => assertHostTarget("linux-arm64", "darwin-arm64")).toThrow(
			/Cannot stage linux-arm64 on darwin-arm64.*inside a container/,
		);
	});
});

describe("versions and asset names", () => {
	it("uses an exact .nvmrc, else the pinned release of the same major", () => {
		expect(nodeVersion("24.9.0\n")).toBe("24.9.0");
		expect(nodeVersion("v24", "24.14.1")).toBe("24.14.1");
		expect(() => nodeVersion("22", "24.14.1")).toThrow(/Node 22/);
	});

	it("names the official Windows ZIP archives", () => {
		expect(nodeArchiveName("24.14.1", "win32-x64")).toBe("node-v24.14.1-win-x64.zip");
		expect(engramArchiveName("3.4.0", "win32-x64")).toBe("engram_3.4.0_windows_amd64.zip");
	});

	it("names the official archives", () => {
		expect(nodeArchiveName("24.14.1", "darwin-arm64")).toBe("node-v24.14.1-darwin-arm64.tar.gz");
		expect(nodeArchiveName("24.14.1", "linux-arm64")).toBe("node-v24.14.1-linux-arm64.tar.gz");
		expect(engramArchiveName("3.2.1", "linux-arm64")).toBe("engram_3.2.1_linux_arm64.tar.gz");
		expect(nodeArchiveName("24.14.1", "linux-x64")).toBe("node-v24.14.1-linux-x64.tar.gz");
		expect(engramArchiveName("3.2.1", "linux-x64")).toBe("engram_3.2.1_linux_amd64.tar.gz");
		expect(engramArchiveName("3.2.1", "darwin-arm64")).toBe("engram_3.2.1_darwin_arm64.tar.gz");
	});

	it("takes a release version from `engram version`, not a development build", () => {
		expect(engramReleaseVersion("engram 3.2.1\n")).toBe("3.2.1");
		expect(engramReleaseVersion("engram v3.1.0")).toBe("3.1.0");
		expect(engramReleaseVersion("engram 3.0.0-20261007205017-8e525e767d69")).toBeUndefined();
		expect(engramReleaseVersion("")).toBeUndefined();
	});

	it("reads the version of a release URL", () => {
		expect(versionFromReleaseUrl("https://github.com/o/engram/releases/tag/v3.2.1")).toBe("3.2.1");
		expect(() => versionFromReleaseUrl("https://github.com/o/engram/releases")).toThrow(/Not a release URL/);
	});
});

const fixtureDirs: string[] = [];

function fixtureDir() {
	const dir = mkdtempSync(join(process.cwd(), ".package-lib-fixture-"));
	fixtureDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of fixtureDirs) rmSync(dir, { recursive: true });
	for (const dir of fixtureDirs) expect(existsSync(dir)).toBe(false);
});

describe("checksums", () => {
	const hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
	const listing = `${"a".repeat(64)}  node-v24.14.1-linux-x64.tar.gz\n${hello}  hello.txt\n${"b".repeat(64)} *bin.zip\n`;

	it("finds a file's entry in SHASUMS256 / checksums.txt listings", () => {
		expect(checksumFor(listing, "hello.txt")).toBe(hello);
		expect(checksumFor(listing, "bin.zip")).toBe("b".repeat(64));
		expect(() => checksumFor(listing, "node-v24.14.1-linux-x64.tar")).toThrow(/no entry/);
	});

	it("accepts a matching file and rejects a tampered one", async () => {
		const dir = fixtureDir();
		const file = join(dir, "hello.txt");
		writeFileSync(file, "hello");
		await expect(verifyChecksum(file, hello)).resolves.toBeUndefined();
		writeFileSync(file, "hellO");
		await expect(verifyChecksum(file, hello)).rejects.toThrow(/Checksum mismatch/);
	});
});

describe("archive extraction", () => {
	it("keeps the Unix Node members and maps the Windows ZIP's members into the same layout", () => {
		expect(nodeArchiveEntries("24.14.1", "linux-x64")).toEqual({
			root: "node-v24.14.1-linux-x64",
			entries: [
				{ member: "node-v24.14.1-linux-x64/bin/node", path: "bin/node" },
				{ member: "node-v24.14.1-linux-x64/lib/node_modules/npm", path: "lib/node_modules/npm" },
				{ member: "node-v24.14.1-linux-x64/LICENSE", path: "LICENSE" },
			],
		});
		expect(nodeArchiveEntries("24.14.1", "darwin-arm64").root).toBe("node-v24.14.1-darwin-arm64");
		expect(nodeArchiveEntries("24.14.1", "win32-x64")).toEqual({
			root: "node-v24.14.1-win-x64",
			entries: [
				{ member: "node-v24.14.1-win-x64/node.exe", path: "bin/node.exe" },
				{ member: "node-v24.14.1-win-x64/node_modules/npm", path: "lib/node_modules/npm" },
				{ member: "node-v24.14.1-win-x64/LICENSE", path: "LICENSE" },
			],
		});
	});

	it("names the Engram binary inside each archive", () => {
		expect(engramBinaryName("darwin-arm64")).toBe("engram");
		expect(engramBinaryName("linux-x64")).toBe("engram");
		expect(engramBinaryName("win32-x64")).toBe("engram.exe");
	});

	it("unpacks with tar -xzf on Unix and with Windows' own tar.exe, which reads ZIP, on Windows", () => {
		expect(archiveExtractor("linux-x64", {})).toEqual({ command: "tar", flags: "-xzf" });
		expect(archiveExtractor("darwin-arm64", { SystemRoot: "D:\\Win" })).toEqual({
			command: "tar",
			flags: "-xzf",
		});
		expect(archiveExtractor("win32-x64", { SystemRoot: "D:\\Win" })).toEqual({
			command: "D:\\Win\\System32\\tar.exe",
			flags: "-xf",
		});
		expect(archiveExtractor("win32-x64", {})).toEqual({
			command: "C:\\Windows\\System32\\tar.exe",
			flags: "-xf",
		});
	});
});

describe("npm install environment", () => {
	const npmConfig = (cache: string, join: (...parts: string[]) => string) => ({
		npm_config_userconfig: join(cache, "npmrc"),
		npm_config_cache: join(cache, "npm-cache"),
		npm_config_registry: "https://registry.npmjs.org/",
		npm_config_update_notifier: "false",
	});

	it("keeps the Unix environment: scratch HOME, the staged Node then the system PATH, TMPDIR", () => {
		const cache = join("repo", ".cache", "package");
		const nodeBin = join("out", "node", "bin");
		const unix = (env: Record<string, string>) => npmInstallEnv({ platform: "linux", nodeBin, cache, env });
		expect(unix({ TMPDIR: "/var/tmp", HOME: "/home/me", PATH: "/home/me/bin" })).toEqual({
			HOME: join(cache, "npm-home"),
			PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
			TMPDIR: "/var/tmp",
			...npmConfig(cache, join),
		});
		expect(unix({})).toMatchObject({ TMPDIR: "/tmp" });
		expect(npmInstallEnv({ platform: "darwin", nodeBin, cache, env: {} }).PATH).toBe(
			`${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
		);
	});

	it("gives Windows a project-local profile and temp, the staged Node then System32, and no user PATH", () => {
		const cache = "C:\\repo\\.cache\\package";
		const nodeBin = "C:\\repo\\build\\runtime\\win32-x64\\node\\bin";
		const home = "C:\\repo\\.cache\\package\\npm-home";
		const scratch = "C:\\repo\\.cache\\package\\tmp";
		const env = npmInstallEnv({
			platform: "win32",
			nodeBin,
			cache,
			env: {
				SystemRoot: "C:\\WINDOWS",
				ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
				PATHEXT: ".COM;.EXE;.CMD",
				USERPROFILE: "C:\\Users\\me",
				APPDATA: "C:\\Users\\me\\AppData\\Roaming",
				PATH: "C:\\Users\\me\\bin",
				TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
			},
		});
		expect(env).toEqual({
			HOME: home,
			USERPROFILE: home,
			APPDATA: `${home}\\AppData\\Roaming`,
			LOCALAPPDATA: `${home}\\AppData\\Local`,
			TEMP: scratch,
			TMP: scratch,
			SystemRoot: "C:\\WINDOWS",
			windir: "C:\\WINDOWS",
			ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
			PATHEXT: ".COM;.EXE;.CMD",
			PATH: `${nodeBin};C:\\WINDOWS\\System32;C:\\WINDOWS`,
			...npmConfig(cache, win32.join),
		});
		// gentle-pi builds its Gentle AI binary from source on Windows with the host's Go.
		expect(
			npmInstallEnv({ platform: "win32", nodeBin, cache, goBin: "C:\\Program Files\\Go\\bin", env: {} }).PATH,
		).toBe(`${nodeBin};C:\\Program Files\\Go\\bin;C:\\Windows\\System32;C:\\Windows`);
		// Windows keeps a second spelling of PATH and Go's own variables: none of them reaches npm.
		const inherited = npmInstallEnv({
			platform: "win32",
			nodeBin,
			cache,
			goBin: "C:\\Go\\bin",
			env: { Path: "C:\\Users\\me\\tools", GOPATH: "C:\\Users\\me\\go", SystemRoot: "C:\\Windows" },
		});
		expect(JSON.stringify(inherited)).not.toMatch(/Users/);
		expect(inherited.PATH).toBe(`${nodeBin};C:\\Go\\bin;C:\\Windows\\System32;C:\\Windows`);
		expect(npmInstallEnv({ platform: "win32", nodeBin, cache, env: {} })).toMatchObject({
			SystemRoot: "C:\\Windows",
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
			PATHEXT: ".COM;.EXE;.BAT;.CMD",
			PATH: `${nodeBin};C:\\Windows\\System32;C:\\Windows`,
		});
	});
});

describe("host commands", () => {
	it("spawns commands directly on Unix", () => {
		expect(hostCommand("pnpm", ["--filter", "@gentle-dot/ui", "build"], "darwin")).toEqual({
			command: "pnpm",
			args: ["--filter", "@gentle-dot/ui", "build"],
			shell: false,
		});
	});

	it("runs Windows commands such as pnpm.cmd through the shell with quoted arguments", () => {
		expect(
			hostCommand(
				"pnpm",
				["--filter", "@gentle-dot/daemon", "build:runtime", "--", "--out", "C:\\My Apps\\rt"],
				"win32",
			),
		).toEqual({
			command: 'pnpm --filter @gentle-dot/daemon build:runtime -- --out "C:\\My Apps\\rt"',
			args: [],
			shell: true,
		});
		for (const unsafe of ['a"b', "50%", "a&b", "a|b", "a^b", "a<b", "a>b"])
			expect(() => hostCommand("pnpm", [unsafe], "win32")).toThrow(
				`Cannot pass ${unsafe} through the Windows shell.`,
			);
		// The command name goes through the same shell, so it is checked too.
		expect(() => hostCommand("pn&pm", [], "win32")).toThrow("Cannot pass pn&pm through the Windows shell.");
	});
});

describe("npm wrappers", () => {
	it("keeps the Unix bin/npm script unchanged", () => {
		expect(npmWrapper("npm-cli.js")).toBe(`#!/bin/sh
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
exec "$bin/node" "$bin/../lib/node_modules/npm/bin/npm-cli.js" "$@"
`);
	});

	it("writes Windows npm.cmd / npx.cmd that run the staged npm next to themselves", () => {
		expect(npmCmdWrapper("npx-cli.js")).toBe(
			"@echo off\r\n" +
				"rem Runs the npm bundled with this Node, wherever the runtime folder is copied.\r\n" +
				'"%~dp0node.exe" "%~dp0..\\lib\\node_modules\\npm\\bin\\npx-cli.js" %*\r\n',
		);
	});

	it.runIf(process.platform === "win32")(
		"runs npm.cmd from a moved folder with spaces, passing arguments and the exit code",
		() => {
			const bin = join(fixtureDir(), "moved runtime", "node", "bin");
			const npm = join(bin, "..", "lib", "node_modules", "npm", "bin");
			mkdirSync(npm, { recursive: true });
			mkdirSync(bin, { recursive: true });
			try {
				linkSync(process.execPath, join(bin, "node.exe"));
			} catch {
				copyFileSync(process.execPath, join(bin, "node.exe"));
			}
			writeFileSync(
				join(npm, "npm-cli.js"),
				'console.log(JSON.stringify(process.argv.slice(1))); process.exit(process.argv.includes("fail") ? 3 : 0);\n',
			);
			writeFileSync(join(bin, "npm.cmd"), npmCmdWrapper("npm-cli.js"));
			const npmCmd = (...args: string[]) =>
				spawnSync([`"${join(bin, "npm.cmd")}"`, ...args].join(" "), { shell: true, encoding: "utf8" });
			const ok = npmCmd("--version", '"a b"');
			expect(ok.stderr).toBe("");
			expect(ok.status).toBe(0);
			expect(JSON.parse(ok.stdout)).toEqual([join(npm, "npm-cli.js"), "--version", "a b"]);
			expect(npmCmd("fail").status).toBe(3);
		},
	);
});

describe("tree and manifest", () => {
	it("sizes a tree without following links, and lists the links", () => {
		const dir = fixtureDir();
		writeFileSync(join(dir, "a"), "12345");
		symlinkSync("a", join(dir, "link"));
		expect(treeSize(dir)).toBe(5 + 1);
		expect(symlinksIn(dir)).toEqual(["link"]);
	});

	it("records the versions, the commit, and the size", () => {
		const manifest = buildManifest({
			target: "darwin-arm64",
			versions: { node: "24.14.1", engram: "3.2.1", gentlePi: "4.0.0" },
			daemonCommit: "abc123",
			sizeBytes: 3 * 1024 * 1024,
			stagedAt: "2026-10-09T00:00:00.000Z",
		});
		expect(manifest).toMatchObject({ name: "gentle-dot-runtime", size: "3.0 MB", daemonCommit: "abc123" });
		expect(() =>
			buildManifest({
				target: "darwin-arm64",
				versions: { node: "24.14.1" },
				daemonCommit: "x",
				sizeBytes: 0,
			}),
		).toThrow(/engram/);
	});
});
