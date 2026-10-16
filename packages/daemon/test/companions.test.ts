import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type CompanionsInput, materializeCompanions } from "../src/companions.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT } from "./helpers.ts";

const fixtures: string[] = [];
const daemons: DotDaemon[] = [];

// Disposable fixtures stay inside this project; never the user's profile or the system temp.
function tempDir(): string {
	const dir = mkdtempSync(join(realpathSync(process.cwd()), "companions-fixture-"));
	fixtures.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.allSettled(daemons.splice(0).map((d) => d.close()));
	for (const dir of fixtures.splice(0)) {
		rmSync(dir, { recursive: true, maxRetries: 10, retryDelay: 100 });
		expect(existsSync(dir)).toBe(false);
	}
});

/** Every file under `dir` with its text, for byte-for-byte comparisons. */
function snapshot(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	if (!existsSync(dir)) return files;
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) {
			const path = join(entry.parentPath, entry.name);
			files[path.slice(dir.length + 1).replaceAll("\\", "/")] = readFileSync(path, "utf8");
		}
	}
	return files;
}

/** A gentle-pi package with the given versions, as the daemon finds it next to the engine. */
function gentlePi(root: string, versions = { gentlePi: "9.9.9", gentleAi: "8.8.8" }): string {
	const pkg = join(root, "gentle-pi");
	mkdirSync(join(pkg, "bin"), { recursive: true });
	mkdirSync(join(pkg, "runtime"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "gentle-pi", version: versions.gentlePi }));
	writeFileSync(
		join(pkg, "runtime", "gentle-ai-binary.mjs"),
		`export const GENTLE_AI_VERSION = ${JSON.stringify(versions.gentleAi)};\n`,
	);
	// The wiring test runs it as the engine: it hands over to the fake agent.
	writeFileSync(
		join(pkg, "bin", "gentle-shell.mjs"),
		`await import(${JSON.stringify(pathToFileURL(FAKE_AGENT).href)});\n`,
	);
	return join(pkg, "bin", "gentle-shell.mjs");
}

/** `<runtime>/companions` with a template home and its manifest. */
function companions(root: string, manifest: unknown = { schema: 1, gentlePi: "9.9.9", gentleAi: "8.8.8" }) {
	const dir = join(root, "companions");
	const template = join(dir, "agent-home");
	mkdirSync(join(template, "npm", "node_modules", "gentle-engram"), { recursive: true });
	// A real setup into a new home writes this marker too; keep it different from the destination's.
	writeFileSync(join(template, ".gentle-shell-home"), '{"createdBy":"gentle-shell","version":"template"}\n');
	writeFileSync(join(template, "settings.json"), '{"packages":["npm:gentle-engram"]}\n');
	writeFileSync(join(template, "APPEND_SYSTEM.md"), "# appended\n");
	writeFileSync(
		join(template, "npm", "node_modules", "gentle-engram", "package.json"),
		'{"version":"1.0.0"}\n',
	);
	writeFileSync(
		join(dir, "manifest.json"),
		typeof manifest === "string" ? manifest : JSON.stringify(manifest),
	);
	return dir;
}

/** A data folder as the daemon leaves it before the engine starts: the home holds only its marker. */
function setup(options: { manifest?: unknown; versions?: { gentlePi: string; gentleAi: string } } = {}) {
	const root = tempDir();
	const dataDir = join(root, "data");
	const agentHome = join(dataDir, "agent");
	const engineHome = join(dataDir, "home");
	mkdirSync(agentHome, { recursive: true });
	mkdirSync(engineHome, { recursive: true });
	writeFileSync(join(agentHome, ".gentle-shell-home"), '{"createdBy":"gentle-shell"}\n');
	const lines: string[] = [];
	const input: CompanionsInput = {
		companions: companions(root, options.manifest),
		gentleShell: gentlePi(root, options.versions),
		dataDir,
		agentHome,
		engineHome,
		log: (line) => lines.push(line),
	};
	const config = join(engineHome, ".gentle-shell", "config.json");
	return { root, dataDir, agentHome, engineHome, input, lines, config };
}

describe("materializeCompanions", () => {
	it("prepares a fresh engine home from the packaged companions and records it as provisioned", async () => {
		const { input, agentHome, config, lines } = setup();
		const template = snapshot(join(input.companions as string, "agent-home"));
		const outcome = await materializeCompanions(input);
		expect(outcome).toEqual({ materialized: true });
		expect(snapshot(agentHome)).toEqual({
			...template,
			".gentle-shell-home": '{"createdBy":"gentle-shell"}\n',
		});
		const written = JSON.parse(readFileSync(config, "utf8"));
		expect(Object.keys(written)).toEqual(["provisioned"]);
		expect(Object.keys(written.provisioned)).toEqual([realpathSync(agentHome)]);
		const entry = written.provisioned[realpathSync(agentHome)];
		expect(entry).toMatchObject({ gentleAi: "8.8.8", gentlePi: "9.9.9" });
		expect(new Date(entry.at).toISOString()).toBe(entry.at);
		expect(lines).toEqual([
			"companions: prepared the engine home from the packaged companions (gentle-pi 9.9.9, Gentle AI 8.8.8)",
		]);
	});

	it("does not exempt ownership markers that are junctions or directories", async () => {
		for (const side of ["source", "destination"] as const) {
			for (const kind of ["junction", "directory"] as const) {
				const { input, root, agentHome, config, lines } = setup();
				const template = join(input.companions as string, "agent-home");
				const marker = join(side === "source" ? template : agentHome, ".gentle-shell-home");
				rmSync(marker);
				const target = join(root, "marker-target");
				mkdirSync(target);
				if (kind === "junction") symlinkSync(target, marker, "junction");
				else mkdirSync(marker);
				const before = snapshot(agentHome);
				const reason =
					side === "source" && kind === "junction"
						? "the packaged companions contain a link: .gentle-shell-home"
						: "the engine home already has .gentle-shell-home";
				expect(await materializeCompanions(input)).toEqual({ materialized: false, reason });
				expect(snapshot(agentHome)).toEqual(before);
				expect(readdirSync(target)).toEqual([]);
				expect(existsSync(config)).toBe(false);
				expect(lines).toEqual([`companions: not used: ${reason}`]);
			}
		}
	});

	it("reads the versions from the real bundled gentle-pi, not from a constant", async () => {
		const require = createRequire(import.meta.url);
		const real = dirname(require.resolve("gentle-pi/package.json"));
		const version = JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version;
		const { GENTLE_AI_VERSION } = await import(
			pathToFileURL(join(real, "runtime", "gentle-ai-binary.mjs")).href
		);
		const { input, agentHome, config } = setup({
			manifest: { schema: 1, gentlePi: version, gentleAi: GENTLE_AI_VERSION },
		});
		const outcome = await materializeCompanions({
			...input,
			gentleShell: join(real, "bin", "gentle-shell.mjs"),
		});
		expect(outcome).toEqual({ materialized: true });
		expect(JSON.parse(readFileSync(config, "utf8")).provisioned[realpathSync(agentHome)]).toMatchObject({
			gentleAi: GENTLE_AI_VERSION,
			gentlePi: version,
		});
	});

	it("does nothing and says nothing without packaged companions", async () => {
		const { input, agentHome, config, lines } = setup();
		const before = snapshot(agentHome);
		for (const missing of [undefined, join(input.dataDir, "no-companions")]) {
			const outcome = await materializeCompanions({ ...input, companions: missing });
			expect(outcome).toEqual({ materialized: false, reason: "no packaged companions" });
		}
		expect(snapshot(agentHome)).toEqual(before);
		expect(existsSync(config)).toBe(false);
		expect(lines).toEqual([]);
	});

	it("leaves an engine home that is already set up untouched", async () => {
		const { input, agentHome, config, lines } = setup();
		writeFileSync(join(agentHome, "settings.json"), '{"mine":true}\n');
		const before = snapshot(agentHome);
		const outcome = await materializeCompanions(input);
		expect(outcome).toEqual({ materialized: false, reason: "the engine home is already set up" });
		expect(snapshot(agentHome)).toEqual(before);
		expect(existsSync(config)).toBe(false);
		expect(lines).toEqual(["companions: not used: the engine home is already set up"]);
	});

	it("leaves an engine home whose packages folder exists untouched", async () => {
		const { input, agentHome, config } = setup();
		mkdirSync(join(agentHome, "npm"));
		const outcome = await materializeCompanions(input);
		expect(outcome).toEqual({ materialized: false, reason: "the engine home is already set up" });
		expect(readdirSync(join(agentHome, "npm"))).toEqual([]);
		expect(existsSync(config)).toBe(false);
	});

	it("leaves a home that gentle-shell already provisioned untouched", async () => {
		const { input, agentHome, config, lines } = setup();
		mkdirSync(dirname(config), { recursive: true });
		const text = JSON.stringify({
			provisioned: { [realpathSync(agentHome)]: { gentleAi: "1", gentlePi: "2", at: "x" } },
		});
		writeFileSync(config, text);
		const before = snapshot(agentHome);
		const outcome = await materializeCompanions(input);
		expect(outcome).toEqual({ materialized: false, reason: "the engine home is already provisioned" });
		expect(snapshot(agentHome)).toEqual(before);
		expect(readFileSync(config, "utf8")).toBe(text);
		expect(lines).toEqual(["companions: not used: the engine home is already provisioned"]);
	});

	it("refuses companions made for another gentle-pi or Gentle AI", async () => {
		for (const manifest of [
			{ schema: 1, gentlePi: "9.9.8", gentleAi: "8.8.8" },
			{ schema: 1, gentlePi: "9.9.9", gentleAi: "8.8.9" },
		]) {
			const { input, agentHome, config, lines } = setup({ manifest });
			const template = snapshot(join(input.companions as string, "agent-home"));
			const before = snapshot(agentHome);
			const outcome = await materializeCompanions(input);
			const reason = `the packaged companions are for gentle-pi ${manifest.gentlePi} and Gentle AI ${manifest.gentleAi}, not 9.9.9 and 8.8.8`;
			expect(outcome).toEqual({ materialized: false, reason });
			expect(snapshot(agentHome)).toEqual(before);
			expect(snapshot(join(input.companions as string, "agent-home"))).toEqual(template);
			expect(existsSync(config)).toBe(false);
			expect(lines).toEqual([`companions: not used: ${reason}`]);
		}
	});

	it("refuses a manifest it cannot read", async () => {
		for (const manifest of [
			"{not json",
			{ schema: 2, gentlePi: "9.9.9", gentleAi: "8.8.8" },
			{ schema: 1 },
		]) {
			const { input, agentHome, config, lines } = setup({ manifest });
			const before = snapshot(agentHome);
			const outcome = await materializeCompanions(input);
			expect(outcome).toEqual({ materialized: false, reason: "the packaged companions manifest is invalid" });
			expect(snapshot(agentHome)).toEqual(before);
			expect(existsSync(config)).toBe(false);
			expect(lines).toEqual(["companions: not used: the packaged companions manifest is invalid"]);
		}
	});

	it("refuses a template that holds a link, before copying anything", async () => {
		const { input, root, agentHome, config, lines } = setup();
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "not for the engine\n");
		// A junction needs no privilege on Windows and is a symbolic link elsewhere.
		symlinkSync(outside, join(input.companions as string, "agent-home", "npm", "linked"), "junction");
		const before = snapshot(agentHome);
		const outcome = await materializeCompanions(input);
		const reason = "the packaged companions contain a link: npm/linked";
		expect(outcome).toEqual({ materialized: false, reason });
		expect(snapshot(agentHome)).toEqual(before);
		expect(existsSync(config)).toBe(false);
		expect(lines).toEqual([`companions: not used: ${reason}`]);
	});

	it("refuses to overwrite a file the engine home already has, before copying anything", async () => {
		const { input, agentHome, config, lines } = setup();
		writeFileSync(join(agentHome, "APPEND_SYSTEM.md"), "the user's own\n");
		const before = snapshot(agentHome);
		const outcome = await materializeCompanions(input);
		const reason = "the engine home already has APPEND_SYSTEM.md";
		expect(outcome).toEqual({ materialized: false, reason });
		expect(snapshot(agentHome)).toEqual(before);
		expect(existsSync(config)).toBe(false);
		expect(lines).toEqual([`companions: not used: ${reason}`]);
	});

	it("keeps every other key and home in gentle-shell's config", async () => {
		const { input, agentHome, config } = setup();
		mkdirSync(dirname(config), { recursive: true });
		const other = { gentleAi: "1.0.0", gentlePi: "1.0.0", at: "2026-01-01T00:00:00.000Z" };
		writeFileSync(
			config,
			JSON.stringify({ home: "custom", extra: [1, 2], provisioned: { "/other/home": other } }),
		);
		const outcome = await materializeCompanions(input);
		expect(outcome).toEqual({ materialized: true });
		const written = JSON.parse(readFileSync(config, "utf8"));
		expect(written.home).toBe("custom");
		expect(written.extra).toEqual([1, 2]);
		expect(written.provisioned["/other/home"]).toEqual(other);
		expect(written.provisioned[realpathSync(agentHome)]).toMatchObject({
			gentleAi: "8.8.8",
			gentlePi: "9.9.9",
		});
		expect(readdirSync(dirname(config))).toEqual(["config.json"]);
	});

	it("leaves a config it cannot read untouched and copies nothing", async () => {
		const { input, agentHome, config, lines } = setup();
		mkdirSync(dirname(config), { recursive: true });
		writeFileSync(config, "{broken");
		const before = snapshot(agentHome);
		const outcome = await materializeCompanions(input);
		const reason = "gentle-shell's config is unreadable";
		expect(outcome).toEqual({ materialized: false, reason });
		expect(readFileSync(config, "utf8")).toBe("{broken");
		expect(snapshot(agentHome)).toEqual(before);
		expect(lines).toEqual([`companions: not used: ${reason}`]);
	});

	it("is only for the bundled gentle-shell and the assistant's own home", async () => {
		const { input, agentHome, config, lines } = setup();
		const before = snapshot(agentHome);
		const other = await materializeCompanions({ ...input, gentleShell: undefined });
		expect(other).toEqual({ materialized: false, reason: "the engine is not the bundled gentle-shell" });
		const chosen = await materializeCompanions({ ...input, agentHome: join(input.dataDir, "chosen") });
		expect(chosen).toEqual({ materialized: false, reason: "the engine home is not the assistant's own" });
		expect(snapshot(agentHome)).toEqual(before);
		expect(existsSync(join(input.dataDir, "chosen"))).toBe(false);
		expect(existsSync(config)).toBe(false);
		expect(lines).toEqual([
			"companions: not used: the engine is not the bundled gentle-shell",
			"companions: not used: the engine home is not the assistant's own",
		]);
	});
});

describe("startDaemon with packaged companions", () => {
	it("prepares the assistant's own home before the engine starts", async () => {
		const root = tempDir();
		const dataDir = join(root, "data");
		const realHome = join(root, "user");
		mkdirSync(realHome);
		const lines: string[] = [];
		const d = await startDaemon({
			port: 0,
			host: "127.0.0.1",
			dataDir,
			workspace: join(dataDir, "workspace"),
			uiDir: dataDir,
			agentCommand: process.execPath,
			agentArgs: [gentlePi(root)],
			agentHome: join(dataDir, "agent"),
			companions: companions(root),
			// As the other daemon tests: the real sign-in runtime writes into the home after close.
			authRuntime: async () => fakeAuthRuntime().runtime,
			agentEnv: { PATH: process.env.PATH, HOME: realHome },
			log: (line) => lines.push(line),
		});
		daemons.push(d);
		const agentHome = join(dataDir, "agent");
		expect(readFileSync(join(agentHome, "APPEND_SYSTEM.md"), "utf8")).toBe("# appended\n");
		const config = JSON.parse(readFileSync(join(dataDir, "home", ".gentle-shell", "config.json"), "utf8"));
		expect(config.provisioned[realpathSync(agentHome)]).toMatchObject({
			gentleAi: "8.8.8",
			gentlePi: "9.9.9",
		});
		expect(lines).toContain(
			"companions: prepared the engine home from the packaged companions (gentle-pi 9.9.9, Gentle AI 8.8.8)",
		);

		// Once closed, the daemon writes nothing more: a removed home stays removed.
		await d.close();
		rmSync(dataDir, { recursive: true, maxRetries: 10, retryDelay: 100 });
		await new Promise((done) => setTimeout(done, 300));
		expect(existsSync(dataDir)).toBe(false);
	});
});
