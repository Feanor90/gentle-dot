# Gentle Dot — native Windows 11 support

Objective: Gentle Dot runs natively on Windows 11 with parity to macOS — the Dot, the panel, the tray, global shortcuts, persistent secrets, a self-contained installer, voice, and computer control. Design: `docs/design.md`; the macOS/Linux baseline is `odd/tasks/gentle-dot.md`.
Branch: `feat/windows-port` · Delivery strategy: `staged-phases` (each phase is an independently shippable slice; the user chose full parity in L1, sequenced because review workload and verification tooling differ per phase) · Test runner: `cargo test` for `apps/desktop`, Vitest (`pnpm test`) and Playwright (`pnpm e2e`) for the rest.

## Scope note — what "native Windows" excludes

WSL is not the target. A build produced inside WSL is a Linux ELF binary; Windows cannot run it natively. The target is `x86_64-pc-windows-msvc` (and later `aarch64-pc-windows-msvc`) built on Windows over NTFS. WSL stays usable as a development shell, but every Windows work unit is verified on Windows or on a Windows CI runner, never simulated on Linux.

## Specs

- **SW1 — The platform layer knows Windows.** User: "me interesa tenerlo en windows" (L1).
  - Acceptance: `platform::Os` has a `Windows` variant and `Os::CURRENT` reports it from `cfg!(target_os = "windows")`; no Windows build silently takes a Linux branch. All platform decisions stay pure functions over injected environment values, so they are tested on every OS.
  - Checks: `cargo test` for `platform.rs`, including a test per OS variant; the `Os::CURRENT` test asserts against `cfg!(target_os = ...)` for all three.
- **SW2 — The daemon and the web UI run natively on Windows.** User: chose full parity (L1).
  - Acceptance: `pnpm install` and `pnpm dev` work on Windows with Node 24; the daemon serves the UI at `http://127.0.0.1:4317`, chats, and answers asks in the browser. No POSIX-only call is reachable on Windows without a platform branch.
  - Checks: Vitest with Windows-specific unit tests for path, shell, and process handling; a manual browser smoke on Windows.
- **SW3 — Native shell parity.** Acceptance: a Tauri 2 Windows app shows the floating Dot, expands the panel, keeps the tray with per-state glyphs, registers the open shortcut and the autostart entry, and persists the Dot position. The panel keeps its opaque background and asks the window system for nothing until the blur is verified on real hardware (see L8: Tauri applies at most one Windows material, discards the failure, and cannot be read back, so `Mica` and an `Acrylic` fallback cannot be requested honestly yet).
  - Checks: `cargo test` for the pure decisions; a manual Windows checklist with observed results (mirroring `docs/linux-testing.md`).
- **SW4 — Secrets persist and the limit is documented.** Acceptance: connector tokens live in the Windows Credential Manager, created and read by the app; no token ever falls back to `MemoryStore` on Windows. Docs state plainly that any process running as the same user — the agent's shell included — can read them, exactly as S25.7 states for Linux.
  - Checks: Rust unit tests around the store's contract and its failure paths; a manual round-trip on Windows across a restart.
- **SW5 — Self-contained Windows installer.** Acceptance: a Windows NSIS (and MSI where WiX is available) installer carries its own Node runtime, engine, Engram, and UI; `scripts/package/lib.mjs` accepts `windows-x64`; the staged runtime uses `node/node.exe`, `bin/engram.exe`, `bin/pi.cmd`, and a `;`-separated `PATH`. Installing on a clean Windows user starts the daemon and the engine.
  - Checks: the existing `scripts/package/test/**` suite extended for the Windows target; an install smoke on a clean Windows user.
- **SW6 — Voice on Windows.** Acceptance: the mic button records through a Windows capture backend and prefers the local Parakeet model (sherpa-onnx, Windows static libraries confirmed available); without the model, an API key path applies, and the UI reports voice as unavailable rather than failing.
  - Checks: Rust unit tests for the engine-selection decision; a manual device check on Windows.
- **SW7 — Computer control on Windows.** Acceptance: parity with the S24 contract — a native helper inside the app (never in the daemon or the engine) that serves MCP on `127.0.0.1:<random port>/mcp` with a per-launch bearer token, exposes the S24.2 tool set, enforces the S24.4 blocklist, rate limit, and risky-action confirmations, and paints the S28 glow. Input goes through `SendInput`, element and risk detection through UI Automation, screenshots through Windows Graphics Capture, and target-window resolution through `WindowFromPoint`.
  - Checks: Rust unit tests on every pure guard; a Windows checklist with observed results; enforcement tests that the agent cannot reach the approval dialogs.
- **SW8 — Docs, CI, and honest verification.** Acceptance: `README.md`, `docs/install.md`, and `docs/design.md` list Windows and how to build it; a Windows CI job compiles the Rust shell and runs the suites; `docs/windows-testing.md` mirrors `docs/linux-testing.md`.
  - Checks: the CI job is green on a Windows runner; docs readback.

## Verification constraint

This phase is developed from a Linux host. Windows-only code cannot be compiled or run here:

- Rust code under `#[cfg(target_os = "windows")]` is verified by review plus the Windows CI job (SW8), never by a local `cargo build`.
- Node/TypeScript work unit tests run wherever they are platform-neutral; platform-specific behavior is tested through injected values (env, path sep, program name), not through the host.
- Anything that needs a real Windows machine (window effects, tray, Credential Manager, WASAPI, UI Automation, the installer) is recorded as `blocked: needs Windows` in the task row and in the Log until observed. No such check is ever reported as passed.

## Tasks

| Task | Spec | Route | Status | Evidence | Scope |
| :--- | :--- | :--- | :--- | :--- | :--- |
| W1 | SW1, SW3 | inline (one pure decision + its two consumers) | done | `17138dd`; tree hash `0713f69d…`; `cargo test` 381 passed / 0 failed / 6 ignored (parent-verified, independent verifier); `pnpm typecheck` clean | `platform.rs` knows Windows (`Os::Windows`, `Os::CURRENT`, `panel_effect`, `panel_url`); `shell.rs` applies the effect and `status.rs` picks the tray glyph per OS |
| W3 | SW8 | inline | done | `3cc4d64`; YAML parses; Linux baseline `pnpm typecheck` exit 0, `biome check` clean over the 203 tracked files, `pnpm test` 790 passed / 13 skipped / 0 failed. **Ran for real**: fork run `38171022857` — `checkout@v7`, `pnpm/action-setup@v6`, and `setup-node@v7` all succeeded; the `typescript` job failed at `Install` (see W15) | `.github/workflows/windows.yml`: a blocking `typescript` job and a `continue-on-error` `rust` job on `windows-latest` |
| W4 | SW2 | delegated writer | pending | — | Daemon: path separators, `.exe`/`.cmd` resolution, `cmd /C` instead of `/bin/sh -c`, `where` instead of `command -v`, `%USERPROFILE%` and drive letters |
| W5 | SW2 | delegated writer | pending | — | Daemon: kill-tree (`taskkill /T` / job objects), `lsof` replacement, uid/gid and `chmod` guards |
| W6 | SW1, SW2 | delegated writer | pending | — | Rust: gate `app_channel.rs`, `daemon.rs`, `disclaimed.rs`, `libc`, and the POSIX test helpers |
| W7 | SW1, SW2 | delegated writer, high risk | pending | — | Replace the fd-3 Unix socketpair with a Windows channel (named pipe or loopback TCP + inherited handle) and document the S25 trust-model change |
| W8 | SW1, SW3 | delegated writer | pending | — | `.cargo/config.toml` Windows targets, `icon.ico`, `tauri.windows.conf.json`, NSIS/MSI bundle target. Also: ask for `Mica` on the panel once a real Windows machine shows the blur lands (see L8) |
| W9 | SW1, SW3 | delegated writer | pending | — | Shortcut remap (default is `Alt+Space`, which Windows reserves) and the glyph logic in `shortcut.rs`; autostart through the registry |
| W10 | SW4 | delegated writer, high risk | pending | — | `secure_store/windows.rs` (Credential Manager / DPAPI) + the documented limit |
| W11 | SW5 | delegated writer | pending | — | `TARGETS` + `stage-runtime.mjs` for Windows (Node `.zip`, `.cmd`/`.exe` shims, `;` PATH) and `package-windows.mjs`. **Constraint from L9:** the Windows installer cannot carry the engine while `gentle-pi` builds its Gentle AI binary from source there, so either a prebuilt Windows binary ships, or the package carries Go, or the install requires Go 1.25.10+ to be present |
| W12 | SW6 | delegated writer | pending | — | WASAPI capture backend and the Windows Parakeet path |
| W13 | SW7 | explore → spec → implement | pending | — | Computer control on Windows: UI Automation, `SendInput`, Windows Graphics Capture, `WindowFromPoint`, per-monitor DPI |
| W14 | SW8 | delegated writer | pending | — | `docs/install.md` Windows section, README badge and claims, `docs/windows-testing.md`, design updates |
| W15 | SW2, SW5 | explore → fix | done | `136d5c9`; **verified** in fork run `38177833421` — `actions/setup-go@v7` installed Go 1.27.2 and the `gentle-pi` postinstall built `gentle-ai.exe` and reported `Done`; `Install` and `Typecheck` both succeeded | `pnpm install` failed on Windows because the `gentle-pi` postinstall builds its Gentle AI binary from source there and needs Go ≥ 1.25.10 while the runner ships 1.24.13 |
| W16 | SW2 | inline | done | `a10a763`; **verified** in fork run `38184877146` — the `Lint` step went from failure to **success** | Windows checkouts get CRLF from `core.autocrlf=true`, and `biome check` reported 201 errors, one per line, on the Windows runner. Fixed with `.gitattributes` (`* text=auto eol=lf`), which also fixes a Windows developer's local checkout |

## Log

- **L1 (2026-10-11, user):** "Qué necesitamos hacer para adaptar este proyecto a poder utilizarlo en windows, tengo windows 11, y aunque ahora estamos trabajando en wsl 2 o 3 porque se actualizó hace unos días, me interesa tenerlo en windows". Scope choice: **full parity with macOS** (all six phases), including computer control. Environment note: the current checkout lives on the WSL filesystem (`/home/Row/...`), so Windows builds need a Windows-side checkout over NTFS.

- **L2 (2026-10-11, agent, evidence):** Read-only reconnaissance of the whole repository before any write. Findings, with evidence:
  - No Windows support exists today: zero `#[cfg(windows)]` in the repo, no `icon.ico`, no `tauri.windows.conf.json`, and `scripts/package/lib.mjs:8-12` lists only `darwin-arm64`, `linux-arm64`, `linux-x64` while `scripts/package/test/lib.test.ts:30` asserts that `windows-x64` throws.
  - `apps/desktop/src-tauri/src/platform.rs:6-14` defines `enum Os { MacOs, Linux }` and `Os::CURRENT` returns `Linux` for anything that is not macOS, so a Windows build would take every Linux branch (`effects=none`, `forced_gdk_backend`, `compositor_places_windows`).
  - The app↔daemon private channel is a Unix socketpair on fd 3: `app_channel.rs:28`, `daemon.rs:16-18`, `daemon.rs:294-297`, with `pre_exec`, `dup2`, `close_range`, and `getrlimit` in `daemon.rs:313-380`. This does not compile on Windows and is the keystone of the port.
  - `secure_store/mod.rs:110-117` has macOS (Keychain) and Linux (Secret Service) backends and falls back to `MemoryStore` everywhere else, so Windows would silently lose connector tokens on restart.
  - Daemon POSIX surface: `chmod`/`mode` 0700/0600 in `daemon.ts`, `connectors.ts`, `profiles.ts`, `isolation.ts`; `spawn` with `{uid, gid}` (`supervisor.ts:221-225`); `execFileSync("/bin/sh", ["-c", …])` (`connector-credentials.ts:30`); `env.SHELL || "/bin/sh"` plus `command -v engram` (`runtime.ts:42`); `lsof` (`isolation.ts:228`); `SIGTERM`/`SIGKILL` kill-tree (`supervisor.ts:167-207`).
  - Shell: `daemon.rs:223-226` builds a colon-joined `PATH` and `{root}/node/bin/node` with no `.exe`; `build.rs:28-47` records the build machine's `node`/`PATH` and its `find_in_path` has no `.exe` handling; `disclaimed.rs` is `posix_spawn` only; `libc` is unconditional.
  - Packaging: `stage-runtime.mjs:131-160` downloads Node as `.tar.gz` and extracts with `tar`; `lib.mjs:162` generates `#!/bin/sh` wrappers with 0755.
  - Voice: `voice/pipe.rs:23-27` records with `parec`/`arecord`; `voice/app.rs:133` already has `VoiceInput::unsupported()`.
  - Computer control: `computer/macos.rs` (604 lines) is CGEvent/AXUIElement/ScreenCaptureKit with no shared surface; S24 declared macOS-only and put Linux out of scope.
  - Free wins: the daemon, protocol, and UI are platform-neutral (Tauri access is behind `isTauri()` in `packages/ui/src/desktop.ts:2`); `main.rs:2` already sets `windows_subsystem = "windows"`; `pnpm-lock.yaml` resolves win32 binaries for biome, esbuild, rolldown, and the Tauri CLI; the external engine (`gentle-pi`) provisions a native Windows x64/arm64 runtime, Engram publishes Windows binaries, and sherpa-onnx publishes Windows x64/arm64 static libraries.
  - Tests: 63 test files, many POSIX-only (`/bin/sleep` and `exec 3<&-` in `daemon.rs` tests, `lsof`, `secret-tool`), so several need platform guards.
  - Recorded in Engram as the topic mirror of this document.

- **L3 (2026-10-11, agent, decision):** W2 was absorbed into W1. The effect decision (`platform.rs`) and its consumer (`shell.rs`) cannot land separately: on its own, W1 told Windows to paint a translucent panel while `shell.rs` still applied `HudWindow` under `#[cfg(target_os = "macos")]`, leaving the panel transparent with no backdrop. One work unit, one coherent tree.

- **L4 (2026-10-11, agent, evidence):** Two things checked in the `tauri` source rather than assumed.
  - `Effect::Mica`, `Effect::Acrylic`, and `Effect::HudWindow` are all emitted by a macro in `tauri-utils-2.10.1/src/config.rs:4268-4295` with **no per-variant `cfg`**, so naming `Mica` compiles on macOS and Linux. The gating is at `tauri-2.12.1/src/vibrancy/mod.rs`: `#[cfg(windows)] mod windows;` and `#[cfg(target_os = "macos")] mod macos;`. Asking for a foreign material is a silent no-op, not an error, which is why this unit is verifiable from Linux.
  - `WebviewWindowBuilder::effects` is documented `**Linux**: Unsupported` (`tauri-2.12.1/src/webview/webview_window.rs:851`). `with_panel_effects` therefore returns the Linux builder untouched instead of handing Tauri an empty effect list.

- **L5 (2026-10-11, agent, evidence):** W1 closed in `17138dd` (3 files, +113/−21). An independent verifier, bound to the tree hash `0713f69d5a2b5c03d0cb667436a0ae76837524e88cd9658ebacd222565b70b4b` (recorded before its run and confirmed unchanged after), reported:
  - `cargo test` in `apps/desktop/src-tauri`: compiled, **381 passed, 0 failed, 6 ignored**; the five new/changed tests were observed passing by name. This host has the GTK/WebKit2/dbus libraries, so the suite is a usable channel here.
  - `pnpm typecheck`: clean, exit 0. Note for later units: `npx tsc -b` is **not** a valid invocation in this repo (npx resolves an unrelated `tsc` package); use `pnpm typecheck`.
  - `has_vibrancy` has zero remaining references, and both `match`es over `Os` (`platform.rs:37`, `status.rs:34`) are exhaustive over all three variants with no wildcard, so adding an OS is a compile error until it is decided.
  - macOS behavior is unchanged: the `HudWindow` + `Active` + `radius(20.0)` config is byte-identical, and `panel_url(Os::MacOs)` is the same string.
  - `Effect::Mica` is available on every target: `pub enum WindowEffect` at `tauri-utils-2.10.1/src/lib.rs:71` carries only `#[non_exhaustive]`, with `Mica` at `:123` and no `#[cfg]`.
  - **Not verified, and not to be reported as such:** no `cfg!(target_os = "windows")` arm has ever been compiled, `Os::CURRENT` resolved to `Linux` during the tests, and Windows runtime behavior (Mica on Windows 11, no Mica on Windows 10) has never been observed on hardware. W3 is the channel that closes this gap.
  - Side effect worth knowing: `pnpm typecheck` triggered an implicit dependency install into `node_modules/` (untracked); the tracked tree hash was unaffected.

- **L6 (2026-10-11, agent, evidence):** W3 landed in `3cc4d64`: `.github/workflows/windows.yml`, the first CI in the repository. Two jobs on `windows-latest`:
  - `typescript` (**blocking**): `checkout@v7` → `pnpm/action-setup@v6` → `setup-node@v7` (`node-version-file: .nvmrc`, `cache: pnpm`) → `pnpm install --frozen-lockfile` → `typecheck` → `lint` → `test`. The daemon, protocol, and UI are meant to be platform-neutral, so this job going green is the acceptance criterion for W4 and W5.
  - `rust` (**`continue-on-error: true`**): `checkout@v7` → `dtolnay/rust-toolchain@stable` → `Swatinem/rust-cache@v2.9.2` → `cargo test` in `apps/desktop/src-tauri`. It cannot pass today: `app_channel.rs:28` and `daemon.rs:16-18` import `std::os::unix` and `std::os::fd` unconditionally. It runs because that failure output is the input to W6 and W7. The workflow comment names the condition for removing the flag: W7.
  - Action tags were verified against upstream releases rather than recalled: `actions/checkout` v7.1.0, `actions/setup-node` v7.1.0, `pnpm/action-setup` v6, `Swatinem/rust-cache` v2.9.2. The first guess at `pnpm/action-setup@v4` was stale: its current README shows `@v6`, and the same file is where the `pnpm/setup` migration is documented. Note for 2026: `pnpm/action-setup` has a successor, `pnpm/setup@v1`, recommended for pnpm 11+; `action-setup@v6` + `setup-node@v7` was chosen because upstream documents that combination as still supported for pnpm v11/v12 and its per-step semantics are known.
  - Independent verifier (bound to HEAD `fba4239`): YAML parses, step order valid (`pnpm/action-setup` before `setup-node` with `cache: pnpm`, or the cache step fails), all `run:` names exist as package.json scripts, `.nvmrc` (`24`) satisfies `engines.node >= 24`, job-level `continue-on-error` is valid syntax, and no YAML special-value pitfall. **0 defects found.**
  - **Local-vs-CI gotcha, worth knowing:** `pnpm lint` fails on this machine with a format error in `.atl/.skill-registry.cache.json`. That file is in `.atl/`, which carries its own `.gitignore` containing `*`, so it is untracked and absent from a fresh checkout. `biome check` over only the tracked files is clean (203 files). The `lint` step therefore passes in CI.
  - **Not verified, and not to be reported as such:** the workflow has never executed on a runner. No GitHub runner or network was available to the verifier, so runtime CI behavior, marketplace tag resolution, and the `pnpm/action-setup@v6` source are unverified. The Rust Windows compile failure is inferred from static imports, not observed (no Windows toolchain here). Only a push closes this.

- **L7 (2026-10-11, agent, evidence):** The push failed against upstream — the WSL SSH key authenticates as `Row0902`, which is not a collaborator on `Gentleman-Programming/gentle-dot`. A fork was created instead (`Row0902/gentle-dot`) and `feat/windows-port` pushed there, and PR #57 was opened upstream.
  - **Correction to L6:** a pull request opened **from a fork** does not trigger the workflow. For `pull_request` events from a fork, GitHub runs the workflows defined in the base repository's **default branch**, not the fork's, so the fork cannot define its own CI. `main` has no workflows, so `repos/.../actions/workflows` is empty and `total_count` was 0 for both `event=pull_request` and `head_sha`. L6's expectation that the PR itself would run the job was wrong: it holds for same-repository branches, not for forks. The first workflow of a repository cannot be bootstrapped through a fork — it needs a same-repository branch, a collaborator, or a push to the default branch.
  - The run was obtained by pushing the branch to the fork's own `main` (a clean fast-forward from `535e7f7` to `1736f62`), which matches the `push: branches: [main]` trigger. **Fork run `38171022857`:**
    - `Set up job`, `actions/checkout@v7`, `pnpm/action-setup@v6`, and `actions/setup-node@v7` all **succeeded** — the action tags chosen in W3 are real and the workflow infrastructure works.
    - `TypeScript (daemon, protocol, UI)` → **failure** at the `Install` step; `Typecheck`, `Lint`, and `Test` were skipped as a result.
    - `Rust shell` was still in progress when the log was written.
  - **The install error text is not yet known.** GitHub does not publish logs until the whole run completes, and the per-job logs endpoint returned nothing. Recorded as unknown rather than guessed; it is W15.
  - Two things about the install were ruled out with evidence: `pnpm install --frozen-lockfile` passes on Linux (exit 0, "Already up to date", 223 ms), and `pnpm-lock.yaml` already carries the Windows platform packages (77 `win32` references; 17 distinct entries including `@biomejs/cli-win32-x64`, `@esbuild/win32-x64`, `@rolldown/binding-win32-x64-msvc`, `@tauri-apps/cli-win32-x64-msvc`, `@typescript/typescript-win32-x64`, `@yuuang/ffi-rs-win32-x64-msvc`). So it is neither a stale lockfile in general nor a missing Windows dependency in particular.

- **L8 (2026-10-11, agent, evidence):** The native review of W1+W3 (lineage `review-e964a8bcd1761b57`, tier `high`, 4 lenses, 326 changed lines) returned one CRITICAL finding that survived an independent refuter, so it was a real defect in W1, not a false alarm.
  - **R4-1 (resilience, `shell.rs:488-490`):** the Windows panel asked for `Effect::Mica` with no fallback while `has_panel_effect()` was true, so `panel_url` omitted `effects=none` and the UI was told not to paint a background. If `Mica` did not take effect — Windows 10, transparency effects disabled, Remote Desktop, a compositor or GPU failure — the panel would be translucent with no backdrop and read unreadable. The code comment even claimed the opposite ("the panel keeps the translucent URL and therefore still paints its own background"), which was false.
  - **Why the obvious fix was wrong.** SW3 promised `Acrylic` as a fallback, and it cannot be delivered through this API. `tauri-2.12.1/src/vibrancy/windows.rs` scans the effect list with `find`, so `[Mica, Acrylic]` picks `Mica` and never tries `Acrylic`; the `window_vibrancy` result is discarded with no `?` and no log; and there is no readback to ask whether the effect applied. A silent no-op is therefore indistinguishable from success, and asking for `Mica` proves nothing.
  - **Correction applied:** `WindowEffect::Mica` was removed, `panel_effect()` returns `None` for Windows, and `with_panel_effects` leaves the Windows builder untouched. The panel therefore keeps `effects=none` and paints its own background, which is always readable. W8 asks for `Mica` once a real Windows machine shows the blur lands, and SW3's fallback clause was corrected because the fallback it promised does not exist. A regression test (`an_unverified_backdrop_never_leaves_the_panel_transparent`) now pins the invariant: any OS whose backdrop is unverified must end up with `effects=none`.
  - **Lesson worth keeping:** the review paid for itself here. This was an inferential finding about a platform reachable by only one of the four lenses, on a code path that cannot run on the development host, and it was introduced by the author in the same commit as a comment asserting the opposite. Four lens runs plus one refuter was the right price for it.

- **L9 (2026-10-11, agent, evidence):** W15 diagnosed from the real CI log. The `Install` step failed with the cause named in full:

```
.../node_modules/gentle-pi postinstall$ node scripts/install-gentle-ai.mjs
gentle-pi could not install its package-local Gentle AI v4.0.0 binary:
  Windows source installation requires local Go 1.25.10 or newer;
  found go version go1.24.13 windows/amd64.
postinstall: Failed
[ELIFECYCLE] Command failed with exit code 1.
```

  - The `windows-latest` image ships Go 1.24.13. On Darwin and Linux the same postinstall downloads a SHA-256-pinned release archive, so the Go requirement is Windows-only and invisible on every other platform.
  - **What the log rules out**, which matters because these were the guesses before it: `✓ Lockfile passes supply-chain policies (466 entries)`, `Packages: +365`, `added 365, done`, and the `esbuild` postinstall succeeded. Long paths, junctions, symlinks, and a stale or Windows-incomplete lockfile were **never** the problem. The install got all the way to the last postinstall.
  - Fix in `136d5c9`: `actions/setup-go@v7` with `go-version: stable` before `pnpm install`, because the constraint is "or newer" rather than an exact version. The tag was checked against the upstream release list first (v7.0.0, 2026-07); guessing v5 would have been a year stale, the same mistake made earlier with `pnpm/action-setup`.
  - **Consequence beyond CI, for SW5 and W11:** a self-contained Windows installer cannot carry the engine while `gentle-pi` builds its binary from source there. Either upstream publishes a prebuilt Windows binary, or the package carries Go, or Windows requires Go 1.25.10+ to be installed. This is the first Windows blocker that is **not** fixable inside this repository.
  - **Fix not yet verified:** the Go step has never run. Verification needs one more push to the fork's `main`, which is the only trigger available until the workflow exists on the upstream default branch.
  - Note on the review lifecycle: this work unit moves the candidate tree past `5a68d3fa…`, so lineage `review-e964a8bcd1761b57` is superseded. It was already unable to close (L8: the targeted-validator capture was rejected three times), so nothing that could have finished was lost.

- **L10 (2026-10-11, agent, evidence):** A fresh lineage, `review-9fd9dd32f84f6d5e`, reviewed the corrected candidate (tree `89498db7…`, 378 changed lines, tier `high`, 4 lenses) and returned **`approved`** with zero CRITICAL findings. The acknowledgement burned the authority (`gentle-ai.review-acknowledged/v1`), so the review lifecycle for this candidate is closed.
  - **This is what validated the R4-1 correction**, which the rejected targeted-validator capture never did: four independent lenses read the corrected Windows panel path and found nothing blocking. The lifecycle stall in L8 cost the narrow validation step, not the validation.
  - Eight advisory findings, all explicitly non-blocking, recorded for later work rather than actioned now. The provider states they must not trigger a re-review of this candidate: `R1-001` (risk, WARNING, `.github/workflows/windows.yml:42`), `R2-001` (readability, SUGGESTION, `platform.rs:240-244`), `R2-002` (readability, SUGGESTION, `status.rs:12`), `R2-003` (readability, WARNING, `windows.yml:79-82`), `R2-004` (readability, SUGGESTION, `windows.yml:26-29`), `R3-1` (reliability, WARNING, `windows.yml:84`), `R3-2` (reliability, SUGGESTION, `shell.rs:489-491`), `R3-3` (reliability, WARNING, `odd/tasks/windows-port.md:43`).
  - Note that four of the eight land on `.github/workflows/windows.yml`, the file that raised the tier in the first place via the `shell_source` / `shell_process` risk signal. The classifier was pointing at something real.

- **L11 (2026-10-11, agent, evidence):** The next run (`38177833421`) confirmed the Go fix and exposed a second, unrelated defect behind it.
  - **W15 verified.** `Successfully set up Go version stable`, `go version go1.27.2 windows/amd64`, then `gentle-pi postinstall: Gentle AI v4.0.0 installed at …\gentle-ai.exe` and `postinstall: Done`. Step conclusions: `Install` **success**, `Typecheck` **success**.
  - **W16 found.** `Lint` **failure**, `Test` skipped: `Found 201 errors`, and every reported line ends in a carriage return (`throw·new·Error(…);␍`). Windows checkouts default to `core.autocrlf=true`, so the working tree gets CRLF and `biome check` judges the bytes it is given. The repository had **no `.gitattributes`**, and the development host uses `core.autocrlf=input`, which is exactly why this never appeared locally.
  - Fix in `a10a763`: `.gitattributes` with `* text=auto eol=lf`. It belongs in the repository rather than in the workflow, because a Windows developer hits the same 201 errors on their own checkout before pushing. `git add --renormalize .` staged only the new file, confirming the stored content was already LF and that nothing else moved.
  - This is the second time in this port that a real defect was invisible on the development host and only a Windows runner could surface it. It is the argument for W3 paying for itself, and it is worth remembering that both times the cost of finding it was one CI run rather than a debugging session on the user's machine.

- **L12 (2026-10-11, agent, evidence):** Run `38184877146` confirmed W16 (the `Lint` step went from failure to **success**) and unblocked the step behind it, which is where the real work starts. **The Windows baseline of the TypeScript suite, measured:**

```
Test Files  23 failed | 54 passed | 7 skipped (84)
```

  On Linux the same suite is `78 passed | 6 skipped`, **0 failed**. So 23 of 84 test files fail on Windows, and the failures map onto the plan instead of being random:
  - **41 assertions are file-permission checks**, the single biggest category: 31 × `expected 438 to be 384` (`0o666` vs `0o600`), 8 × `438 to be 448` (`0o700`), 2 × `438 to be 420` (`0o644`). Windows has no POSIX mode bits, so these can never hold. That is **W5**, whose scope is exactly the `chmod`/`mode` guards.
  - **POSIX path assumptions: W4.** `expected 'D:\h' to be '/h'` (a test using a POSIX absolute literal), `expected 'D:\a\gentle-dot\…' to match /node_modules\/gentle-pi\/…/` (a forward-slash regex against a backslash path), and a `C:\Users\RUNNER~1\AppData\Local\Temp\…` comparison that differs only in the temp path's form.
  - **The fd-3 channel: W7**, named and isolated — `app-channel-fd.test.ts` covers "the app channel on fd 3 (S25.1)" and fails exactly there.
  - **uid/gid privilege switching: W6** — `engine-access.test.ts` (13 failures) exercises `seteuid`/`setegid`, which do not exist on Windows.
  - **Behaviour that `chmod` was faking: W5.** `child-guard.test.ts` simulates an unwritable extensions folder by removing the write bit; on Windows the write succeeds, so `expected '1' to be '0'` and `expected +0 to be 1`. The tests are honest; the simulation mechanism is what does not port.
  - **Look at this before estimating W4:** `config.test.ts` reports `expected { port: 5000, host: '127.0.0.1', …(8) } to match object { port: 5000, …(1) }`, an object-shape difference that path handling alone does not explain.
  - Worst offenders by failure count: `vps-gateway` (31), `app-channel-fd` (27), `runtime` (16), `cli` (15), `engine-access` (13), `connector-integrity` (13), `config` (13). Note that `vps-*` is Linux/VPS-only by design (S25.8), so part of W6 is gating those suites rather than porting them.
  - This is the number the plan needed: the daemon port is not a handful of `path.join` fixes, it is 23 test files' worth of platform assumptions, and now they are enumerated instead of guessed.
