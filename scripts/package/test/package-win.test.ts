import { describe, expect, it } from "vitest";
import {
	goMeetsMinimum,
	MIN_GO_VERSION,
	manifestFromPe,
	nsisFileName,
	parseEnvironment,
	parseWinArgs,
	tauriReleaseConfig,
	tauriWindowsReleaseConfig,
	usesCommonControls6,
	vcvars64Path,
	WIN_USAGE,
	WINDOWS_GO_REQUIRED,
} from "../lib.mjs";

describe("parseWinArgs", () => {
	it("stages by default and reuses the staged runtime with --skip-stage", () => {
		expect(parseWinArgs([])).toEqual({ skipStage: false });
		expect(parseWinArgs(["--", "--skip-stage"])).toEqual({ skipStage: true });
	});

	it("refuses anything else with the usage", () => {
		expect(() => parseWinArgs(["--sign", "x"])).toThrow(`Unexpected argument --sign.\n${WIN_USAGE}`);
		expect(() => parseWinArgs(["--check"])).toThrow(/Unexpected argument --check/);
	});
});

describe("Go prerequisite", () => {
	it("says why staging needs Go, in stage-runtime's words", () => {
		expect(WINDOWS_GO_REQUIRED).toBe(
			"Staging win32-x64 needs Go 1.25.10 or newer on PATH: gentle-pi builds its Gentle AI binary from source on Windows.",
		);
		expect(MIN_GO_VERSION).toBe("1.25.10");
	});

	it("accepts the minimum and newer releases and refuses older or unreadable ones", () => {
		expect(goMeetsMinimum("go version go1.25.10 windows/amd64")).toBe(true);
		expect(goMeetsMinimum("go version go1.26.0 windows/amd64")).toBe(true);
		expect(goMeetsMinimum("go version go1.26 windows/amd64")).toBe(true);
		expect(goMeetsMinimum("go version go2.0.1 windows/amd64")).toBe(true);
		expect(goMeetsMinimum("go version go1.25.9 windows/amd64")).toBe(false);
		expect(goMeetsMinimum("go version go1.24.12 windows/amd64")).toBe(false);
		expect(goMeetsMinimum("go version devel +abc windows/amd64")).toBe(false);
		expect(goMeetsMinimum("")).toBe(false);
	});
});

describe("tauri release config", () => {
	it("keeps the macOS config byte for byte", () => {
		expect(
			JSON.stringify(tauriReleaseConfig({ runtime: "/repo/build/runtime/darwin-arm64", identity: "-" })),
		).toBe(
			'{"bundle":{"resources":{"/repo/build/runtime/darwin-arm64":"runtime"},"macOS":{"signingIdentity":"-"}}}',
		);
	});

	it("maps the runtime, keeps the bundler's tools in the target folder, and installs per user", () => {
		const runtime = "C:\\repo\\build\\runtime\\win32-x64";
		expect(tauriWindowsReleaseConfig({ runtime })).toEqual({
			bundle: {
				resources: { [runtime]: "runtime" },
				useLocalToolsDir: true,
				windows: { nsis: { installMode: "currentUser" } },
			},
		});
	});

	it("names the NSIS installer the way Tauri does", () => {
		expect(nsisFileName("Gentle Dot", "0.1.0", "x64")).toBe("Gentle Dot_0.1.0_x64-setup.exe");
		expect(() => nsisFileName("Gentle Dot", "0.1.0", "arm64")).toThrow(/arm64/);
	});
});

describe("MSVC environment", () => {
	it("finds vcvars64.bat in a Visual Studio installation", () => {
		expect(vcvars64Path("C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools")).toBe(
			"C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat",
		);
	});

	it("reads `set` output, keeping values with = and skipping cmd's drive entries and noise", () => {
		const output = [
			"**********************************************************************",
			"=C:=C:\\repo",
			"INCLUDE=C:\\VC\\include;C:\\Kits\\ucrt",
			"Path=C:\\VC\\bin;C:\\Windows\\System32",
			"WEIRD=a=b",
			"",
		].join("\r\n");
		expect(parseEnvironment(output)).toEqual({
			INCLUDE: "C:\\VC\\include;C:\\Kits\\ucrt",
			Path: "C:\\VC\\bin;C:\\Windows\\System32",
			WEIRD: "a=b",
		});
	});
});

const COMCTL6 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>`;

/** A minimal PE32+ file whose one section, `.rsrc`, holds `manifest` as RT_MANIFEST 1, language 1033. */
function peWithManifest(manifest: string | undefined): Buffer {
	const sectionRva = 0x1000;
	const rawOffset = 0x200;
	const rsrc = Buffer.alloc(0x400);
	const directory = (at: number, idEntries: number) => rsrc.writeUInt16LE(idEntries, at + 14);
	const entry = (at: number, id: number, offset: number, subdirectory: boolean) => {
		rsrc.writeUInt32LE(id, at);
		rsrc.writeUInt32LE(((subdirectory ? 0x80000000 : 0) | offset) >>> 0, at + 4);
	};
	const body = Buffer.from(manifest ?? "", "utf8");
	if (manifest !== undefined) {
		directory(0x00, 2);
		entry(0x10, 3, 0x60, true); // RT_ICON, an empty directory
		entry(0x18, 24, 0x20, true); // RT_MANIFEST
		directory(0x20, 1);
		entry(0x30, 1, 0x38, true);
		directory(0x38, 1);
		entry(0x48, 1033, 0x50, false);
		rsrc.writeUInt32LE(sectionRva + 0x80, 0x50);
		rsrc.writeUInt32LE(body.length, 0x54);
		body.copy(rsrc, 0x80);
	}
	const file = Buffer.alloc(rawOffset + rsrc.length);
	file.write("MZ", 0, "latin1");
	const pe = 0x40;
	file.writeUInt32LE(pe, 0x3c);
	file.write("PE\0\0", pe, "latin1");
	const coff = pe + 4;
	file.writeUInt16LE(0x8664, coff);
	file.writeUInt16LE(1, coff + 2);
	const optionalSize = 240;
	file.writeUInt16LE(optionalSize, coff + 16);
	const optional = coff + 20;
	file.writeUInt16LE(0x20b, optional);
	file.writeUInt32LE(16, optional + 108);
	file.writeUInt32LE(sectionRva, optional + 112 + 2 * 8);
	file.writeUInt32LE(rsrc.length, optional + 112 + 2 * 8 + 4);
	const section = optional + optionalSize;
	file.write(".rsrc", section, "latin1");
	file.writeUInt32LE(rsrc.length, section + 8);
	file.writeUInt32LE(sectionRva, section + 12);
	file.writeUInt32LE(rsrc.length, section + 16);
	file.writeUInt32LE(rawOffset, section + 20);
	rsrc.copy(file, rawOffset);
	return file;
}

describe("embedded manifest", () => {
	it("reads the RT_MANIFEST resource of a PE file", () => {
		expect(manifestFromPe(peWithManifest(COMCTL6))).toBe(COMCTL6);
	});

	it("finds no manifest in a file without one or in a file that is not PE", () => {
		expect(manifestFromPe(peWithManifest(undefined))).toBeUndefined();
		expect(manifestFromPe(Buffer.from("#!/bin/sh\n"))).toBeUndefined();
		expect(manifestFromPe(Buffer.alloc(0))).toBeUndefined();
	});

	it("recognizes the Common Controls 6 dependency and nothing weaker", () => {
		expect(usesCommonControls6(COMCTL6)).toBe(true);
		expect(usesCommonControls6(COMCTL6.replace("6.0.0.0", "5.82.0.0"))).toBe(false);
		expect(usesCommonControls6(COMCTL6.replace("Common-Controls", "GdiPlus"))).toBe(false);
		expect(usesCommonControls6('<assembly xmlns="urn:schemas-microsoft-com:asm.v1"/>')).toBe(false);
	});
});

describe("verifier regressions", () => {
	it("refuses Go pre-releases and odd argument spellings", () => {
		expect(goMeetsMinimum("go version go1.25.10rc1 windows/amd64")).toBe(false);
		expect(goMeetsMinimum("go version go1.25 windows/amd64")).toBe(false);
		expect(parseWinArgs(["--skip-stage", "--skip-stage"])).toEqual({ skipStage: true });
		expect(() => parseWinArgs(["--skip-stage=1"])).toThrow(/Unexpected argument --skip-stage=1/);
		expect(() => parseWinArgs([""])).toThrow(/Unexpected argument/);
	});

	it("never throws on truncated or corrupted PE input", () => {
		const good = peWithManifest(COMCTL6);
		for (let length = 0; length <= good.length; length += 7)
			expect(() => manifestFromPe(Buffer.from(good.subarray(0, length)))).not.toThrow();
		const bad = Buffer.from(good);
		bad.writeUInt32LE(0xffffffff, 0x3c);
		expect(manifestFromPe(bad)).toBeUndefined();
	});

	it("adds no Windows option to the macOS config", () => {
		const mac = tauriReleaseConfig({ runtime: "/r", identity: "-" });
		expect(JSON.stringify(mac)).not.toMatch(/useLocalToolsDir|nsis|installMode/);
	});
});
