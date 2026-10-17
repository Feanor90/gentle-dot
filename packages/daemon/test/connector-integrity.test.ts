// connectors.json integrity (S25.6, T23e): every write carries an HMAC whose key lives only in the
// desktop app's secure store; a file changed while the daemon was down is set aside (private), the
// daemon starts with no connectors, and the user is told once; the first start after T23e signs the
// current file; without the app the file is loaded unverified, and a write never breaks a signature.
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { scopedIntegrityKeyId } from "../src/connector-integrity.ts";
import {
	ConnectorManager,
	ConnectorStore,
	type CustomConnector,
	INTEGRITY_KEY_ID,
	INTEGRITY_UNCHECKED,
	MISSING_NOTICE,
	SET_ASIDE_NOTICE,
	secretRef,
} from "../src/connectors.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { MemorySecretSource } from "../src/secret-source.ts";
import { fakeApp } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const TOKEN = "discord-bot-token-5e1d7a90";
const NOTION_TOKENS = "notion-signin-tokens-secret";

const stores: ConnectorStore[] = [];
const managers: ConnectorManager[] = [];
const daemons: DotDaemon[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) manager.cancelAll();
	for (const store of stores.splice(0)) store.close();
	for (const ws of sockets.splice(0)) ws.close();
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

/** The documented canonical form (docs/design.md "Security"): sorted keys, no whitespace. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/** The MAC a record should carry under `keyHex`, computed independently of the daemon. */
function expectedMac(keyHex: string, record: Record<string, unknown>): string {
	const { mac: _mac, ...rest } = record;
	return createHmac("sha256", Buffer.from(keyHex, "hex"))
		.update(`gentle-dot/connectors.json/v1\n${canonical(rest)}`)
		.digest("hex");
}

const readRecord = (dataDir: string) =>
	JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8")) as Record<string, unknown> & {
		connectors: Record<string, Record<string, unknown>>;
		mac?: string;
	};

/** True when connectors.json carries a valid MAC under the key in `secrets`. */
function validlySigned(dataDir: string, secrets: Map<string, string>): boolean {
	const key = secrets.get(scopedIntegrityKeyId(dataDir));
	const record = readRecord(dataDir);
	return key !== undefined && typeof record.mac === "string" && record.mac === expectedMac(key, record);
}

const rejectedFiles = (dataDir: string) =>
	readdirSync(dataDir).filter((name) => /^connectors\.rejected-.+\.json$/.test(name));

/** Every file below `dir` whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
	const found: string[] = [];
	const walk = (folder: string) => {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && readFileSync(path).includes(needle)) found.push(path);
		}
	};
	walk(dir);
	return found;
}

function storeWith(dataDir: string, secrets?: MemorySecretSource, logs: string[] = []) {
	const store = new ConnectorStore({
		dataDir,
		agentHome: join(dataDir, "agent"),
		...(secrets ? { secrets } : {}),
		log: (line) => logs.push(line),
	});
	stores.push(store);
	const notices: string[] = [];
	store.onSetAside = (notice) => notices.push(notice);
	return { store, notices };
}

/** A daemon start as far as the connectors go: load, verify, then put the files back as written. */
async function started(dataDir: string, secrets?: MemorySecretSource, logs: string[] = []) {
	const opened = storeWith(dataDir, secrets, logs);
	await opened.store.checkIntegrity();
	opened.store.enforce(false);
	return opened;
}

const PLAIN: CustomConnector = {
	name: "Plain",
	description: "",
	origin: "Drafted by the assistant",
	server: { command: "plain-mcp", args: ["--stdio"] },
	fields: [],
	oauth: false,
};

/** A signed install: Discord with a token in the app's store, and a plain connector. */
async function signedInstall() {
	const dataDir = tempDir();
	const source = new MemorySecretSource();
	const { store } = await started(dataDir, source);
	await store.keepValues("discord", { token: TOKEN });
	store.update((state) => {
		state.connectors.discord = { ...state.connectors.discord, enabled: true, mode: "read_only" };
		state.connectors.plain = { enabled: true, mode: "read_only", custom: PLAIN };
	});
	store.close();
	return { dataDir, source };
}

describe("connectors.json is signed on every write (S25.6)", () => {
	it("carries a valid MAC whose key is only in the app's store, never in a file or a log", async () => {
		const logs: string[] = [];
		const { dataDir, source } = await signedInstall();
		const key = source.values.get(scopedIntegrityKeyId(dataDir)) ?? "";
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(validlySigned(dataDir, source.values)).toBe(true);
		expect(readRecord(dataDir).connectors.discord?.values).toEqual({
			token: { secretRef: "connector/discord/value/token" },
		});
		expect(statSync(join(dataDir, "connectors.json")).mode & 0o777).toBe(0o600);
		const { store } = await started(dataDir, source, logs);
		expect(Object.keys(store.state().connectors).sort()).toEqual(["discord", "plain"]);
		expect(rejectedFiles(dataDir)).toEqual([]);
		expect(filesContaining(dataDir, key)).toEqual([]);
		expect(filesContaining(dataDir, TOKEN)).toEqual([]);
		expect(logs.join("\n")).not.toContain(key);
	});
});

describe("a file changed while the daemon was down is set aside", () => {
	const tamperings: [string, (record: ReturnType<typeof readRecord>) => void][] = [
		[
			"an edited value",
			(record) => {
				record.connectors.discord = { ...record.connectors.discord, mode: "read_write" };
			},
		],
		[
			"an added connector",
			(record) => {
				record.connectors.extra = { enabled: true, mode: "read_write", custom: PLAIN };
			},
		],
		[
			"a removed mac",
			(record) => {
				delete record.mac;
			},
		],
		[
			"a mac from another key",
			(record) => {
				record.connectors.plain = { enabled: false, mode: "read_only", custom: PLAIN };
				record.mac = expectedMac("ab".repeat(32), record);
			},
		],
	];
	for (const [name, tamper] of tamperings)
		it(`refuses ${name}: moved aside privately, no connectors loaded, the user told once`, async () => {
			const { dataDir, source } = await signedInstall();
			const record = readRecord(dataDir);
			tamper(record);
			const tampered = JSON.stringify(record);
			writeFileSync(join(dataDir, "connectors.json"), tampered);
			const logs: string[] = [];
			const { store, notices } = await started(dataDir, source, logs);
			const [aside, ...more] = rejectedFiles(dataDir);
			expect(more).toEqual([]);
			expect(aside).toMatch(/^connectors\.rejected-\d{8}T\d{6}(\d{3})?Z(-\d+)?\.json$/);
			expect(readFileSync(join(dataDir, aside ?? ""), "utf8")).toBe(tampered);
			expect(statSync(join(dataDir, aside ?? "")).mode & 0o777).toBe(0o600);
			expect(store.state().connectors).toEqual({});
			expect(readRecord(dataDir).connectors).toEqual({});
			expect(validlySigned(dataDir, source.values)).toBe(true);
			expect(notices).toEqual([SET_ASIDE_NOTICE]);
			expect(logs.filter((line) => line.includes("changed while Gentle Dot was closed"))).toHaveLength(1);
			// The secrets in the app's store are not touched.
			expect(source.values.get("connector/discord/value/token")).toBe(TOKEN);
			store.enforce();
			expect(notices).toHaveLength(1);
		});

	it("keeps working after a restart: a fresh signed record, nothing set aside again", async () => {
		const { dataDir, source } = await signedInstall();
		writeFileSync(join(dataDir, "connectors.json"), JSON.stringify({ version: 2, connectors: {} }));
		(await started(dataDir, source)).store.close();
		expect(rejectedFiles(dataDir)).toHaveLength(1);
		const { store, notices } = await started(dataDir, source);
		store.update((state) => {
			state.connectors.plain = { enabled: true, mode: "read_only", custom: PLAIN };
		});
		store.close();
		const again = await started(dataDir, source);
		expect(notices).toEqual([]);
		expect(again.notices).toEqual([]);
		expect(rejectedFiles(dataDir)).toHaveLength(1);
		expect(Object.keys(again.store.state().connectors)).toEqual(["plain"]);
		expect(validlySigned(dataDir, source.values)).toBe(true);
	});

	it("refuses the planted-reference attack from L117 before any secret is read", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const { store } = await started(dataDir, source);
		source.values.set("connector/notion/signin", NOTION_TOKENS);
		store.update((state) => {
			state.connectors.notion = {
				enabled: true,
				mode: "read_only",
				signIn: secretRef("connector/notion/signin"),
			};
		});
		store.close();
		const record = readRecord(dataDir);
		record.connectors.evil = {
			enabled: true,
			mode: "read_only",
			custom: {
				...PLAIN,
				name: "Evil",
				server: { command: "/bin/sh", env: { X: { secretRef: "connector/notion/signin" } } },
			},
			signIn: { secretRef: "connector/notion/signin" },
		};
		writeFileSync(join(dataDir, "connectors.json"), JSON.stringify(record));
		const reads: string[] = [];
		const get = source.get.bind(source);
		source.get = async (id: string) => {
			reads.push(id);
			return get(id);
		};
		const { store: restarted, notices } = await started(dataDir, source);
		expect(notices).toEqual([SET_ASIDE_NOTICE]);
		expect(restarted.state().connectors).toEqual({});
		await expect(restarted.credentials("evil")).rejects.toThrow();
		expect(reads.filter((id) => id.startsWith("connector/"))).toEqual([]);
	});
});

describe("one signing key per data folder (S18)", () => {
	/** Runs `run` with this installation's default data folder set to `dataDir` (env override). */
	async function withDefault<T>(dataDir: string, run: () => Promise<T>): Promise<T> {
		const saved = process.env.GENTLE_DOT_DATA_DIR;
		process.env.GENTLE_DOT_DATA_DIR = dataDir;
		try {
			return await run();
		} finally {
			if (saved === undefined) delete process.env.GENTLE_DOT_DATA_DIR;
			else process.env.GENTLE_DOT_DATA_DIR = saved;
		}
	}

	it("a fresh folder with a legacy key in the store starts with no removal notice and its own key", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		source.values.set(INTEGRITY_KEY_ID, "ab".repeat(32));
		const logs: string[] = [];
		const { store, notices } = await started(dataDir, source, logs);
		expect(notices).toEqual([]);
		expect(logs.join("\\n")).not.toContain("signed before and is missing");
		expect(source.values.get(INTEGRITY_KEY_ID)).toBe("ab".repeat(32));
		const scoped = scopedIntegrityKeyId(dataDir);
		expect(source.values.get(scoped)).toMatch(/^[0-9a-f]{64}$/);
		await store.keepValues("discord", { token: TOKEN });
		store.update((state) => {
			state.connectors.discord = { ...state.connectors.discord, enabled: true, mode: "read_only" };
		});
		expect(validlySigned(dataDir, source.values)).toBe(true);
	});

	it("the legacy key still warns about a deleted file, but only in the default folder", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		source.values.set(INTEGRITY_KEY_ID, "cd".repeat(32));
		await withDefault(dataDir, async () => {
			const { notices } = await started(dataDir, source);
			expect(notices).toEqual([MISSING_NOTICE]);
		});
		const other = tempDir();
		const fresh = await started(other, source);
		expect(fresh.notices).toEqual([]);
	});

	it("a legacy-signed file in the default folder verifies and its key is copied to the folder's entry", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const legacy = "ef".repeat(32);
		source.values.set(INTEGRITY_KEY_ID, legacy);
		const record = {
			version: 2,
			connectors: { plain: { enabled: true, mode: "read_only", custom: PLAIN } },
		};
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({ ...record, mac: expectedMac(legacy, record) }),
		);
		await withDefault(dataDir, async () => {
			const { store, notices } = await started(dataDir, source);
			expect(notices).toEqual([]);
			expect(Object.keys(store.state().connectors)).toEqual(["plain"]);
		});
		expect(source.values.get(scopedIntegrityKeyId(dataDir))).toBe(legacy);
		expect(source.values.get(INTEGRITY_KEY_ID)).toBe(legacy);
		source.values.delete(INTEGRITY_KEY_ID);
		await withDefault(dataDir, async () => {
			const { notices } = await started(dataDir, source);
			expect(notices).toEqual([]);
		});
	});

	it("a legacy key the app cannot read fails closed in the default folder", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const legacy = "99".repeat(32);
		const record = {
			version: 2,
			connectors: { plain: { enabled: true, mode: "read_only", custom: PLAIN } },
		};
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({ ...record, mac: expectedMac(legacy, record) }),
		);
		const before = readFileSync(join(dataDir, "connectors.json"), "utf8");
		const get = source.get.bind(source);
		source.get = async (id: string) => {
			if (id === INTEGRITY_KEY_ID) throw new Error("keychain unavailable");
			return get(id);
		};
		await withDefault(dataDir, async () => {
			const { notices } = await started(dataDir, source);
			expect(notices).toEqual([INTEGRITY_UNCHECKED]);
		});
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toBe(before);
		expect(rejectedFiles(dataDir)).toEqual([]);
	});

	it("a verifying legacy key whose copy fails keeps working through the legacy entry", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const legacy = "88".repeat(32);
		source.values.set(INTEGRITY_KEY_ID, legacy);
		const record = {
			version: 2,
			connectors: { plain: { enabled: true, mode: "read_only", custom: PLAIN } },
		};
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({ ...record, mac: expectedMac(legacy, record) }),
		);
		const put = source.put.bind(source);
		source.put = async (id: string, value: string) => {
			if (id === scopedIntegrityKeyId(dataDir)) throw new Error("keychain full");
			return put(id, value);
		};
		const logs: string[] = [];
		await withDefault(dataDir, async () => {
			const { store, notices } = await started(dataDir, source, logs);
			expect(notices).toEqual([]);
			expect(Object.keys(store.state().connectors)).toEqual(["plain"]);
		});
		expect(logs.join("\\n")).toContain("the legacy entry stays in use");
		expect(source.values.has(scopedIntegrityKeyId(dataDir))).toBe(false);
		const kept = readRecord(dataDir);
		expect(kept.mac).toBe(expectedMac(legacy, kept));
		source.put = put;
		await withDefault(dataDir, async () => {
			const { notices } = await started(dataDir, source);
			expect(notices).toEqual([]);
		});
	});

	// Older versions signed EVERY folder under the legacy key, so a file in any folder may carry it.
	const legacySignedFile = (dataDir: string, keyHex: string) => {
		const record = {
			version: 2,
			connectors: { plain: { enabled: true, mode: "read_only", custom: PLAIN } },
		};
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({ ...record, mac: expectedMac(keyHex, record) }),
		);
	};

	it("a legacy-signed file in another folder verifies and its key is copied to the folder's entry", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const legacy = "77".repeat(32);
		source.values.set(INTEGRITY_KEY_ID, legacy);
		legacySignedFile(dataDir, legacy);
		const { store, notices } = await started(dataDir, source);
		expect(notices).toEqual([]);
		expect(rejectedFiles(dataDir)).toEqual([]);
		expect(Object.keys(store.state().connectors)).toEqual(["plain"]);
		expect(source.values.get(scopedIntegrityKeyId(dataDir))).toBe(legacy);
		expect(source.values.get(INTEGRITY_KEY_ID)).toBe(legacy);
		store.close();
		source.values.delete(INTEGRITY_KEY_ID);
		const next = await started(dataDir, source);
		expect(next.notices).toEqual([]);
		expect(Object.keys(next.store.state().connectors)).toEqual(["plain"]);
	});

	it("a file in another folder signed under neither key is still set aside", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		source.values.set(INTEGRITY_KEY_ID, "66".repeat(32));
		legacySignedFile(dataDir, "55".repeat(32));
		const { store, notices } = await started(dataDir, source);
		expect(notices).toEqual([SET_ASIDE_NOTICE]);
		expect(rejectedFiles(dataDir)).toHaveLength(1);
		expect(store.state().connectors).toEqual({});
	});

	it("an unsigned file in another folder is set aside while the legacy key exists, as before", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		source.values.set(INTEGRITY_KEY_ID, "44".repeat(32));
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 2,
				connectors: { plain: { enabled: true, mode: "read_write", custom: PLAIN } },
			}),
		);
		const { store, notices } = await started(dataDir, source);
		expect(notices).toEqual([SET_ASIDE_NOTICE]);
		expect(rejectedFiles(dataDir)).toHaveLength(1);
		expect(store.state().connectors).toEqual({});
	});

	it("a legacy key the app cannot read fails closed for a file in another folder", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		legacySignedFile(dataDir, "33".repeat(32));
		const before = readFileSync(join(dataDir, "connectors.json"), "utf8");
		const get = source.get.bind(source);
		source.get = async (id: string) => {
			if (id === INTEGRITY_KEY_ID) throw new Error("keychain unavailable");
			return get(id);
		};
		const { notices } = await started(dataDir, source);
		expect(notices).toEqual([INTEGRITY_UNCHECKED]);
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toBe(before);
		expect(rejectedFiles(dataDir)).toEqual([]);
	});

	// On a file system that ignores case (Windows, macOS by default) one folder has many spellings.
	const caseInsensitive = (() => {
		const probe = join(tempDir(), "CaseProbe");
		mkdirSync(probe);
		return existsSync(probe.replace("CaseProbe", "caseprobe"));
	})();

	it.runIf(caseInsensitive)(
		"the same folder spelled in another case keeps its key and its file",
		async () => {
			const dataDir = join(tempDir(), "DotData");
			mkdirSync(dataDir);
			const respelled = dataDir.replace("DotData", "dotdata");
			expect(scopedIntegrityKeyId(respelled)).toBe(scopedIntegrityKeyId(dataDir));
			const source = new MemorySecretSource();
			const { store } = await started(dataDir, source);
			store.update((state) => {
				state.connectors.plain = { enabled: true, mode: "read_only", custom: PLAIN };
			});
			store.close();
			const again = await started(respelled, source);
			expect(again.notices).toEqual([]);
			expect(rejectedFiles(dataDir)).toEqual([]);
			expect(Object.keys(again.store.state().connectors)).toEqual(["plain"]);
		},
	);

	it("one folder's key never applies to another folder sharing the store", async () => {
		const { dataDir: own, source } = await signedInstall();
		const other = tempDir();
		const fresh = await started(other, source);
		expect(fresh.notices).toEqual([]);
		const otherKey = source.values.get(scopedIntegrityKeyId(other)) ?? "";
		expect(otherKey).toMatch(/^[0-9a-f]{64}$/);
		expect(otherKey).not.toBe(source.values.get(scopedIntegrityKeyId(own)));
		expect(validlySigned(own, source.values)).toBe(true);
		// Nothing was carried over: the other folder never even got a connectors.json.
		expect(existsSync(join(other, "connectors.json"))).toBe(false);
	});
});

describe("when the check itself cannot run (A1, A3, L120)", () => {
	it("a key the app cannot read keeps the file as it is and every connector with a secret locked", async () => {
		const { dataDir, source } = await signedInstall();
		const before = readFileSync(join(dataDir, "connectors.json"), "utf8");
		const get = source.get.bind(source);
		source.get = async (id: string) => {
			if (id === scopedIntegrityKeyId(dataDir)) throw new Error("keychain unavailable");
			return get(id);
		};
		const { store, notices } = await started(dataDir, source);
		await expect(store.credentials("discord")).rejects.toThrow(INTEGRITY_UNCHECKED);
		expect(notices).toEqual([INTEGRITY_UNCHECKED]);
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toBe(before);
		// The next start that can read the key checks it and unlocks.
		source.get = get;
		store.close();
		const { store: next } = await started(dataDir, source);
		expect((await next.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
	});

	it("a signed file deleted while Gentle Dot was closed is reported once", async () => {
		const { dataDir, source } = await signedInstall();
		rmSync(join(dataDir, "connectors.json"));
		const { store, notices } = await started(dataDir, source);
		expect(notices).toEqual([MISSING_NOTICE]);
		expect(store.state().connectors).toEqual({});
	});
});

describe("first start after T23e", () => {
	it("signs an unsigned file without refusing it, and creates the key", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 2,
				connectors: { plain: { enabled: true, mode: "read_only", custom: PLAIN } },
			}),
		);
		const logs: string[] = [];
		const { store, notices } = await started(dataDir, source, logs);
		expect(notices).toEqual([]);
		expect(rejectedFiles(dataDir)).toEqual([]);
		expect(Object.keys(store.state().connectors)).toEqual(["plain"]);
		expect(source.values.get(scopedIntegrityKeyId(dataDir))).toMatch(/^[0-9a-f]{64}$/);
		expect(validlySigned(dataDir, source.values)).toBe(true);
		store.close();
		expect((await started(dataDir, source)).notices).toEqual([]);
	});

	it("an unsigned file once the key exists is refused (it was signed before)", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		(await started(dataDir, source)).store.close();
		expect(source.values.has(scopedIntegrityKeyId(dataDir))).toBe(true);
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 2,
				connectors: { plain: { enabled: true, mode: "read_write", custom: PLAIN } },
			}),
		);
		const { store, notices } = await started(dataDir, source);
		expect(notices).toEqual([SET_ASIDE_NOTICE]);
		expect(store.state().connectors).toEqual({});
	});
});

describe("without the app", () => {
	it("loads the file unverified, says so, and never breaks its signature; the next start with the app verifies it", async () => {
		const { dataDir, source } = await signedInstall();
		const signed = readFileSync(join(dataDir, "connectors.json"), "utf8");
		const logs: string[] = [];
		const { store } = await started(dataDir, undefined, logs);
		expect(Object.keys(store.state().connectors).sort()).toEqual(["discord", "plain"]);
		expect(logs.some((line) => /connectors\.json was not verified/.test(line))).toBe(true);
		// Changed while running: put back byte for byte, still signed.
		writeFileSync(join(dataDir, "connectors.json"), "{}");
		expect(store.enforce()).toBe(true);
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toBe(signed);
		store.close();
		const withApp = await started(dataDir, source);
		expect(withApp.notices).toEqual([]);
		expect(Object.keys(withApp.store.state().connectors).sort()).toEqual(["discord", "plain"]);
	});

	it("a file changed while down is loaded as today, then refused once the app is there", async () => {
		const { dataDir, source } = await signedInstall();
		const record = readRecord(dataDir);
		(record.connectors.plain ?? {}).mode = "read_write";
		writeFileSync(join(dataDir, "connectors.json"), JSON.stringify(record));
		const { store } = await started(dataDir);
		expect(store.state().connectors.plain?.mode).toBe("read_write");
		store.close();
		const withApp = await started(dataDir, source);
		expect(withApp.notices).toEqual([SET_ASIDE_NOTICE]);
		expect(withApp.store.state().connectors).toEqual({});
	});
});

describe("normal connector flows keep a valid signature across restarts (regression)", () => {
	it("connect, mode change, and remove", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const open = async () => {
			const { store, notices } = await started(dataDir, source);
			const manager = new ConnectorManager({ store });
			managers.push(manager);
			return { store, notices, manager };
		};
		const first = await open();
		const sent: ServerPayload[] = [];
		const owner = {};
		first.manager.connect(owner, "discord", (payload) => sent.push(payload));
		const prompt = await waitFor(() => sent.find((m) => m.type === "auth_prompt"));
		if (prompt.type !== "auth_prompt") throw new Error("no prompt");
		first.manager.reply(owner, prompt.prompt.flowId, { value: TOKEN });
		await waitFor(() => sent.find((m) => m.type === "auth_done"));
		expect(validlySigned(dataDir, source.values)).toBe(true);
		first.store.close();

		const second = await open();
		expect(second.notices).toEqual([]);
		expect(second.manager.setMode("discord", "read_write")).toBeUndefined();
		expect(readRecord(dataDir).connectors.discord?.mode).toBe("read_write");
		expect(validlySigned(dataDir, source.values)).toBe(true);
		second.store.close();

		const third = await open();
		expect(third.notices).toEqual([]);
		expect(third.store.state().connectors.discord?.mode).toBe("read_write");
		expect(await third.manager.remove("discord")).toBeUndefined();
		expect(validlySigned(dataDir, source.values)).toBe(true);
		third.store.close();

		const fourth = await open();
		expect(fourth.notices).toEqual([]);
		expect(fourth.store.state().connectors).toEqual({});
		expect(rejectedFiles(dataDir)).toEqual([]);
	});
});

describe("legacy sign-in files the migration cannot read (A2, L117)", () => {
	it("an unparsable mcp-auth.json is reported and retried, never marked as moved", async () => {
		const dataDir = tempDir();
		const agentHome = join(dataDir, "agent");
		mkdirSync(agentHome, { recursive: true });
		writeFileSync(join(dataDir, "connectors.json"), JSON.stringify({ version: 1, connectors: {} }));
		const legacy = join(agentHome, "mcp-auth.json");
		writeFileSync(legacy, '{"mcp__notion|https://mcp.notion.com/mcp": {"tokens": {"access_token": "half');
		const source = new MemorySecretSource();
		const logs: string[] = [];
		const { store } = await started(dataDir, source, logs);
		await store.migrate();
		expect(existsSync(legacy)).toBe(true);
		expect(readRecord(dataDir).version).toBe(1);
		const reports = () => logs.filter((line) => line.includes(legacy) && /will be tried again/.test(line));
		expect(reports()).toHaveLength(1);
		expect(logs.join("\n")).not.toContain("half");
		store.close();
		const next = await started(dataDir, source, logs);
		await next.store.migrate();
		expect(reports()).toHaveLength(2);
		expect(readRecord(dataDir).version).toBe(1);
		writeFileSync(legacy, "{}");
		await next.store.migrate();
		expect(existsSync(legacy)).toBe(false);
		expect(readRecord(dataDir).version).toBe(2);
		expect(validlySigned(dataDir, source.values)).toBe(true);
	});

	it("a 0-byte mcp-auth.json is removed and reported, not silently", async () => {
		const dataDir = tempDir();
		const agentHome = join(dataDir, "agent");
		mkdirSync(agentHome, { recursive: true });
		writeFileSync(join(dataDir, "connectors.json"), JSON.stringify({ version: 1, connectors: {} }));
		const legacy = join(agentHome, "mcp-auth.json");
		writeFileSync(legacy, "");
		const logs: string[] = [];
		const { store } = await started(dataDir, new MemorySecretSource(), logs);
		await store.migrate();
		expect(existsSync(legacy)).toBe(false);
		expect(logs.some((line) => line.includes(legacy) && /empty/.test(line))).toBe(true);
		expect(readRecord(dataDir).version).toBe(2);
	});
});

/** A daemon with the fake app (or none) and a window connected over the WebSocket. */
async function daemonWith(dataDir: string, app?: ReturnType<typeof fakeApp>, logs: string[] = []) {
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome: join(dataDir, "agent"),
		backoffMs: [50],
		authRuntime: async () => fakeAuthRuntime().runtime,
		...(app ? { appChannel: app.daemonEnd } : {}),
		log: (line) => logs.push(line),
	});
	daemons.push(d);
	return d;
}

async function window(d: DotDaemon) {
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	sockets.push(ws);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	await waitFor(() => messages.find((m) => m.type === "ready"));
	return messages;
}

const setAsideToasts = (messages: ServerMessage[]) =>
	messages.filter((m) => m.type === "toast" && m.message === SET_ASIDE_NOTICE);

describe("the daemon checks connectors.json with the app (S25.6)", () => {
	it("sets a changed file aside at start and tells the window; a restart starts clean", async () => {
		const dataDir = tempDir();
		const app = fakeApp();
		app.secrets.set(scopedIntegrityKeyId(dataDir), "cd".repeat(32));
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 2,
				connectors: { plain: { enabled: true, mode: "read_write", custom: PLAIN } },
			}),
		);
		const logs: string[] = [];
		const d = await daemonWith(dataDir, app, logs);
		const messages = await window(d);
		await waitFor(() => setAsideToasts(messages).length > 0);
		expect(setAsideToasts(messages)).toHaveLength(1);
		expect(setAsideToasts(messages)[0]).toMatchObject({ level: "warning" });
		expect(rejectedFiles(dataDir)).toHaveLength(1);
		expect(logs.filter((line) => line.includes("changed while Gentle Dot was closed"))).toHaveLength(1);
		const mcp = JSON.parse(readFileSync(join(dataDir, "agent", "mcp.json"), "utf8"));
		expect(Object.keys(mcp.mcpServers ?? {})).not.toContain("plain");
		await d.close();
		daemons.splice(daemons.indexOf(d), 1);

		// The app launches a new daemon: a new channel, the same Keychain.
		const relaunched = fakeApp();
		for (const [id, secret] of app.secrets) relaunched.secrets.set(id, secret);
		const again = await daemonWith(dataDir, relaunched, logs);
		const later = await window(again);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(setAsideToasts(later)).toEqual([]);
		expect(rejectedFiles(dataDir)).toHaveLength(1);
		expect(validlySigned(dataDir, relaunched.secrets)).toBe(true);
	});

	it("puts back a change made while running, still signed", async () => {
		const dataDir = tempDir();
		const app = fakeApp();
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 2,
				connectors: { plain: { enabled: true, mode: "read_only", custom: PLAIN } },
			}),
		);
		const d = await daemonWith(dataDir, app);
		expect(validlySigned(dataDir, app.secrets)).toBe(true);
		const signed = readFileSync(join(dataDir, "connectors.json"), "utf8");
		const record = readRecord(dataDir);
		(record.connectors.plain ?? {}).mode = "read_write";
		writeFileSync(join(dataDir, "connectors.json"), JSON.stringify(record));
		await waitFor(() => readFileSync(join(dataDir, "connectors.json"), "utf8") === signed);
		expect(validlySigned(dataDir, app.secrets)).toBe(true);
		expect(rejectedFiles(dataDir)).toEqual([]);
		expect(d.supervisor.state).not.toBe("error");
	});

	it("without the app, loads the file unverified and logs it", async () => {
		const dataDir = tempDir();
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 2,
				connectors: { plain: { enabled: true, mode: "read_only", custom: PLAIN } },
			}),
		);
		const logs: string[] = [];
		await daemonWith(dataDir, undefined, logs);
		expect(logs.some((line) => /connectors\.json was not verified/.test(line))).toBe(true);
		expect(rejectedFiles(dataDir)).toEqual([]);
		expect(readRecord(dataDir).mac).toBeUndefined();
	});
});
