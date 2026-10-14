// A4/D5: who listens on the private memory port. On Windows the answer comes from `netstat`, parsed
// exactly into a tri-state: no listener, one owner, or unknown (never managed, never killed).
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { listeningPid, parseNetstatListeners } from "../src/isolation.ts";

const HEADER = [
	"",
	"Active Connections",
	"",
	"  Proto  Local Address          Foreign Address        State           PID",
].join("\r\n");

const table = (...rows: string[]) => [HEADER, ...rows, ""].join("\r\n");

describe("parseNetstatListeners", () => {
	it("finds the one pid listening on an IPv4 address", () => {
		const out = table(
			"  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1148",
			"  TCP    127.0.0.1:7438         0.0.0.0:0              LISTENING       4242",
		);
		expect(parseNetstatListeners(out, "7438")).toEqual({ state: "one", pid: 4242 });
	});

	it("finds the one pid listening on all IPv4 interfaces", () => {
		const out = table("  TCP    0.0.0.0:7438           0.0.0.0:0              LISTENING       4242");
		expect(parseNetstatListeners(out, "7438")).toEqual({ state: "one", pid: 4242 });
	});

	it("finds the one pid listening on IPv6 loopback and on all IPv6 interfaces", () => {
		const loopback = table("  TCP    [::1]:7438             [::]:0                 LISTENING       77");
		const all = table("  TCP    [::]:7438              [::]:0                 LISTENING       77");
		expect(parseNetstatListeners(loopback, "7438")).toEqual({ state: "one", pid: 77 });
		expect(parseNetstatListeners(all, "7438")).toEqual({ state: "one", pid: 77 });
	});

	it("recognizes a listening socket by its unconnected foreign address, not by the state text", () => {
		const out = table("  TCP    127.0.0.1:7438         0.0.0.0:0              ESCUCHANDO      4242");
		expect(parseNetstatListeners(out, "7438")).toEqual({ state: "one", pid: 4242 });
	});

	it("ignores connected rows, including ones whose remote port is the target port", () => {
		const out = table(
			"  TCP    127.0.0.1:7438         127.0.0.1:50000        ESTABLISHED     4242",
			"  TCP    127.0.0.1:50000        127.0.0.1:7438         ESTABLISHED     999",
			"  TCP    127.0.0.1:7438         127.0.0.1:50001        TIME_WAIT       0",
			"  TCP    [::1]:49700            [::1]:7438             TIME_WAIT       0",
		);
		expect(parseNetstatListeners(out, "7438")).toEqual({ state: "absent" });
	});

	it("matches the port exactly, not as a prefix or a suffix", () => {
		const out = table(
			"  TCP    127.0.0.1:74380        0.0.0.0:0              LISTENING       1",
			"  TCP    0.0.0.0:17438          0.0.0.0:0              LISTENING       2",
			"  TCP    [::]:743               [::]:0                 LISTENING       3",
			"  TCP    [::1]:74380            [::]:0                 LISTENING       4",
		);
		expect(parseNetstatListeners(out, "7438")).toEqual({ state: "absent" });
	});

	it("does not count a listener on a prefix or superset port, alone or beside the real one", () => {
		const prefix = "  TCP    127.0.0.1:74380        0.0.0.0:0              LISTENING       1";
		const superset = "  TCP    0.0.0.0:17438          0.0.0.0:0              LISTENING       2";
		const real = "  TCP    127.0.0.1:7438         0.0.0.0:0              LISTENING       3";
		expect(parseNetstatListeners(table(prefix), "7438")).toEqual({ state: "absent" });
		expect(parseNetstatListeners(table(superset), "7438")).toEqual({ state: "absent" });
		expect(parseNetstatListeners(table(prefix, superset, real), "7438")).toEqual({ state: "one", pid: 3 });
	});

	it("is unknown when two distinct pids listen on the port across IPv4 and IPv6", () => {
		const out = table(
			"  TCP    0.0.0.0:7438           0.0.0.0:0              LISTENING       10",
			"  TCP    [::]:7438              [::]:0                 LISTENING       20",
		);
		expect(parseNetstatListeners(out, "7438")).toEqual({ state: "unknown" });
	});

	it("ignores UDP rows, which have no foreign address column", () => {
		const out = table(
			"  UDP    0.0.0.0:7438           *:*                                    5",
			"  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1148",
		);
		expect(parseNetstatListeners(out, "7438")).toEqual({ state: "absent" });
	});

	it("is unknown when several distinct pids listen on the port", () => {
		const out = table(
			"  TCP    127.0.0.1:7438         0.0.0.0:0              LISTENING       10",
			"  TCP    [::1]:7438             [::]:0                 LISTENING       20",
		);
		expect(parseNetstatListeners(out, "7438")).toEqual({ state: "unknown" });
	});

	it("is one pid when the same pid listens twice", () => {
		const out = table(
			"  TCP    127.0.0.1:7438         0.0.0.0:0              LISTENING       10",
			"  TCP    [::1]:7438             [::]:0                 LISTENING       10",
		);
		expect(parseNetstatListeners(out, "7438")).toEqual({ state: "one", pid: 10 });
	});

	it("is absent for empty output", () => {
		expect(parseNetstatListeners("", "7438")).toEqual({ state: "absent" });
		expect(parseNetstatListeners("\r\n  \r\n", "7438")).toEqual({ state: "absent" });
	});

	it("is unknown for output that is not a connection table", () => {
		expect(parseNetstatListeners("this is not netstat output", "7438")).toEqual({ state: "unknown" });
		expect(parseNetstatListeners(table(), "7438")).toEqual({ state: "unknown" });
	});

	it("is unknown when a TCP row is malformed or its listening pid is not a number", () => {
		expect(parseNetstatListeners(table("  TCP    garbage"), "7438")).toEqual({ state: "unknown" });
		const noPid = table("  TCP    127.0.0.1:7438         0.0.0.0:0              LISTENING       x");
		expect(parseNetstatListeners(noPid, "7438")).toEqual({ state: "unknown" });
		const zero = table("  TCP    127.0.0.1:7438         0.0.0.0:0              LISTENING       0");
		expect(parseNetstatListeners(zero, "7438")).toEqual({ state: "unknown" });
	});

	it("is unknown for a target that is not a port number", () => {
		const out = table("  TCP    127.0.0.1:7438         0.0.0.0:0              LISTENING       4242");
		expect(parseNetstatListeners(out, "")).toEqual({ state: "unknown" });
		expect(parseNetstatListeners(out, "74x8")).toEqual({ state: "unknown" });
	});
});

describe("listeningPid on Windows", () => {
	it.runIf(process.platform === "win32")(
		"sees this process as the one owner, then nobody once closed",
		async () => {
			const server = createServer();
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const { port } = server.address() as { port: number };
			try {
				expect(await listeningPid(String(port))).toEqual({ state: "one", pid: process.pid });
			} finally {
				await new Promise((resolve) => server.close(resolve));
			}
			expect(await listeningPid(String(port))).toEqual({ state: "absent" });
		},
	);
});
