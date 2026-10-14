# Installing Gentle Dot

Gentle Dot ships as a self-contained app: it carries its own Node runtime, the assistant engine, and a fallback Engram. Nothing else needs to be installed first.

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

There is no Windows installer yet; the port lives on the `feat/windows-support` branch of the fork and is tracked in `odd/tasks/windows-support.md`. What already holds:

- Connector secrets (tokens and sign-ins) are kept in the Windows Credential Manager as generic credentials named `dev.gentleman.gentle-dot.connectors/<id>`, each capital letter of the id shown as `^` and the small letter (for example `header/^authorization`) (Control Panel > Credential Manager > Windows Credentials shows them as "Gentle Dot connector: …"), stored on this computer only and encrypted on disk by Windows, never in `%USERPROFILE%\.gentle-dot`. A long sign-in is split over a few more credentials named `…/<id>#<generation>-2`, `-3`, …
- **Limit on Windows:** the Credential Manager has no way to restrict which program reads a credential, so any program running as your Windows user can read those secrets, including commands the assistant runs in its shell. This is the same limit as the Linux keyring; on macOS the Keychain lets only the signed app read them without asking. Connect only the accounts you want the assistant to use.
- A Windows logon that cannot keep credentials (a service or a network logon) makes connectors that need a secret fail closed; nothing is written to disk instead.
- The assistant and everything it starts end with the app, a crash included (they run in a Windows Job that closes with the app). Your Engram memory server is shared with other programs, so it is not in that Job: when none is running, the app starts it (`engram serve` on port 7437, or `ENGRAM_PORT`) before the assistant and leaves it running after quitting, as the memory plugin itself would. An Engram server that is already running is used as it is and never stopped. Private memory (`GENTLE_DOT_ENGRAM=private`) is the assistant's own and ends with it.
- The data folder is `%USERPROFILE%\.gentle-dot` (`HOME` when it is set, or `GENTLE_DOT_DATA_DIR`). The app creates it so that only your Windows user can open it, and every file the assistant writes there (the access token, `connectors.json`, logs, history) gets the same access.
- A data folder that already exists with wider access (an older build, or one made by another program) is not changed silently: the app first shows the folder and the files it would limit, and asks you to **Limit access** or **Cancel**. Cancel changes nothing and the assistant does not start; point `GENTLE_DOT_DATA_DIR` at a new, dedicated folder instead. The app never limits your user folder itself or a drive root; it refuses them without asking.
- **Limits on Windows:** programs running as your Windows user and administrators can still read the data folder, as on any desktop. Only the folder and the files the app lists change; other files already inside keep their earlier access until the assistant rewrites them. Files outside the data folder, such as your workspace and the attachments saved in it, keep the access of the folder they are in. The data folder has to be on a drive that supports Windows permissions (NTFS); FAT and exFAT drives are refused. Running Gentle Dot as administrator (elevated) makes Windows give the files it creates to the Administrators group, so they are not treated as private and the app refuses to adopt them; run it as your normal user.
