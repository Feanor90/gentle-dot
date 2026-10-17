import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOWS_INSTALLER_HOOKS } from "../lib.mjs";

const compiler = resolve("apps/desktop/src-tauri/target/.tauri/NSIS/makensis.exe");
// These probes execute the production hook, without installing an app or touching user state.
// Process shutdown is covered by installed acceptance, not by these no-process fixtures.
describe.skipIf(process.platform !== "win32" || !existsSync(compiler))("NSIS runtime cleanup", () => {
	function probe(
		kind: "nested" | "root" | "special" | "unguarded" | "unmarked" | "locked",
		hook: "PREINSTALL" | "PREUNINSTALL",
	) {
		const scratch = mkdtempSync(resolve(".windows-hooks-test-"));
		try {
			const name = kind === "special" ? "%T8E2_EXPAND% & bang! ^ (case)" : "installed";
			const installed = join(scratch, name);
			const outside = join(scratch, "outside");
			mkdirSync(installed);
			mkdirSync(outside);
			writeFileSync(join(outside, "canary.txt"), "must survive");
			const runtime = join(installed, "runtime");
			if (kind === "root") symlinkSync(outside, runtime, "junction");
			else mkdirSync(runtime);
			if (kind !== "unmarked") writeFileSync(join(runtime, "MANIFEST.json"), "{}");
			writeFileSync(join(runtime, "stale.js"), "old module");
			writeFileSync(join(installed, "keep.txt"), "outside runtime");
			if (kind !== "unguarded") writeFileSync(join(installed, "gentle-dot.exe"), "fixture");
			if (kind === "nested") symlinkSync(outside, join(runtime, "linked"), "junction");
			const exe = join(scratch, "probe.exe");
			const source = join(scratch, "probe.nsi");
			writeFileSync(
				source,
				`Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${exe}"
!include "LogicLib.nsh"
!define MAINBINARYNAME "gentle-dot"
!define PRODUCTNAME "Gentle Dot probe"
!macro CheckIfAppIsRunning executablePath productName
!macroend
!include "${WINDOWS_INSTALLER_HOOKS}"
Section
ReadEnvStr $INSTDIR "GENTLE_DOT_TEST_INSTALL"
${
	kind === "locked"
		? `System::Call 'kernel32::CreateFileW(w "$INSTDIR\\runtime\\stale.js", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p .r9'
\${If} $9 P= -1
SetErrorLevel 3
Quit
\${EndIf}`
		: ""
}
!insertmacro NSIS_HOOK_${hook}
FileOpen $1 "$INSTDIR\\continued.txt" w
FileWrite $1 "continued"
FileClose $1
SetErrorLevel 0
SectionEnd
`,
			);
			const compiled = spawnSync(compiler, ["/V2", source], { encoding: "utf8", timeout: 15_000 });
			expect(compiled.error).toBeUndefined();
			expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
			const result = spawnSync(exe, ["/S"], {
				encoding: "utf8",
				timeout: 15_000,
				env: { ...process.env, GENTLE_DOT_TEST_INSTALL: installed, T8E2_EXPAND: "outside" },
			});
			expect(result.error).toBeUndefined();
			expect(result.status, result.stdout + result.stderr).toBe(kind === "locked" ? 2 : 0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			expect(readFileSync(join(outside, "canary.txt"), "utf8")).toBe("must survive");
			expect(readFileSync(join(installed, "keep.txt"), "utf8")).toBe("outside runtime");
			expect(existsSync(runtime)).toBe(kind === "unguarded" || kind === "unmarked" || kind === "locked");
			expect(existsSync(join(installed, "continued.txt"))).toBe(kind !== "locked");
			if (kind === "unmarked") {
				expect(existsSync(join(runtime, "MANIFEST.json"))).toBe(false);
				expect(readFileSync(join(runtime, "stale.js"), "utf8")).toBe("old module");
			}
			if (kind === "locked") expect(readFileSync(join(runtime, "stale.js"), "utf8")).toBe("old module");
			if (kind === "root" || kind === "unguarded") {
				const preserved = kind === "root" ? outside : runtime;
				expect(readFileSync(join(preserved, "MANIFEST.json"), "utf8")).toBe("{}");
				expect(readFileSync(join(preserved, "stale.js"), "utf8")).toBe("old module");
			}
		} finally {
			// Node removes junctions themselves, without traversing their targets.
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	for (const hook of ["PREINSTALL", "PREUNINSTALL"] as const) {
		for (const kind of ["nested", "root", "special", "unguarded", "unmarked", "locked"] as const) {
			it(`${hook}: ${kind} preserves cleanup boundaries`, () => probe(kind, hook));
		}
	}
});
