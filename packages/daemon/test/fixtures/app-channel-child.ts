#!/usr/bin/env node
// A daemon stand-in that received the desktop app's end of the channel on fd 3 (like the real
// daemon, spawned by the app). It opens the channel the way cli.ts does, spawns children the way
// the daemon spawns the engine and stdio servers, and reports over the channel what each child saw
// on fd 3. Argument "leak": open with a probe that passes fd 3 on, as a platform that leaks would.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { childInherits, openInheritedChannel } from "../../src/app-channel.ts";

/** What a child sees on fd 3: the socket's identity, or "none". */
const PRINT_FD3 =
	"try{const s=require('fs').fstatSync(3,{bigint:true});console.log(s.isSocket()?s.dev+':'+s.ino:'other')}catch{console.log('none')}";

const own = fstatSync(3, { bigint: true });
const identity = `${own.dev}:${own.ino}`;
const leak = process.argv[2] === "leak";
const channel = openInheritedChannel({
	log: (line) => process.stderr.write(`${line}\n`),
	...(leak
		? { probe: (fd: number, id: string) => childInherits(fd, id, ["ignore", "pipe", "ignore", fd]) }
		: {}),
});
if (!channel) {
	// Refused: fd 3 must be closed too, so nothing below could pass it on.
	let closed = false;
	try {
		fstatSync(3);
	} catch {
		closed = true;
	}
	process.stdout.write(`${JSON.stringify({ refused: true, closed })}\n`);
	process.exit(0);
}

const fromSpawn = await new Promise<string>((resolve) => {
	// Like the supervisor starts the engine: pipes for stdio and nothing else.
	const child = spawn(process.execPath, ["-e", PRINT_FD3], { stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.on("close", () => resolve(out.trim()));
});
const fromSpawnSync = spawnSync(process.execPath, ["-e", PRINT_FD3], { encoding: "utf8" }).stdout.trim();
// Through a shell, as sign-in commands run. Windows' cmd.exe cannot look at fd 3: Node behind it does.
const fromShell =
	process.platform === "win32"
		? spawnSync(
				process.env.ComSpec ?? "cmd.exe",
				["/d", "/s", "/c", `""${process.execPath}" -e "${PRINT_FD3}""`],
				{
					encoding: "utf8",
					windowsVerbatimArguments: true,
				},
			).stdout.trim()
		: execFileSync("/bin/sh", ["-c", "if [ -e /dev/fd/3 ]; then echo open; else echo none; fi"], {
				encoding: "utf8",
			}).trim();
/**
 * Windows: Node sees descriptors, not handles. When the app's test passes its handle probe
 * (`GENTLE_DOT_TEST_HANDLE_PROBE`: `{program, args, server}`), each kind of child runs it on the
 * value of fd 3's handle (`ino` on Windows), which an inherited handle keeps: "leaked" when that
 * value is, in the child, an end of the app's pipe.
 */
async function handleProbes(): Promise<Record<string, string> | undefined> {
	const given = process.env.GENTLE_DOT_TEST_HANDLE_PROBE;
	if (process.platform !== "win32" || !given) return undefined;
	const probe = JSON.parse(given) as { program: string; args: string[]; server: number };
	const env = { ...process.env, GENTLE_DOT_TEST_CHILD: `pipe:${own.ino}:${probe.server}` };
	const verdict = (out: string) => out.match(/probe (leaked|closed)/)?.[1] ?? `unknown: ${out}`;
	const fromSpawn = await new Promise<string>((resolve) => {
		const child = spawn(probe.program, probe.args, { stdio: ["pipe", "pipe", "pipe"], env });
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.on("close", () => resolve(verdict(out)));
	});
	const fromSpawnSync = verdict(spawnSync(probe.program, probe.args, { encoding: "utf8", env }).stdout);
	const line = [`"${probe.program}"`, ...probe.args].join(" ");
	const fromShell = verdict(
		spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
			encoding: "utf8",
			env,
			windowsVerbatimArguments: true,
		}).stdout,
	);
	return { value: String(own.ino), fromSpawn, fromSpawnSync, fromShell };
}

channel.handler = async (method, params) => (method === "echo" ? params : undefined);
await channel.request(
	"report",
	{
		identity,
		fromSpawn,
		fromSpawnSync,
		fromShell,
		detectsALeak: childInherits(3, identity, ["ignore", "pipe", "ignore", 3]),
		handles: await handleProbes(),
	},
	5000,
);
channel.close();
