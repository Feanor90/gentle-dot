import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const fixtures: string[] = [];
afterAll(() => {
	// A just-ended probe can still hold a fixture open on Windows, so retry before asserting it is gone.
	for (const dir of fixtures) rmSync(dir, { recursive: true, maxRetries: 10, retryDelay: 100 });
	for (const dir of fixtures) expect(existsSync(dir)).toBe(false);
});

function stagedEngine(compatible: boolean, keepsAlive = false) {
	const dir = mkdtempSync(join(process.cwd(), ".staged-engine-fixture-"));
	fixtures.push(dir);
	const engine = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
	const codemode = join(dir, "node_modules", "@earendil-works", "pi-codemode");
	for (const path of [engine, codemode]) mkdirSync(path, { recursive: true });
	writeFileSync(join(engine, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
	writeFileSync(
		join(codemode, "package.json"),
		JSON.stringify({ type: "module", exports: { "./declarations": "./index.js" } }),
	);
	writeFileSync(
		join(engine, "index.js"),
		'import { MCP_TYPESCRIPT_PREAMBLE } from "@earendil-works/pi-codemode/declarations";\n' +
			// The real engine leaves handles open after a successful import.
			(keepsAlive ? "setInterval(() => {}, 1000);\n" : ""),
	);
	writeFileSync(
		join(codemode, "index.js"),
		compatible ? 'export const MCP_TYPESCRIPT_PREAMBLE = "";\n' : 'export const other = "";\n',
	);
	return { dir, declarations: join(codemode, "index.js") };
}

function probe(dir: string) {
	return spawnSync(process.execPath, ["scripts/package/staged-engine.mjs", dir, process.execPath], {
		encoding: "utf8",
	});
}

describe("staged engine import guard", () => {
	it("rejects an incompatible staged dependency graph without changing it", () => {
		const { dir, declarations } = stagedEngine(false);
		const before = readFileSync(declarations, "utf8");
		const result = probe(dir);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("MCP_TYPESCRIPT_PREAMBLE");
		expect(result.stderr).toContain("Staged engine import failed");
		expect(readFileSync(declarations, "utf8")).toBe(before);
	});

	it("accepts a compatible staged graph and reports the successful import", () => {
		const { dir } = stagedEngine(true);
		const result = probe(dir);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe("Staged engine import: ok\n");
	});

	it("accepts an engine that keeps the process alive after importing", () => {
		const { dir } = stagedEngine(true, true);
		const started = Date.now();
		const result = probe(dir);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("Staged engine import: ok\n");
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 30_000);

	it("rejects a staged tree without the engine", () => {
		const dir = mkdtempSync(join(process.cwd(), ".staged-engine-fixture-"));
		fixtures.push(dir);
		const result = probe(dir);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
		expect(result.stderr).toContain("Staged engine import failed");
	});

	it("rejects a missing node executable", () => {
		const { dir } = stagedEngine(true);
		const result = spawnSync(
			process.execPath,
			["scripts/package/staged-engine.mjs", dir, join(dir, "no-node.exe")],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ENOENT");
	});

	it("prints the usage without arguments", () => {
		const result = spawnSync(process.execPath, ["scripts/package/staged-engine.mjs"], { encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("usage: staged-engine <daemon-dir> <node-executable>\n");
	});
});
