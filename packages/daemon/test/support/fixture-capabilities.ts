// Test fixtures whose POSIX mechanism does not port to Windows, and the portable substitutes.
//
// Two things a fixture needs on POSIX behave differently on Windows, and each substitute is
// measured rather than assumed (odd/tasks/windows-port.md):
//
// - A **directory link**. `symlinkSync(dir, link)` needs `SeCreateSymbolicLinkPrivilege` on a plain
//   Windows install (it fails with `EPERM` unless Developer Mode is on). A **junction** needs no
//   privilege: `symlinkSync(dir, link, "junction")` succeeds and `lstatSync(link).isSymbolicLink()`
//   is `true`. A file symlink has no unprivileged substitute, because junctions are directory-only
//   and a hardlink is not a symlink, so file-symlink fixtures are not covered here.
// - An **unwritable directory**. Clearing a directory's write bit is how a POSIX test simulates a
//   folder the code cannot write to. Windows honours the write, so the fixture's failure path is
//   never taken there and the test asserts nothing. An ACL does not help either: `icacls <dir>
//   /deny` in three forms still allowed the write, because a process at High Mandatory Level with
//   `SeBackupPrivilege` and `SeRestorePrivilege` enabled bypasses the DACL. The capability is
//   therefore probed, never assumed, and the fixture skips loudly where it is absent.
//
// Like `posix-modes.ts`, a skip announces itself: a green run must not quietly assert nothing. It
// writes to the raw stderr stream rather than `console.warn`, because vitest's default reporter
// hides console output from a test that ends up skipped, so a plain `pnpm test` would show `3
// skipped` with no reason at all. The write is emitted per call, not once per process, so a second
// fixture in the same file cannot go silent behind the first (W18).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The link type a directory link needs: Windows does junctions without a privilege. */
export function directoryLinkType(platform: NodeJS.Platform = process.platform): "junction" | "dir" {
	return platform === "win32" ? "junction" : "dir";
}

/** `symlinkSync` for a directory target, portable: a junction on Windows, a directory link elsewhere. */
export function symlinkDirectory(target: string, path: string): void {
	symlinkSync(target, path, directoryLinkType());
}

let probed: boolean | undefined;

/** Creates a directory, clears its write bit, and reports whether a write inside it was refused. */
function probeUnwritableDirectory(): boolean {
	const scratch = mkdtempSync(join(tmpdir(), "gentle-dot-fixture-capability-"));
	const folder = join(scratch, "unwritable");
	try {
		mkdirSync(folder);
		chmodSync(folder, 0o555);
		try {
			writeFileSync(join(folder, "probe"), "probe");
			return false;
		} catch {
			return true;
		} finally {
			chmodSync(folder, 0o755);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function warnSkipped(label: string): void {
	// Raw stderr, not `console.warn`: vitest's default reporter drops console output from a skipped
	// test, so this is the only channel a plain `pnpm test` shows.
	process.stderr.write(
		`fixture-capabilities: skipping ${label}; a write inside a write-bit-cleared directory still ` +
			"succeeded on this host, so the unwritable-folder fixture would test nothing " +
			"(see odd/tasks/windows-port.md).\n",
	);
}

/**
 * Whether clearing the write bit actually stops a write on this host, probed once and cached.
 * When it does not, warns once per call naming `label` and the measured reason, then answers false.
 */
export function canMakeDirectoryUnwritable(label: string): boolean {
	probed ??= probeUnwritableDirectory();
	if (!probed) warnSkipped(label);
	return probed;
}
