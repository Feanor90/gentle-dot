import type { ClientMessage } from "@gentle-dot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ConnectionInfo, tokenFromLocation } from "./client.ts";
import { ChatSurface } from "./components/ChatSurface.tsx";
import type { ComputerControls } from "./components/Computer.tsx";
import { DotSurface } from "./components/DotSurface.tsx";
import { GlowSurface } from "./components/GlowSurface.tsx";
import { computerPermissions, requestComputerPermission, setComputerYolo, stopComputer } from "./computer.ts";
import {
	connectionInfo,
	connectorCommand,
	hidePanel,
	inDesktop,
	onDesktopEvent,
	setDotState,
	startDragging,
	togglePanel,
} from "./desktop.ts";
import { startupTrace } from "./startup-trace.ts";
import { createUploader } from "./uploads.ts";
import { useComputerAvailable, useComputerState } from "./useComputer.ts";
import { useDot } from "./useDot.ts";
import { usePanelWindow } from "./usePanelWindow.ts";

type Surface = "dot" | "panel" | "web";

function currentSurface(): Surface | "glow" {
	const surface = new URLSearchParams(window.location.search).get("surface");
	return surface === "dot" || surface === "panel" || surface === "glow" ? surface : "web";
}

/**
 * Whether the window behind the panel blurs the desktop (macOS vibrancy). The shell adds
 * `effects=none` to the panel URL where it cannot (Linux), and the panel paints its own background.
 */
export function windowEffects(search: string): "native" | "none" {
	return new URLSearchParams(search).get("effects") === "none" ? "none" : "native";
}

function browserConnection(): ConnectionInfo | undefined {
	const token = tokenFromLocation(window.location, window.sessionStorage, (url) =>
		window.history.replaceState(null, "", url),
	);
	if (!token) return undefined;
	const daemon = import.meta.env.VITE_DAEMON_ORIGIN as string | undefined;
	const base = daemon ? new URL(daemon) : window.location;
	const protocol = base.protocol === "https:" ? "wss:" : "ws:";
	return { url: `${protocol}//${base.host}/ws`, token };
}

/** ⌘⇧F (Ctrl+Shift+F off macOS) toggles the panel's full screen. */
function isFullscreenShortcut(event: KeyboardEvent): boolean {
	return (
		(event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f"
	);
}

/** The desktop's glow overlay (S28) is its own surface: it never connects to the assistant. */
export function App() {
	const surface = currentSurface();
	return surface === "glow" ? <GlowSurface /> : <Assistant surface={surface} />;
}

function Assistant({ surface }: { surface: Surface }) {
	const [info, setInfo] = useState<ConnectionInfo | undefined>(undefined);
	const [missingToken, setMissingToken] = useState(false);
	/** Why the desktop app could not reach its assistant, in the app's own words (S35.2). */
	const [unreachable, setUnreachable] = useState<string>();
	const [focusKey, setFocusKey] = useState(0);
	const traceSurface = useRef(surface);
	const { state, send, dismiss, dispatch } = useDot(info);
	// Files go to the daemon over HTTP, with the same access key as the WebSocket (S31.2).
	const upload = useMemo(() => (info ? createUploader(info) : undefined), [info]);
	const conversations = useRef(state.features.conversations);
	conversations.current = state.features.conversations;
	// Computer control lives in the desktop app only (S24.7); the panel registers the helper.
	const desktop = inDesktop();
	const { session: computerSession, yolo } = useComputerState(desktop && surface !== "web");
	const computerAvailable = useComputerAvailable(desktop && surface === "panel", state.connection === "open");
	// Connector changes go through the app, on behalf of this window (S25.2); the web page has none.
	const clientId = state.clientId;
	const appSend = useCallback(
		(message: ClientMessage) => {
			if (!clientId) return;
			connectorCommand(clientId, message).catch((error: unknown) =>
				dispatch({ type: "notice", level: "error", message: String(error) }),
			);
		},
		[clientId, dispatch],
	);
	// The panel's own window (S26): hide the rose, full screen.
	const panel = usePanelWindow(desktop && surface === "panel");
	const fullscreenNow = panel.fullscreenNow;
	const setFullscreen = panel.controls.setFullscreen;
	const computer: ComputerControls | undefined =
		desktop && surface === "panel"
			? {
					available: computerAvailable,
					...(computerSession ? { session: computerSession } : {}),
					...(yolo ? { yolo } : {}),
					stop: stopComputer,
					setYolo: setComputerYolo,
					permissions: computerPermissions,
					requestPermission: requestComputerPermission,
				}
			: undefined;

	useEffect(() => {
		if (inDesktop()) {
			const surface = traceSurface.current;
			let live = true;
			let requests = 0;
			let inFlight = false;
			let readyPending = false;
			let recovering = true;
			let retry: ReturnType<typeof setTimeout> | undefined;
			// One mount gets one cold-start window; ready events never renew it. Leave room
			// for the unchanged native 20 s wait, including when a WebView timer runs late.
			const deadline = performance.now() + 180_000;
			const clearRetry = () => {
				clearTimeout(retry);
				retry = undefined;
			};
			const accept = (request: number) => {
				if (!live) {
					startupTrace(surface, request, "connection-late-ignored");
					return false;
				}
				inFlight = false;
				if (readyPending) {
					readyPending = false;
					connect();
					return false;
				}
				return true;
			};
			const connect = () => {
				if (!live) return;
				clearRetry();
				if (inFlight) {
					readyPending = true;
					return;
				}
				inFlight = true;
				const request = ++requests;
				startupTrace(surface, request, "connection-start");
				return connectionInfo().then(
					(next) => {
						startupTrace(surface, request, "connection-succeeded");
						if (!accept(request)) return;
						recovering = false;
						clearRetry();
						// The same assistant keeps its connection; only a new one replaces it.
						setInfo((current) =>
							current?.url === next.url && current.token === next.token ? current : next,
						);
						setUnreachable(undefined);
						setMissingToken(false);
					},
					(error: unknown) => {
						startupTrace(surface, request, "connection-failed");
						if (!accept(request)) return;
						const reason = typeof error === "string" ? error : error instanceof Error ? error.message : "";
						if (reason) setUnreachable(reason);
						else setMissingToken(true);
						// Only Rust's exact readiness timeout is transient. Security refusals,
						// missing credentials, and unknown rejections never start a retry loop.
						const timeout = reason.match(/^the assistant did not answer on port [0-9]+ \(see daemon\.log\)$/);
						if (timeout?.[0] !== reason) {
							recovering = false;
							return;
						}
						if (recovering && performance.now() + 1_000 + 20_000 <= deadline) {
							retry = setTimeout(() => {
								retry = undefined;
								if (live && performance.now() + 20_000 <= deadline) connect();
							}, 1_000);
						}
					},
				);
			};
			// A refused or timed-out window recovers without a reopen: the app reports its assistant
			// ready after Restart assistant, or after a start slower than `connection_info` waits (S35.2).
			startupTrace(surface, 0, "listener-registering");
			const ready = onDesktopEvent("dot://assistant-ready", () => {
				startupTrace(surface, 0, "ready-received");
				void connect();
			});
			void ready.then(
				() => startupTrace(surface, 0, "listener-registered"),
				() => startupTrace(surface, 0, "listener-failed"),
			);
			void connect();
			return () => {
				live = false;
				clearRetry();
				void ready.then((unlisten) => unlisten());
			};
		}
		const found = browserConnection();
		if (found) setInfo(found);
		else setMissingToken(true);
	}, []);

	useEffect(() => {
		if (surface === "dot") setDotState(state.agentState);
	}, [surface, state.agentState]);

	useEffect(() => {
		if (surface !== "panel") return;
		const subscriptions = [
			// The menu bar item starts a new chat only when the conversations list is on.
			onDesktopEvent("dot://new-conversation", () => {
				if (conversations.current) send({ type: "new_conversation" });
			}),
			onDesktopEvent("dot://panel-shown", () => setFocusKey((k) => k + 1)),
		];
		// Esc, in order: whatever inside the panel already handled it (it called preventDefault),
		// then leaving full screen, then hiding the panel.
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === "Escape") {
				if (fullscreenNow.current) setFullscreen(false);
				else hidePanel();
				return;
			}
			if (isFullscreenShortcut(event)) {
				event.preventDefault();
				setFullscreen(!fullscreenNow.current);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			for (const s of subscriptions) void s.then((unlisten) => unlisten());
		};
	}, [surface, send, fullscreenNow, setFullscreen]);

	useEffect(() => {
		document.documentElement.dataset.surface = surface;
		document.documentElement.dataset.effects = windowEffects(window.location.search);
	}, [surface]);

	if (surface === "dot") {
		return (
			<DotSurface
				agentState={state.agentState}
				connected={state.connection === "open"}
				inControl={computerSession !== undefined}
				yolo={yolo !== undefined}
				toggle={togglePanel}
				startDrag={() => void startDragging()}
			/>
		);
	}
	if (unreachable !== undefined || missingToken) {
		return (
			<div className="chat chat-web">
				<div className="status" role="status">
					{unreachable ??
						"This page needs your access key. Open it from the Gentle Dot menu (Open in browser)."}
				</div>
			</div>
		);
	}
	return (
		<ChatSurface
			variant={surface === "panel" ? "panel" : "web"}
			state={state}
			send={send}
			dismiss={dismiss}
			dispatch={dispatch}
			focusKey={focusKey}
			{...(surface === "panel" ? { onHide: hidePanel } : {})}
			{...(desktop && surface === "panel" ? { appSend } : {})}
			{...(computer ? { computer } : {})}
			{...(desktop && surface === "panel" ? { voiceModel: true } : {})}
			{...(desktop && surface === "panel" ? { panelWindow: panel.controls } : {})}
			{...(desktop && surface === "panel" ? { settings: true } : {})}
			{...(upload ? { upload } : {})}
		/>
	);
}
