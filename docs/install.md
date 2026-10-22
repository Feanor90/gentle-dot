# Installing Gentle Dot

Gentle Dot ships as a self-contained app: it carries its own Node runtime, the assistant engine, and a fallback Engram. Nothing else needs to be installed first.

## Optional: separate conversations on desktop

Gentle Dot defaults to one continuous chat. To show **New conversation** and the conversation list, quit the app, add `"conversations": true` to its `config.json` (keeping existing keys), then reopen it:

```json
{ "conversations": true }
```

The file is `~/.gentle-dot/config.json` (`%USERPROFILE%\.gentle-dot\config.json` on Windows, unless the data folder is overridden). This does not delete existing chats or change Launch at login. Remove the key or set it to `false` and reopen to return to the continuous-chat interface. An existing `GENTLE_DOT_CONVERSATIONS` environment variable takes precedence: only `1` enables conversations. No global environment change is needed.

## macOS

Requirements: a Mac with Apple Silicon (M1 or later) and macOS 12.3 or later.

### Install

1. Open `Gentle Dot_<version>_aarch64.dmg`.
2. Drag **Gentle Dot** onto the **Applications** folder in the window that opens.
3. Eject the disk image.

### First open

The app is not notarized by Apple, so macOS blocks the first open. Approve it once:

- **macOS 15 (Sequoia) and later:**
  1. Open Gentle Dot from Applications. macOS says it cannot verify the app; click **Done**.
  2. Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to the Gentle Dot message.
  3. Confirm with **Open Anyway** and your password.
- **macOS 12 to 14:** Control-click Gentle Dot in Applications, choose **Open**, then **Open** again.

Alternative from Terminal (any version), which removes the download quarantine from the app:

```sh
xattr -dr com.apple.quarantine "/Applications/Gentle Dot.app"
```

Only do this for a copy you got from someone you trust.

### Permissions for computer control

Computer control needs two macOS permissions. Open **Connectors → Computer** in Gentle Dot and click **Grant** for each, or add Gentle Dot by hand:

- **System Settings → Privacy & Security → Accessibility**: lets the assistant click and type.
- **System Settings → Privacy & Security → Screen Recording** (named **Screen & System Audio Recording** on macOS 15): lets the assistant take screenshots.

Restart Gentle Dot after granting Screen Recording.

macOS ties these grants to the app's signature. A DMG signed with a stable identity (see below) keeps them across updates. A build signed ad hoc (the default) gets a new signature on every build, so after an update the old entries stop working: remove Gentle Dot from both lists with the minus button and grant again.

### Where data lives

| What | Where |
|---|---|
| Settings, conversations, logs (`daemon.log`), the engine's own files | `~/.gentle-dot/` |
| Memory (Engram, project `gentle-dot`) | `~/.engram/`, shared with any other Engram user on this Mac |
| Launch at login (when turned on) | a LaunchAgent in `~/Library/LaunchAgents/` |

The app itself never changes after install; everything it writes goes to the folders above.

### Uninstall

1. In the menu bar item, turn off **Launch at login**, then quit Gentle Dot.
2. Drag `/Applications/Gentle Dot.app` to the Trash.
3. Optional: remove `~/.gentle-dot/` to delete settings and conversations.
4. Optional: reset the permissions:

   ```sh
   tccutil reset Accessibility dev.gentleman.gentle-dot
   tccutil reset ScreenCapture dev.gentleman.gentle-dot
   ```

Leave `~/.engram/` in place unless you want to delete every Engram memory on this Mac, not only Gentle Dot's.

### Build the DMG from source

On an Apple Silicon Mac with Node 24, pnpm, Rust (`rustc` on `PATH`), and Xcode command line tools:

```sh
pnpm install
pnpm package:mac                 # signs ad hoc
pnpm package:mac --sign "<identity>"   # or GENTLE_DOT_SIGN_IDENTITY="<identity>"
pnpm package:mac --check         # also mounts the DMG and smoke-tests the copied app's daemon
```

To keep permissions across updates, sign every release with the same identity. `scripts/package/create-signing-identity.sh` creates a self-signed one named "Gentle Dot Local Signing" in the login keychain (no trust setting or password needed); its designated requirement pins the certificate (`certificate leaf = H"…"`), so it stays the same across builds. Keep that keychain entry: a new certificate means everyone grants the permissions once more. The first signed build asks once per signed file to use the key; choose **Always Allow** on the first prompt.

The command stages the runtime (`build/runtime/darwin-arm64`), signs the runtime's binaries, builds the release app, and writes the DMG to `apps/desktop/src-tauri/target/release/bundle/dmg/`. `--skip-stage` reuses a runtime staged earlier; `--check-dmg <dmg>` checks an existing DMG without building.

## Linux

Gentle Dot ships as a self-contained package: it carries its own Node.js, assistant engine, and Engram, so nothing else needs to be installed first. Pick the file for your system (`dpkg --print-architecture` or `uname -m` tells which):

| System | File | Install |
|---|---|---|
| Debian 12+, Ubuntu 24.04+ (x86_64) | `gentle-dot_<version>_amd64.deb` | `sudo apt install ./gentle-dot_<version>_amd64.deb` |
| Debian 12+, Ubuntu 24.04+ (ARM64) | `gentle-dot_<version>_arm64.deb` | `sudo apt install ./gentle-dot_<version>_arm64.deb` |
| Arch Linux, Omarchy (x86_64) | `gentle-dot-<version>-1-x86_64.pkg.tar.zst` | `sudo pacman -U gentle-dot-<version>-1-x86_64.pkg.tar.zst` |

Keep the `./` with `apt`. The package manager adds WebKitGTK and tray support. Then open **Gentle Dot** from your app menu, or run `gentle-dot`.

- The app is `/usr/bin/gentle-dot`; its bundled runtime is in `/usr/lib/Gentle Dot/runtime`. Your data lives in `~/.gentle-dot`.
- First launch needs the network once: the engine installs its companion packages (about 20 seconds).
- Computer control is macOS only.
- Connector secrets (tokens and sign-ins) are kept in your desktop keyring through the Secret Service (GNOME Keyring or KWallet), encrypted on disk, never in `~/.gentle-dot`. In Passwords and Keys (Seahorse) they show as "Gentle Dot connector: …" in the login keyring. Connector approvals and connector changes go through the app's own dialogs, which the assistant cannot answer.
- **Limit on Linux:** while the keyring is unlocked (usually your whole session), any program running as your user can read those items, including commands the assistant runs in its shell (for example `secret-tool lookup service dev.gentleman.gentle-dot.connectors account <id>`). The Secret Service has no way to restrict which program reads an item. On macOS the Keychain lets only the signed app read them without asking; on Linux, protect the secrets by keeping the keyring locked when you are away and by connecting only the accounts you want the assistant to use.
- Without a keyring (no Secret Service in the session, common on minimal window-manager setups), connectors that need a secret do not run, and nothing is written to disk instead. `~/.gentle-dot/daemon.log` then says `no Secret Service in this desktop session (…); install and unlock a keyring such as GNOME Keyring or KWallet`. Install `gnome-keyring` (or KWallet), make sure it runs and is unlocked in your session, then quit Gentle Dot from the tray and open it again. Gentle Dot checks its connectors with a key kept in the keyring when it starts, so a keyring that was missing then keeps those connectors locked, and the assistant says to restart, until the next start. If the keyring goes away while Gentle Dot runs, the assistant says the keyring is missing. A locked keyring shows its unlock prompt when Gentle Dot starts or a connector needs a secret; dismissing it, or no answer within two minutes, refuses (dismissed at start, connectors that need a secret stay locked until Gentle Dot restarts).
- GNOME: add a custom shortcut that runs `/usr/bin/gentle-dot --toggle` (see docs/linux-testing.md, step 9). Debian needs the AppIndicator extension for the tray icon.
- Hyprland / Omarchy: paste `scripts/linux/hyprland/gentle-dot.lua` (or `.conf`) into your Hyprland config; it already calls `/usr/bin/gentle-dot --toggle`.
- Remove: `sudo apt remove gentle-dot` or `sudo pacman -R gentle-dot` (your data in `~/.gentle-dot` stays).
- Build the packages (needs Docker): `pnpm package:linux --arch <arm64|amd64>` (amd64 also builds the Arch package); check them in clean containers with `pnpm package:linux:check --arch <arm64|amd64>`. `node scripts/package/linux-cargo-check.mjs --arch <arm64|amd64>` runs the desktop crate's tests and clippy on Linux, the keyring store against a real GNOME Keyring on a private session bus, and the app channel checks.
- Developers can still build from source with `scripts/linux/setup-debian.sh` or `scripts/linux/setup-arch.sh` (app at `~/.local/bin/gentle-dot`).

## Windows (port in progress)

A Windows installer can be built from source (below), but it is not released yet: it has not passed the Windows acceptance check that comes before any release. The port lives on the `feat/windows-support` branch of the fork and is tracked in `odd/tasks/windows-support.md`. What already holds:

- Connector secrets (tokens and sign-ins) are kept in the Windows Credential Manager as generic credentials named `dev.gentleman.gentle-dot.connectors/<id>`, each capital letter of the id shown as `^` and the small letter (for example `header/^authorization`) (Control Panel > Credential Manager > Windows Credentials shows them as "Gentle Dot connector: …"), stored on this computer only and encrypted on disk by Windows, never in `%USERPROFILE%\.gentle-dot`. A long sign-in is split over a few more credentials named `…/<id>#<generation>-2`, `-3`, …
- **Limit on Windows:** the Credential Manager has no way to restrict which program reads a credential, so any program running as your Windows user can read those secrets, including commands the assistant runs in its shell. This is the same limit as the Linux keyring; on macOS the Keychain lets only the signed app read them without asking. Connect only the accounts you want the assistant to use.
- A Windows logon that cannot keep credentials (a service or a network logon) makes connectors that need a secret fail closed; nothing is written to disk instead.
- The assistant and everything it starts end with the app, a crash included (they run in a Windows Job that closes with the app). Your Engram memory server is shared with other programs, so it is not in that Job: when none is running, the app starts it (`engram serve` on port 7437, or `ENGRAM_PORT`) before the assistant and leaves it running after quitting, as the memory plugin itself would. An Engram server that is already running is used as it is and never stopped. Private memory (`GENTLE_DOT_ENGRAM=private`) is the assistant's own and ends with it.
- The data folder is `%USERPROFILE%\.gentle-dot` (`HOME` when it is set, or `GENTLE_DOT_DATA_DIR`). The app creates it so that only your Windows user can open it, and every file the assistant writes there (the access token, `connectors.json`, logs, history) gets the same access.
- A data folder that already exists with wider access (an older build, or one made by another program) is not changed silently: the app first shows the folder and the files it would limit, and asks you to **Limit access** or **Cancel**. Cancel is selected by default: pressing Enter without changing the selection, pressing Escape, or closing the dialog refuses the change. The app's own approval dialogs work the same way on Windows: their refusing button is the default, so only choosing the allowing button allows. Cancel changes nothing and the assistant does not start; point `GENTLE_DOT_DATA_DIR` at a new, dedicated folder instead. The app never limits your user folder itself or a drive root; it refuses them without asking.
- **If an older instance blocks adoption:** close the older Gentle Dot instance through its original launcher and close any Explorer windows showing the data folder, then retry. Adoption needs exclusive access. A PID record in a nonprivate folder is not trusted: matching the process ID, creation time and executable path does not prove that the process belongs to Gentle Dot. The app will not stop a process using that record, and filesystem safety refusals remain in force. Do not delete the folder or change permissions to bypass the refusal. After the folder is released, the usual **Limit access** / **Cancel** confirmation still applies. Automatic recovery of legacy instances requires independently verifiable application provenance and is not supported.
- **Limits on Windows:** programs running as your Windows user and administrators can still read the data folder, as on any desktop. Only the folder and the files the app lists change; other files already inside keep their earlier access until the assistant rewrites them. Files outside the data folder, such as your workspace and the attachments saved in it, keep the access of the folder they are in. The data folder has to be on a drive that supports Windows permissions (NTFS); FAT and exFAT drives are refused. Running Gentle Dot as administrator (elevated) makes Windows give the files it creates to the Administrators group, so they are not treated as private and the app refuses to adopt them; run it as your normal user.
- The panel shortcut is `Alt+Space`, as on macOS and Linux; while Gentle Dot holds it, `Alt+Space` no longer opens the window menu of other apps (use the title bar or `Win+Arrow` keys instead). When another program already holds `Alt+Space` (PowerToys Run, for example), the app uses `Ctrl+Alt+Space` for that session and shows it on the tray's Open item and in Settings; `config.json` keeps `Alt+Space`, which is tried again at the next start. Choose another one in Settings to keep it.

### Computer control

Computer control runs on Windows too (see [design.md, S24.10](design.md#computer-control-macos-and-windows-s24)). Windows asks for no permission for computer control; Connectors → Computer shows yolo controls without a permission list. The grant asks to control "this PC", and **Alt+Shift+Esc** is registered at startup as the emergency stop (registration failures are logged). Native task dialogs refuse by default; Enter without changing the selection, Escape, or closing refuses.

Typing requires an app deliberately clicked or opened by the assistant. Before each text chunk and Return, the helper checks that app is still in front and neither the frontmost nor focused app is blocked. A mid-type change stops further input and reports how many characters were already sent; screenshots never authorize typing. A tiny check-to-`SendInput` race remains because Windows input cannot target a window.

`open_app` can open Microsoft Store apps by their localized name (for example, **Calculadora** on Spanish Windows). After running apps, Start-menu shortcuts, App Paths and PATH, it looks in Windows AppsFolder. Names must match exactly apart from case and surrounding whitespace; ambiguous names are refused. It does not accept AUMIDs or `shell:` commands. Blocked packages, including Settings under a localized name, are refused before launch. An opened app grants typing authority only when its native app-window identity is verified. Requests `calc` and `calc.exe` that resolve to the Windows System32/SysWOW64 compatibility launcher instead activate the installed AppsFolder package with AUMID prefix `Microsoft.WindowsCalculator_`, regardless of its localized display name. This is the only mapped stub; other programs keep their existing resolution. If Calculator is not installed or AppsFolder cannot be read, the original launcher route remains and cannot authorize typing into an unrelated foreground.

Elevated apps cannot be driven under Windows UIPI. Apps Windows cannot identify, including Store frames without a core window, are refused. UI Automation uses a 0.5 s timeout, not a hard deadline for the whole action; unreadable elements can require more confirmations, and read-only documents count as text areas. The glow and working top-edge line run on Windows; after a call, the Dot and panel return without taking keyboard focus.

The Dot and panel (including the session Stop banner) are hidden during each action, not merely excluded from capture. Windows preparation uses a native hide as well as the framework hide, so repeated calls work after focus-free restoration. If another own window covers a point, no input is sent: `That point is covered by Gentle Dot's own window, which screenshots do not show. Choose a visible point elsewhere; nothing was sent.` Do not retry the same covered point; choose a visible point elsewhere. The glow remains click-through; the own-UI security rule is unchanged.

### Voice input

On the `feat/windows-voice` feature branch, Windows local voice uses WASAPI recording and Parakeet transcription on this computer. Download the optional **487 MB** local voice model on demand in Settings before using local voice; Windows has no built-in Apple Speech fallback. The Windows port still needs live microphone and installed-app acceptance before release.

Voice status reads the Windows microphone privacy switches, so the voice button explains a denial before you record. If it reports that access is off, open **Windows Settings → Privacy & security → Microphone** (Windows 10: **Privacy → Microphone**) and enable **Microphone access** and **Let desktop apps access your microphone**, then try again. If a Windows policy on the PC turns microphone access off for apps, the button says so and only an administrator can change it. Gentle Dot does not open Settings automatically. A missing microphone is reported separately from an interrupted recording (for example, a disconnected device).

The OpenAI **API-key** path is unchanged: when connected, the panel records through the webview and sends audio to OpenAI for transcription. ChatGPT sign-in alone is not an API key. Local capture tests do not prove webview recording, cloud transcription, or live Windows microphone success.

### Install, upgrade and uninstall

Run `Gentle Dot_<version>_x64-setup.exe` to install. Before upgrading or uninstalling a recognized installation (app executable and `runtime/MANIFEST.json` present), the installer stops the app and its bundled Node/Engram processes and removes the old runtime, including stale modules from earlier versions. Junctions inside the runtime, or a runtime that is itself a junction, are removed without deleting their targets. An upgrade creates a new local runtime rather than preserving a redirected runtime.

If another program keeps files locked or cleanup fails, installation/uninstallation stops; close programs using the runtime and retry. Silent mode returns a nonzero exit code on cleanup failure. Cleanup can already have removed some runtime files before that failure; rerun the installer to repair the installation. This cleanup does not change your app data or WebView2 profile; the uninstaller's option to delete app data is unchanged.

### Build the installer from source

On Windows 10/11 x64 with Node (the version in `.nvmrc`), pnpm, Rust for the MSVC target (`rustc` on `PATH`), Visual Studio Build Tools with the C++ workload, Go 1.25.10 or newer and git on `PATH`, and network access to the npm registry (staging prepares the engine's companions, see below):

```sh
pnpm install
pnpm package:win                 # stages the runtime, then builds the installer
pnpm package:win --skip-stage    # reuses build/runtime/win32-x64
```

The command stages the runtime (`build/runtime/win32-x64`), loads the Visual Studio x64 build environment itself, builds the release app, and writes a per-user NSIS installer (no administrator needed; it installs to `%LOCALAPPDATA%\Gentle Dot`) to `apps/desktop/src-tauri/target/release/bundle/nsis/`. It then checks the result without installing it: the app's embedded Windows manifest, every staged runtime file in the bundle, and the installer's size and SHA-256. The NSIS tools the bundler downloads are kept in `apps/desktop/src-tauri/target/.tauri`, not in `%LOCALAPPDATA%\tauri`.

Go is needed because gentle-pi has no Windows release of its Gentle AI binary and builds it from source while the runtime is staged. That build is checked against the Go checksum database (SumDB), not against a pinned binary hash as on macOS and Linux, and it is not reproducible: each staging produces a binary with a different SHA-256.

**Maintainer note — dependency compatibility:** the staged runtime pins `@earendil-works/pi-codemode` to `1.0.4` alongside the `1.0.4` engine. A fresh npm install must not select a newer transitive version: a semver-compatible package can still remove exports the engine imports. Staging imports the engine with the bundled Node after dependency installation and fails before packaging if that graph cannot load.

**Maintainer note — prepared companions:** gentle-shell normally installs its companion packages into a new engine home on its first run, downloading the latest gentle-pi and, on Windows, building Gentle AI from source with Go and git. The installed app does not rely on that. When the runtime carries `companions/agent-home` and its `companions/manifest.json`, the daemon copies that prepared home into a fresh `<data>/agent` before the engine first starts, then records the home as provisioned in `<data>/home/.gentle-shell/config.json`, the record gentle-shell reads to skip its own setup. The daemon refuses companions made for a different gentle-pi or Gentle AI version, a template that contains a link, a home that is already set up or provisioned, a home the user chose, and conflicting files already in the home. The one exception is a regular `.gentle-shell-home` ownership marker at both ends: the daemon preserves the destination's marker instead of copying the template's. Preflight refusals leave existing files unchanged and log one `companions: not used: …` line. A copy or provisioning-record write failure can leave copied files behind, but never records a successful preparation; a later start may skip that populated home and let gentle-shell run its own setup (including downloads). This recovery limitation still needs installed acceptance. Without packaged companions (a source checkout) it does nothing.

Staging the `win32-x64` runtime makes those companions (`scripts/package/companions.mjs`, called by `stage-runtime.mjs` right after the staged-engine import check). It runs a real `gentle-shell --home <dir> setup` of the staged gentle-pi with the staged Node inside a throwaway sandbox under `.cache/package/companions-setup-*`, which it removes afterwards whether setup succeeds or fails. The setup gets a fresh environment, not the maintainer's: profile, temp, npm cache, npm config and prefix, gentle-shell config, Gentle AI config and Engram data folders all point inside the sandbox; PATH holds only the staged Node, git and the system folders; telemetry and self-update are off (`DO_NOT_TRACK=1`, `GENTLE_AI_TELEMETRY=0`, `GENTLE_AI_NO_SELF_UPDATE=1`); gentle-pi's Go build of Gentle AI is skipped (`GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1`); and gentle-shell's own auto-setup is off. Setup installs the registry's latest companions, so staging then reinstalls each at the version the runtime pins (`COMPANION_VERSIONS` in `scripts/package/lib.mjs`: `gentle-engram` 0.4.2, `pi-btw` 0.8.0, `pi-web-access` 0.41.0) with `gentle-shell --home <dir> install npm:<name>@<version>`, with npm saving exact versions (`npm_config_save_exact=true`). Staging accepts the resulting home only when its `settings.json` parses, it has `npm/` with no leftover `gentle-pi` (a leftover means a gentle-pi version mismatch), it contains no link or junction, no script, shim or JSON file names the sandbox's path, and the pins hold: `settings.json` lists each companion only as `npm:<name>@<version>`, `npm/package.json` asks for that exact version, the lockfile records it installed, and no unpinned companion is installed beside them. A later registry version is refused, never shipped; changing a companion version means editing the pins. It then copies the home to `runtime/companions/agent-home` and writes `runtime/companions/manifest.json` (the staged gentle-pi's version and its pinned Gentle AI version) last; any failure, or a setup or pinned-install call that runs over 20 minutes (up to four separate calls), fails staging and leaves no `companions` folder. The companion versions are printed and recorded under `versions.companions` in `MANIFEST.json`. Staging Windows therefore needs network access to the npm registry and git on PATH. macOS and Linux runtimes carry no companions yet.

**Maintainer note — bundled startup:** Windows canonical paths can contain the `\\?\` drive prefix. Node 24.14.1 rejects that form as its main script with `EISDIR: illegal operation on a directory, lstat 'C:'`, before the daemon starts. Both build-time and bundled launch paths remove that drive prefix at the Node boundary; UNC paths and explicit executable/script overrides remain unchanged. Keep the bundled-launch regression in `daemon.rs` when changing resource-path resolution. An installer build alone does not prove that its daemon starts: verify the installed app with a fresh, separate `GENTLE_DOT_DATA_DIR`, not the user's real data folder.
