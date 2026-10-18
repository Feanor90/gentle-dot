import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionInfo } from "../src/client.ts";
import { type DotState, initialState } from "../src/store.ts";

/**
 * A window the app refused recovers without a reopen (S35.2): once the app reports its assistant
 * ready (`dot://assistant-ready`, after Restart assistant or a slow start), the panel and the Dot
 * ask again and connect. Through the mocked Tauri commands and desktop events.
 */
const h = vi.hoisted(() => ({
	connection: undefined as unknown as () => Promise<unknown>,
	invoke: vi.fn(),
	listeners: new Map<string, () => void>(),
	infos: [] as (ConnectionInfo | undefined)[],
	state: undefined as unknown as DotState,
	registration: undefined as Promise<void> | undefined,
	desktop: true,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.desktop,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async () => () => {},
}));

vi.mock("../src/desktop.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/desktop.ts")>()),
	onDesktopEvent: async (name: string, handler: () => void) => {
		h.listeners.set(name, handler);
		if (h.registration) await h.registration;
		return () => h.listeners.delete(name);
	},
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: (info: ConnectionInfo | undefined) => {
		h.infos.push(info);
		return { state: h.state, send: () => {}, dismiss: () => {}, dispatch: () => {} };
	},
}));

const REFUSAL =
	"Another Gentle Dot assistant is already running on port 4317. Stop it, then choose Restart assistant.";
const INFO: ConnectionInfo = { url: "ws://127.0.0.1:4317/ws", token: "abc" };

async function renderApp(search: string) {
	window.history.replaceState(null, "", `/${search}`);
	const { App } = await import("../src/App.tsx");
	return render(<App />);
}

const READY = "dot://assistant-ready";
const TIMEOUT = "the assistant did not answer on port 4317 (see daemon.log)";
const connectionCalls = () => h.invoke.mock.calls.filter(([c]) => c === "connection_info");

async function advance(ms: number) {
	await act(async () => vi.advanceTimersByTimeAsync(ms));
}

function traceRecords(calls: unknown[][]): { request: number; step: string }[] {
	return calls.flatMap(([line]) =>
		typeof line === "string" && line.startsWith("[startup-trace] ")
			? [JSON.parse(line.slice("[startup-trace] ".length))]
			: [],
	);
}

function traceSteps(calls: unknown[][]): string[] {
	return traceRecords(calls).map(({ step }) => step);
}

async function reportReady() {
	await waitFor(() => expect(h.listeners.has(READY)).toBe(true));
	await act(async () => h.listeners.get(READY)?.());
}

beforeEach(() => {
	h.desktop = true;
	h.listeners.clear();
	h.registration = undefined;
	h.infos = [];
	h.state = { ...initialState, connection: "closed", agentState: "idle" };
	h.connection = async () => {
		throw REFUSAL;
	};
	h.invoke = vi.fn(async (command: string) => {
		if (command === "connection_info") return h.connection();
		if (command === "computer_status") return { active: false };
		return null;
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	window.sessionStorage.clear();
	window.history.replaceState(null, "", "/");
});

describe("bounded desktop startup recovery", () => {
	it.each([TIMEOUT, new Error(TIMEOUT)])(
		"recovers from %s even when ready was emitted before listener registration",
		async (reason) => {
			vi.useFakeTimers();
			// An event emitted before mounting has no listener and cannot be replayed.
			h.listeners.get(READY)?.();
			h.connection = vi.fn().mockRejectedValueOnce(reason).mockResolvedValue(INFO);
			const view = await renderApp("?surface=panel");
			await act(async () => {});
			expect(screen.getByText(TIMEOUT)).toHaveAttribute("role", "status");
			expect(connectionCalls()).toHaveLength(1);
			await advance(999);
			expect(connectionCalls()).toHaveLength(1);
			await advance(1);
			expect(connectionCalls()).toHaveLength(2);
			expect(h.infos.at(-1)).toEqual(INFO);
			expect(screen.queryByText(TIMEOUT)).toBeNull();
			expect(screen.getByRole("textbox")).toBeInTheDocument();
			await advance(180_000);
			expect(connectionCalls()).toHaveLength(2);
			view.unmount();
		},
	);

	it.each([
		REFUSAL,
		"Could not secure the assistant folder.",
		"Folder adoption was declined.",
		"arbitrary rejection",
		`${TIMEOUT} extra`,
		`${TIMEOUT}\n`,
		`prefix ${TIMEOUT}`,
		"the assistant did not answer on port abc (see daemon.log)",
		undefined,
	])("does not automatically retry a non-readiness failure: %s", async (reason) => {
		vi.useFakeTimers();
		h.connection = async () => {
			throw reason;
		};
		const view = await renderApp("?surface=panel");
		await act(async () => {});
		const message =
			reason ?? "This page needs your access key. Open it from the Gentle Dot menu (Open in browser).";
		expect(screen.getByRole("status").textContent).toBe(message);
		await advance(180_000);
		expect(connectionCalls()).toHaveLength(1);
		expect(screen.getByRole("status").textContent).toBe(message);
		view.unmount();
	});

	it("keeps one deadline despite ready events, and a later event permits only a signaled attempt", async () => {
		vi.useFakeTimers();
		h.connection = async () => {
			await new Promise((resolve) => setTimeout(resolve, 20_000));
			throw TIMEOUT;
		};
		const view = await renderApp("?surface=panel");
		await advance(20_000);
		expect(screen.getByText(TIMEOUT)).toBeInTheDocument();
		await act(async () => h.listeners.get(READY)?.());
		expect(connectionCalls()).toHaveLength(2);
		await advance(160_000);
		// Attempts at 0, 20, 41, 62, 83, 104, 125, 146 seconds; no room for another 20 s wait.
		expect(connectionCalls()).toHaveLength(8);
		expect(screen.getByText(TIMEOUT)).toHaveAttribute("role", "status");
		await advance(180_000);
		expect(connectionCalls()).toHaveLength(8);
		await act(async () => h.listeners.get(READY)?.());
		expect(connectionCalls()).toHaveLength(9);
		await advance(200_000);
		expect(connectionCalls()).toHaveLength(9);
		expect(screen.getByText(TIMEOUT)).toBeInTheDocument();
		h.connection = async () => INFO;
		await act(async () => h.listeners.get(READY)?.());
		expect(connectionCalls()).toHaveLength(10);
		expect(screen.getByRole("textbox")).toBeInTheDocument();
		view.unmount();
	});

	it("does not start an automatic attempt after a delayed timer crosses the scheduling deadline", async () => {
		vi.useFakeTimers();
		h.connection = async () => {
			throw new Error(TIMEOUT);
		};
		const view = await renderApp("?surface=panel");
		await act(async () => {});
		// Simulate a suspended WebView whose queued timer runs much later.
		vi.spyOn(performance, "now").mockReturnValue(200_000);
		await advance(1000);
		expect(connectionCalls()).toHaveLength(1);
		expect(screen.getByText(TIMEOUT)).toBeInTheDocument();
		view.unmount();
	});

	it("a ready event replaces a scheduled retry and success clears further automatic work", async () => {
		vi.useFakeTimers();
		h.connection = async () => {
			throw TIMEOUT;
		};
		const view = await renderApp("?surface=panel");
		await act(async () => {});
		h.connection = async () => INFO;
		await act(async () => h.listeners.get(READY)?.());
		expect(connectionCalls()).toHaveLength(2);
		expect(screen.getByRole("textbox")).toBeInTheDocument();
		await advance(180_000);
		expect(connectionCalls()).toHaveLength(2);
		view.unmount();
	});

	it("clears a pending retry on unmount", async () => {
		vi.useFakeTimers();
		h.connection = async () => {
			throw TIMEOUT;
		};
		const view = await renderApp("?surface=panel");
		await act(async () => {});
		expect(screen.getByText(TIMEOUT)).toBeInTheDocument();
		view.unmount();
		const renders = h.infos.length;
		await advance(180_000);
		expect(connectionCalls()).toHaveLength(1);
		expect(h.infos).toHaveLength(renders);
	});

	it.each([false, true])(
		"keeps browser access-key handling free of desktop retries (token: %s)",
		async (token) => {
			vi.useFakeTimers();
			h.desktop = false;
			const view = await renderApp(token ? "#token=abc" : "");
			await act(async () => {});
			if (token) expect(screen.getByRole("textbox")).toBeInTheDocument();
			else expect(screen.getByRole("status")).toHaveTextContent("This page needs your access key.");
			await advance(180_000);
			expect(connectionCalls()).toHaveLength(0);
			expect(h.listeners.has(READY)).toBe(false);
			view.unmount();
		},
	);
});

describe("after the app refused its assistant (S35.2)", () => {
	it("the panel connects once the app reports the assistant ready", async () => {
		await renderApp("?surface=panel");
		expect(await screen.findByText(REFUSAL)).toHaveAttribute("role", "status");
		h.connection = async () => INFO;
		await reportReady();
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
		expect(screen.queryByText(REFUSAL)).toBeNull();
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});

	it("the Dot connects once the app reports the assistant ready", async () => {
		await renderApp("?surface=dot");
		await waitFor(() => expect(h.invoke.mock.calls.some(([c]) => c === "connection_info")).toBe(true));
		expect(h.infos.at(-1)).toBeUndefined();
		h.connection = async () => INFO;
		await reportReady();
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
	});

	it("traces listener readiness and each connection outcome without connection data or errors", async () => {
		const trace = vi.spyOn(console, "info").mockImplementation(() => {});
		await renderApp("?surface=panel");
		await screen.findByText(REFUSAL);
		h.connection = async () => INFO;
		await reportReady();
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
		const lines = trace.mock.calls
			.map((args) => args.join(" "))
			.filter((line) => line.startsWith("[startup-trace]"));
		expect(lines.map((line) => JSON.parse(line.slice("[startup-trace] ".length)).step)).toEqual([
			"listener-registering",
			"connection-start",
			"listener-registered",
			"connection-failed",
			"ready-received",
			"connection-start",
			"connection-succeeded",
		]);
		const records = lines.map((line) => JSON.parse(line.slice("[startup-trace] ".length)));
		expect(
			records.filter((entry) => entry.step.startsWith("connection-")).map((entry) => entry.request),
		).toEqual([1, 1, 2, 2]);
		for (const entry of records) {
			expect(entry.surface).toBe("panel");
			expect(entry.time_ms).toEqual(expect.any(Number));
			expect(Object.keys(entry).sort()).toEqual(["request", "step", "surface", "time_ms"]);
		}
		expect(lines.join("\n")).not.toContain(INFO.token);
		expect(lines.join("\n")).not.toContain(INFO.url);
		expect(lines.join("\n")).not.toContain(REFUSAL);
	});

	it("starts connecting before asynchronous listener registration completes", async () => {
		const trace = vi.spyOn(console, "info").mockImplementation(() => {});
		let registered!: () => void;
		h.registration = new Promise<void>((resolve) => {
			registered = resolve;
		});
		await renderApp("?surface=panel");
		await screen.findByText(REFUSAL);
		expect(traceSteps(trace.mock.calls)).toEqual([
			"listener-registering",
			"connection-start",
			"connection-failed",
		]);
		await act(async () => registered());
		expect(traceSteps(trace.mock.calls).at(-1)).toBe("listener-registered");
	});

	it.each(["success", "failure"] as const)(
		"coalesces ready events and discards the superseded %s before connecting again",
		async (outcome) => {
			const trace = vi.spyOn(console, "info").mockImplementation(() => {});
			let resolveFirst!: (info: ConnectionInfo) => void;
			let rejectFirst!: (reason: unknown) => void;
			h.connection = () =>
				new Promise<ConnectionInfo>((resolve, reject) => {
					resolveFirst = resolve;
					rejectFirst = reject;
				});
			await renderApp("?surface=panel");
			h.connection = async () => INFO;
			await reportReady();
			await reportReady();
			expect(h.invoke.mock.calls.filter(([c]) => c === "connection_info")).toHaveLength(1);
			const older = { url: "ws://127.0.0.1:9999/ws", token: "older-private-token" };
			await act(async () => {
				if (outcome === "success") resolveFirst(older);
				else rejectFirst(new Error(REFUSAL));
			});
			await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
			expect(h.invoke.mock.calls.filter(([c]) => c === "connection_info")).toHaveLength(2);
			expect(h.infos).not.toContainEqual(older);
			expect(screen.queryByText(REFUSAL)).toBeNull();
			expect(screen.getByRole("textbox")).toBeInTheDocument();
			const records = traceRecords(trace.mock.calls);
			expect(
				records
					.filter((record) => record.step.startsWith("connection-"))
					.map(({ request, step }) => [request, step]),
			).toEqual([
				[1, "connection-start"],
				[1, outcome === "success" ? "connection-succeeded" : "connection-failed"],
				[2, "connection-start"],
				[2, "connection-succeeded"],
			]);
			expect(JSON.stringify(records)).not.toContain(older.token);
			expect(JSON.stringify(records)).not.toContain(older.url);
			expect(JSON.stringify(records)).not.toContain(REFUSAL);
		},
	);

	it.each(["success", "failure"] as const)("traces a late %s ignored after unmount", async (outcome) => {
		const trace = vi.spyOn(console, "info").mockImplementation(() => {});
		let resolveFirst!: (info: ConnectionInfo) => void;
		let rejectFirst!: (reason: unknown) => void;
		h.connection = () =>
			new Promise<ConnectionInfo>((resolve, reject) => {
				resolveFirst = resolve;
				rejectFirst = reject;
			});
		const view = await renderApp("?surface=dot");
		view.unmount();
		const renders = h.infos.length;
		await act(async () => {
			if (outcome === "success") resolveFirst(INFO);
			else rejectFirst({ private: REFUSAL });
		});
		expect(h.infos).toHaveLength(renders);
		expect(
			traceRecords(trace.mock.calls)
				.filter(({ request }) => request === 1)
				.map(({ step }) => step),
		).toEqual([
			"connection-start",
			outcome === "success" ? "connection-succeeded" : "connection-failed",
			"connection-late-ignored",
		]);
		expect(JSON.stringify(traceRecords(trace.mock.calls))).not.toContain(REFUSAL);
	});

	it("a panel already connected keeps its connection when the app reports ready again", async () => {
		h.connection = async () => ({ ...INFO });
		await renderApp("?surface=panel");
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
		const first = h.infos.at(-1);
		await reportReady();
		await waitFor(() => expect(h.invoke.mock.calls.filter(([c]) => c === "connection_info")).toHaveLength(2));
		expect(h.infos.at(-1)).toBe(first);
	});
});
