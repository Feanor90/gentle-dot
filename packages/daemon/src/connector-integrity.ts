/**
 * The signature on `connectors.json` (S25.6, docs/design.md "Security"). The daemon signs every
 * write with HMAC-SHA256 under a random 32-byte key kept in the desktop app's secure store (id
 * {@link INTEGRITY_KEY_ID}), and at start, with the app, refuses a file whose signature does not
 * match: it was changed while Gentle Dot was closed. The key reaches the daemon over the app's
 * channel and stays in memory; it is never written to a file or a log.
 *
 * What is signed: the UTF-8 bytes of {@link MAC_DOMAIN} followed by the record without its `mac`
 * field in canonical JSON: no whitespace, every object's keys sorted by UTF-16 code unit (the
 * default `Array.prototype.sort`), arrays in their order, and strings, numbers, booleans, and null
 * as `JSON.stringify` writes them. The `mac` field is the lowercase hex digest.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defaultDataDir } from "./config.ts";

/** The secret id of the signing key before data folders got their own (kept for migration). */
export const INTEGRITY_KEY_ID = "integrity/connectors";

/** `path` as it exists on disk, or resolved when it does not (yet). */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * The secret id of THIS data folder's signing key (S18): the legacy id plus a short hash of the
 * folder's real path, so one folder's key can never make another folder's missing file look
 * deleted. The key itself is unchanged; only where the store keeps it.
 */
export function scopedIntegrityKeyId(dataDir: string): string {
	return `${INTEGRITY_KEY_ID}/${createHash("sha256").update(realPath(dataDir)).digest("hex").slice(0, 16)}`;
}

/**
 * True when `dataDir` is the folder this installation uses by default (the env override included):
 * the only folder whose MISSING file the legacy id's key can be attributed to. A file that is there
 * is checked against the legacy key in any folder, as older versions signed every folder with it.
 */
export function isDefaultDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const own = realPath(dataDir);
	const def = realPath(defaultDataDir(env));
	return process.platform === "win32" ? own.toLowerCase() === def.toLowerCase() : own === def;
}

/** What every signed text starts with, so the key signs nothing else by accident. */
export const MAC_DOMAIN = "gentle-dot/connectors.json/v1\n";

const KEY_HEX = /^[0-9a-f]{64}$/;

/** A new signing key, as the hex text the app's store keeps. */
export function newIntegrityKey(): string {
	return randomBytes(32).toString("hex");
}

/** The key's bytes, or undefined when the stored text is not a key this daemon made. */
export function parseIntegrityKey(text: string | undefined): Buffer | undefined {
	return text !== undefined && KEY_HEX.test(text) ? Buffer.from(text, "hex") : undefined;
}

/** `value` as canonical JSON (see the module comment). */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** The MAC of a record (its own `mac` field, if any, is left out). */
export function recordMac(key: Buffer, record: Record<string, unknown>): string {
	const { mac: _mac, ...rest } = record;
	return createHmac("sha256", key).update(MAC_DOMAIN).update(canonicalJson(rest)).digest("hex");
}

/** True when `record.mac` is the MAC of the rest under `key`; compared in constant time. */
export function macMatches(key: Buffer, record: Record<string, unknown>): boolean {
	const { mac } = record;
	if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
	return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(recordMac(key, record), "hex"));
}
