/**
 * Prepared companion packages for a fresh engine home (S17, odd/tasks/windows-support.md T8e2-B2).
 *
 * gentle-shell installs its companion packages (gentle-engram, the MCP adapter, web access, btw)
 * into a new home on its first run, by downloading the latest gentle-pi and, on Windows, building
 * Gentle AI from source with Go. An installed app cannot rely on that: the user may have no Go or
 * git, and the latest gentle-pi need not match the bundled one. The installer instead carries a
 * home that a real `gentle-shell --home <dir> setup` prepared at staging time
 * (`<runtime>/companions/agent-home`, with `manifest.json` naming the gentle-pi and Gentle AI
 * versions it was made with). Before the engine's first start, this copies it into the assistant's
 * own fresh home and records the home as provisioned in gentle-shell's own config, the record
 * gentle-shell reads to skip its first-run setup (`provisioned[realpath(home)]`, gentle-pi
 * `runtime/gentle-shell-launcher.mjs` `needsProvisioning`).
 *
 * It never touches a home that gentle-shell already set up or provisioned, a home the user chose,
 * or another engine's; it refuses companions made for another gentle-pi or Gentle AI, a template
 * with links, and any file the home already has. Anything it refuses leaves gentle-shell's own
 * first-run setup to run as before, with its own messages. Without packaged companions (a source
 * checkout, macOS and Linux today) it does nothing and logs nothing.
 */
import { randomBytes } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { directAccess, type EngineAccess } from "./engine-access.ts";
import { ENGINE_HOME_MARKER } from "./isolation.ts";
import { runtimeDir } from "./runtime.ts";

export interface CompanionsInput {
	/** `<runtime>/companions`; undefined without an installed runtime. */
	companions: string | undefined;
	/** The engine launcher that will run (`gentle-pi/bin/gentle-shell.mjs`); undefined for another engine. */
	gentleShell: string | undefined;
	dataDir: string;
	agentHome: string;
	/** The engine's HOME (`<dataDir>/home`), where gentle-shell keeps `.gentle-shell/config.json`. */
	engineHome: string;
	log: (line: string) => void;
	access?: EngineAccess;
}

export type CompanionsOutcome = { materialized: true } | { materialized: false; reason: string };

interface Versions {
	gentlePi: string;
	gentleAi: string;
}

/** Entries only gentle-shell's first-run setup creates in a home: either one means it was set up. */
const SET_UP = ["settings.json", "npm"];
const NOTHING = "no packaged companions";

/** The installed app's packaged companions, `<runtime>/companions`. */
export function packagedCompanions(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const runtime = runtimeDir(env);
	return runtime ? join(runtime, "companions") : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function entry(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

function readManifest(path: string): Versions | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(value) || value.schema !== 1) return undefined;
		const { gentlePi, gentleAi } = value;
		return typeof gentlePi === "string" && typeof gentleAi === "string" ? { gentlePi, gentleAi } : undefined;
	} catch {
		return undefined;
	}
}

/** The versions gentle-shell itself checks: its own package's, and its pinned Gentle AI. */
async function bundledVersions(gentleShell: string): Promise<Versions | undefined> {
	const root = dirname(dirname(gentleShell));
	try {
		const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
		const binary = await import(pathToFileURL(join(root, "runtime", "gentle-ai-binary.mjs")).href);
		const pin: unknown = binary.GENTLE_AI_VERSION;
		return typeof version === "string" && typeof pin === "string"
			? { gentlePi: version, gentleAi: pin }
			: undefined;
	} catch {
		return undefined;
	}
}

/** Every entry under `dir`, parents before children, relative with `/`; links are not followed. */
function walk(dir: string, prefix = ""): { rel: string; stat: Stats }[] {
	const found: { rel: string; stat: Stats }[] = [];
	for (const name of readdirSync(dir).sort()) {
		const rel = prefix ? `${prefix}/${name}` : name;
		const stat = lstatSync(join(dir, name));
		found.push({ rel, stat });
		if (stat.isDirectory()) found.push(...walk(join(dir, name), rel));
	}
	return found;
}

/** A new file next to `path`, created exclusively, then renamed over it. */
function writeAtomically(path: string, text: string): void {
	const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
	try {
		renameSync(temp, path);
	} catch (error) {
		unlinkSync(temp);
		throw error;
	}
}

export async function materializeCompanions(input: CompanionsInput): Promise<CompanionsOutcome> {
	const { companions, log } = input;
	const skip = (reason: string): CompanionsOutcome => {
		if (reason !== NOTHING) log(`companions: not used: ${reason}`);
		return { materialized: false, reason };
	};
	const template = companions ? join(companions, "agent-home") : undefined;
	if (
		!companions ||
		!template ||
		!entry(template)?.isDirectory() ||
		!existsSync(join(companions, "manifest.json"))
	)
		return skip(NOTHING);
	if (!input.gentleShell || basename(input.gentleShell) !== "gentle-shell.mjs")
		return skip("the engine is not the bundled gentle-shell");
	if (resolve(input.agentHome) !== resolve(input.dataDir, "agent"))
		return skip("the engine home is not the assistant's own");
	const manifest = readManifest(join(companions, "manifest.json"));
	if (!manifest) return skip("the packaged companions manifest is invalid");
	const bundled = await bundledVersions(input.gentleShell);
	if (!bundled) return skip("the bundled gentle-shell's versions are unreadable");
	if (manifest.gentlePi !== bundled.gentlePi || manifest.gentleAi !== bundled.gentleAi)
		return skip(
			`the packaged companions are for gentle-pi ${manifest.gentlePi} and Gentle AI ${manifest.gentleAi}, ` +
				`not ${bundled.gentlePi} and ${bundled.gentleAi}`,
		);
	const access = input.access ?? directAccess;
	return access(() => prepare(input, template, bundled, skip));
}

function prepare(
	input: CompanionsInput,
	template: string,
	versions: Versions,
	skip: (reason: string) => CompanionsOutcome,
): CompanionsOutcome {
	const { agentHome, log } = input;
	const configPath = join(input.engineHome, ".gentle-shell", "config.json");
	let config: Record<string, unknown> = {};
	if (entry(configPath)) {
		try {
			const value = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
			if (!isRecord(value)) return skip("gentle-shell's config is unreadable");
			config = value;
		} catch {
			return skip("gentle-shell's config is unreadable");
		}
	}
	mkdirSync(agentHome, { recursive: true, mode: 0o700 });
	// gentle-shell keys the record by the home's realpath (bin/gentle-shell.mjs safeRealpath).
	const home = realpathSync(agentHome);
	const provisioned = isRecord(config.provisioned) ? config.provisioned : {};
	if (Object.hasOwn(provisioned, home)) return skip("the engine home is already provisioned");
	if (SET_UP.some((name) => entry(join(agentHome, name)))) return skip("the engine home is already set up");

	// Check everything before the first copy, so a refusal leaves the home as it was.
	const entries = walk(template);
	const preserved = new Set<string>();
	for (const { rel, stat } of entries) {
		if (stat.isSymbolicLink()) return skip(`the packaged companions contain a link: ${rel}`);
		if (!stat.isFile() && !stat.isDirectory())
			return skip(`the packaged companions contain something that is not a file or folder: ${rel}`);
		const there = entry(join(agentHome, rel));
		// Real setup templates include this ownership marker too. claimEngineHome already wrote
		// the destination's marker; preserve it, but never exempt a link or another entry type.
		if (rel === ENGINE_HOME_MARKER && stat.isFile() && there?.isFile()) {
			preserved.add(rel);
			continue;
		}
		if (there && !(stat.isDirectory() && there.isDirectory()))
			return skip(`the engine home already has ${rel}`);
	}
	try {
		for (const { rel, stat } of entries) {
			if (preserved.has(rel)) continue;
			const target = join(agentHome, rel);
			if (stat.isDirectory()) mkdirSync(target, { recursive: true, mode: 0o700 });
			else copyFileSync(join(template, rel), target, constants.COPYFILE_EXCL);
		}
	} catch (error) {
		// No record: gentle-shell's own first-run setup still runs.
		return skip(`could not copy the packaged companions: ${(error as Error).message}`);
	}
	const at = new Date().toISOString();
	const record = { ...config, provisioned: { ...provisioned, [home]: { ...versions, at } } };
	try {
		mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
		writeAtomically(configPath, `${JSON.stringify(record, null, "\t")}\n`);
	} catch (error) {
		return skip(`could not record the prepared home: ${(error as Error).message}`);
	}
	log(
		`companions: prepared the engine home from the packaged companions (gentle-pi ${versions.gentlePi}, Gentle AI ${versions.gentleAi})`,
	);
	return { materialized: true };
}
