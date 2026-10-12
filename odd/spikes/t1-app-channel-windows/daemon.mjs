// Daemon stand-in: opens the app's end on fd 3, spawns grandchildren the daemon's ways, reports.
import { spawn, spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { Socket } from "node:net";

const [handle, helper] = process.argv.slice(2);
const stat = (() => {
	try {
		const s = fstatSync(3, { bigint: true });
		return { isSocket: s.isSocket(), isFIFO: s.isFIFO(), isFile: s.isFile(), dev: String(s.dev), ino: String(s.ino), mode: Number(s.mode) };
	} catch (error) {
		return { error: String(error) };
	}
})();

process.stderr.write(`stat ${JSON.stringify(stat)}\n`);
const socket = new Socket({ fd: 3, readable: true, writable: true });
socket.setEncoding("utf8");
const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
process.stderr.write("socket opened\n");
send({ kind: "hello", pid: process.pid, stat });

const parse = (out) => {
	try {
		return JSON.parse(String(out).trim());
	} catch {
		return { raw: String(out) };
	}
};
const fromSpawn = await new Promise((resolve) => {
	const child = spawn(helper, ["grandchild", handle, "spawn"], { stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (c) => (out += c));
	child.on("close", () => resolve(parse(out)));
});
const fromSpawnSync = parse(spawnSync(helper, ["grandchild", handle, "spawnSync"], { encoding: "utf8" }).stdout);
const fromShell = parse(
	spawnSync("cmd.exe", ["/d", "/c", helper, "grandchild", handle, "shell"], { encoding: "utf8" }).stdout,
);
const nodeFd3 = spawnSync(
	process.execPath,
	["-e", "try{require('fs').fstatSync(3);console.log('open')}catch{console.log('none')}"],
	{ encoding: "utf8" },
).stdout.trim();

socket.on("data", (chunk) => send({ kind: "echo", chunk }));
socket.on("end", () => process.exit(0));
socket.on("close", () => process.exit(0));
send({ kind: "report", fromSpawn, fromSpawnSync, fromShell, nodeFd3 });
