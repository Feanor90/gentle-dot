/** Static startup metadata only: never accept connection values, payloads, or errors. */
export type StartupStep =
	| "listener-registering"
	| "listener-registered"
	| "listener-failed"
	| "ready-received"
	| "connection-start"
	| "connection-succeeded"
	| "connection-failed"
	| "connection-late-ignored";

export function startupTrace(surface: "dot" | "panel" | "web", request: number, step: StartupStep): void {
	try {
		console.info(`[startup-trace] ${JSON.stringify({ request, step, surface, time_ms: Date.now() })}`);
	} catch {
		// Diagnostics must not change connection or listener behavior if the console is unavailable.
	}
}
