import { afterEach, expect, it, vi } from "vitest";
import { startupTrace } from "../src/startup-trace.ts";

afterEach(() => vi.restoreAllMocks());

it("emits only static metadata with a timestamp and request id", () => {
	vi.spyOn(Date, "now").mockReturnValue(123);
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	startupTrace("dot", 2, "connection-failed");
	expect(info.mock.calls).toEqual([
		['[startup-trace] {"request":2,"step":"connection-failed","surface":"dot","time_ms":123}'],
	]);
});

it("does not let an unavailable console change startup behavior", () => {
	vi.spyOn(console, "info").mockImplementation(() => {
		throw new Error("console unavailable");
	});
	expect(() => startupTrace("panel", 0, "listener-registered")).not.toThrow();
});
