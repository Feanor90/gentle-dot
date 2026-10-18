import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { tempDir } from "./helpers.ts";

const project = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = join(project, ".vitest", "t12-checks", "tmp");

function ensureFixtureRoot(): void {
	let path = project;
	for (const part of [".vitest", "t12-checks", "tmp"]) {
		path = join(path, part);
		if (!existsSync(path)) mkdirSync(path);
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() || !entry.isDirectory())
			throw new Error("Privacy fixture root must contain only real directories.");
	}
}

/** ACL operations are restricted to real, freshly generated project test folders. */
function fixturePath(path: string): string {
	const absolute = resolve(path);
	const child = relative(realpathSync(scratch), realpathSync(absolute));
	if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`))
		throw new Error("Privacy checks require a generated T12 fixture path.");
	const parts = child.split(sep);
	if (!parts[0]?.startsWith("gentle-dot-test-")) throw new Error("Not a generated test folder.");
	for (let i = 1; i <= parts.length; i++) {
		if (lstatSync(join(scratch, ...parts.slice(0, i))).isSymbolicLink())
			throw new Error("Privacy fixtures must not contain links.");
	}
	return absolute;
}

function powershell(path: string, script: string): string {
	return execFileSync(
		join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(
				`$ErrorActionPreference = 'Stop'; $path = '${fixturePath(path).replaceAll("'", "''")}'; ${script}`,
				"utf16le",
			).toString("base64"),
		],
		{ encoding: "utf8", windowsHide: true, timeout: 5000 },
	);
}

/** Model the desktop's protected OICI owner-only parent before plain Node creates children. */
export function privateTempDir(): string {
	if (process.platform !== "win32") return tempDir();
	ensureFixtureRoot();
	const parent = mkdtempSync(join(scratch, "gentle-dot-test-"));
	const path = join(parent, "private");
	// Set the descriptor at creation, not via an existing-folder WRITE_OWNER operation.
	powershell(
		parent,
		`
			$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;
			$acl = [System.Security.AccessControl.DirectorySecurity]::new();
			$acl.SetOwner($sid);
			$acl.SetAccessRuleProtection($true, $false);
			$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow');
			$acl.AddAccessRule($rule);
			[void][System.IO.Directory]::CreateDirectory([System.IO.Path]::Combine($path, 'private'), $acl);
		`,
	);
	expectPrivatePath(path, 0o700, false);
	return path;
}

/** Unix exact modes; Windows exact owner, sole full-access ACE, and inheritance readback. */
export function expectPrivatePath(path: string, mode: 0o600 | 0o700, inherited = true): void {
	if (process.platform !== "win32") {
		expect(statSync(path).mode & 0o777).toBe(mode);
		return;
	}
	// Use .NET directly: inherited PSModulePath can prevent Security cmdlet autoloading.
	const result = powershell(
		path,
		`
		$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
		$acl = [System.IO.${mode === 0o700 ? "Directory" : "File"}]::GetAccessControl($path);
		if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Wrong owner'; }
		if ($acl.AreAccessRulesProtected -ne $${!inherited}) { throw 'Wrong DACL protection'; }
		$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]);
		if ($rules.Count -ne 1) { throw 'Expected exactly one access rule'; }
		$rule = $rules[0];
		if ($rule.IdentityReference.Value -ne $sid -or [int]$rule.FileSystemRights -ne 0x1f01ff -or
		    [int]$rule.AccessControlType -ne 0 -or $rule.IsInherited -ne $${inherited} -or
		    [int]$rule.InheritanceFlags -ne ${mode === 0o700 ? 3 : 0} -or [int]$rule.PropagationFlags -ne 0) {
			throw 'Expected owner-only full access with exact inheritance';
		}
		[Console]::Write('private');
		`,
	);
	expect(result).toBe("private");
}
