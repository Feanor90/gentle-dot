#!/usr/bin/env node
// Import the installed engine with the staged Node before accepting a runtime.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [daemon, node] = process.argv.slice(2);
if (!daemon || !node) {
	process.stderr.write("usage: staged-engine <daemon-dir> <node-executable>\n");
	process.exit(2);
}
const result = spawnSync(
	resolve(node),
	// The engine leaves handles open after a successful import, so exit explicitly once it loaded.
	["--input-type=module", "-e", 'await import("@earendil-works/pi-coding-agent"); process.exit(0);'],
	{
		cwd: resolve(daemon),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 20_000,
	},
);
if (result.error || result.status !== 0) {
	process.stderr.write(result.stderr ?? "");
	process.stderr.write(`Staged engine import failed: ${result.error?.message ?? `exit ${result.status}`}\n`);
	process.exit(1);
}
process.stdout.write("Staged engine import: ok\n");
