# T1 spike: the app channel on Windows

Throwaway proof for `odd/tasks/windows-support.md` T1 (results in its Log, L8). Not part of the build.

- `src/main.rs` plays the desktop app: it creates a single-instance named pipe (owner-only DACL, `PIPE_REJECT_REMOTE_CLIENTS`), connects to it, checks the client is itself, and spawns `node daemon.mjs` with the client end as CRT fd 3 (`lpReserved2`) and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. Before that it spawns a control child with plain handle inheritance, which must leak.
- `daemon.mjs` plays the daemon: it opens fd 3 with `net.Socket`, then spawns grandchildren with `spawn`, `spawnSync`, and `cmd /c`; each tries to write `LEAK` into the inherited handle value.

Run on Windows from this folder:

```sh
cargo build --offline
./target/debug/spike-t1.exe "$(cygpath -w "$(which node)")" "$(cygpath -w "$PWD/daemon.mjs")"
```

Expected: `clientPidIsMe=true`, `secondOpenRefused=true (error 231)`, `controlLeakDetected=true`, `daemonChildLeaks=[]`, every grandchild `"valid":false`, and `daemonExitedOnClose=true exitCode=0`.
