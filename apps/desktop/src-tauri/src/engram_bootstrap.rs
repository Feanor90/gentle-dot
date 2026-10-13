//! Windows: the user's shared memory server (Engram) is started by the app, outside the daemon's
//! Job (T5, S6).
//!
//! The daemon and everything it starts live in a Job that ends with the app (`win_spawn`). The
//! engine's memory plugin starts `engram serve` itself when no server answers on its port, and a
//! server started from inside that Job would end with the app too, cutting off every other program
//! that shares it. So before the daemon starts, the app makes sure something listens on the memory
//! port: when nothing does, it starts the server itself, outside the Job, with the same data folder
//! the daemon will hand the engine (`GENTLE_DOT_ENGRAM_DATA_DIR`), so the plugin finds a server of
//! its own instance and attaches. A server that already listens is never adopted or stopped here:
//! the plugin checks its identity and refuses a foreign one. Private memory
//! (`GENTLE_DOT_ENGRAM=private`) is the daemon's own and is meant to end with it, and an explicit
//! `ENGRAM_URL` names a server the user manages: neither is started here.

use crate::daemon::LaunchSpec;
use crate::win_spawn::{resolve, spawn_outside_job, Spawn};
use std::fs::File;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The memory plugin's port when `ENGRAM_PORT` is not set.
pub const DEFAULT_PORT: u16 = 7437;

/// How long the app waits for a server it started to listen.
pub const START_TIMEOUT: Duration = Duration::from_secs(10);

/// The shared memory server the engine will use: its port, its data folder, and how to start it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedMemory {
    pub port: u16,
    pub data_dir: PathBuf,
    pub server: LaunchSpec,
}

/// What [`ensure`] found or did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Something already listens on the port; the plugin checks whose it is.
    Listening,
    /// The app started the server (this pid), outside the daemon's Job; it outlives the app.
    Started(u32),
    /// Nothing was started; the plugin will try on its own.
    NotStarted(String),
}

/// The shared memory server for `env`, or `None` when the app must not start one: private memory,
/// an explicit `ENGRAM_URL`, a port that is not a number, no home folder, or no `engram` to run.
/// The data folder follows the daemon's own choice (`isolation.ts`): `GENTLE_DOT_ENGRAM_DATA_DIR`,
/// `ENGRAM_DATA_DIR`, then `<home>/.engram`. The binary: `ENGRAM_BIN`, `engram` on the PATH, then
/// the bundled runtime's.
pub fn shared_memory(env: impl Fn(&str) -> Option<String>, runtime: Option<&Path>) -> Option<SharedMemory> {
    let get = |key: &str| env(key).filter(|value| !value.is_empty());
    if get("GENTLE_DOT_ENGRAM").as_deref() == Some("private") || get("ENGRAM_URL").is_some() {
        return None;
    }
    let port = match get("ENGRAM_PORT") {
        Some(value) => value.parse().ok().filter(|port| *port != 0)?,
        None => DEFAULT_PORT,
    };
    let data_dir = match get("GENTLE_DOT_ENGRAM_DATA_DIR").or_else(|| get("ENGRAM_DATA_DIR")) {
        Some(dir) => PathBuf::from(dir),
        None => Path::new(&get("HOME").or_else(|| get("USERPROFILE"))?).join(".engram"),
    };
    let program = get("ENGRAM_BIN")
        .or_else(|| resolve("engram", None).ok().map(|path| path.display().to_string()))
        .or_else(|| {
            let bundled = runtime?.join("bin").join("engram.exe");
            bundled.is_file().then(|| bundled.display().to_string())
        })?;
    let envs = vec![
        ("ENGRAM_DATA_DIR".to_string(), data_dir.display().to_string()),
        ("ENGRAM_PORT".to_string(), port.to_string()),
        // Like the memory plugin's own start: cloud autosync on, skipped by the server when unset up.
        ("ENGRAM_CLOUD_AUTOSYNC".to_string(), "1".to_string()),
    ];
    Some(SharedMemory { port, data_dir, server: LaunchSpec { program, args: vec!["serve".into()], envs } })
}

/// Makes sure something listens on the memory port: when nothing does, starts the server outside
/// the daemon's Job and waits up to `timeout` for it to listen. Never stops a server.
pub fn ensure(memory: &SharedMemory, timeout: Duration) -> Outcome {
    if listening(memory.port) {
        return Outcome::Listening;
    }
    let server = &memory.server;
    let not_started = |why: String| Outcome::NotStarted(format!("the memory server {} was not started: {why}", server.program));
    // Its output is not the app's to keep: the server writes its own logs under its data folder.
    let nul = match File::options().write(true).open("NUL") {
        Ok(nul) => nul,
        Err(error) => return not_started(error.to_string()),
    };
    let spawn = Spawn { program: &server.program, args: &server.args, envs: &server.envs };
    let mut child = match spawn_outside_job(&spawn, &nul) {
        Ok(child) => child,
        Err(error) => return not_started(error.to_string()),
    };
    use crate::daemon::ChildProcess;
    let deadline = Instant::now() + timeout;
    loop {
        if listening(memory.port) {
            return Outcome::Started(child.id());
        }
        if !matches!(child.try_wait(), Ok(None)) {
            return not_started("it ended before it listened".into());
        }
        if Instant::now() >= deadline {
            // Left running: it may be slow to start, and the plugin attaches to it once it listens.
            return not_started(format!("it did not listen on port {} in time", memory.port));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Whether something accepts connections on `127.0.0.1:<port>`.
fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(300)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::TcpListener;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |key| map.get(key).cloned()
    }

    const BIN: (&str, &str) = ("ENGRAM_BIN", r"C:\tools\engram.exe");

    #[test]
    fn private_memory_and_an_explicit_url_are_never_started_by_the_app() {
        let home = ("USERPROFILE", r"C:\Users\me");
        assert_eq!(shared_memory(env_of(&[home, BIN, ("GENTLE_DOT_ENGRAM", "private")]), None), None);
        assert_eq!(shared_memory(env_of(&[home, BIN, ("ENGRAM_URL", "http://127.0.0.1:9000")]), None), None);
    }

    /// An `ENGRAM_URL` the user set is never touched, even with a port of its own named.
    #[test]
    fn an_explicit_url_with_a_port_still_starts_nothing() {
        let env = env_of(&[("USERPROFILE", r"C:\u"), BIN, ("ENGRAM_URL", "http://127.0.0.1:1"), ("ENGRAM_PORT", "7500")]);
        assert_eq!(shared_memory(env, None), None);
    }

    #[test]
    fn the_default_is_port_7437_and_the_users_engram_folder() {
        let memory = shared_memory(env_of(&[("USERPROFILE", r"C:\Users\me"), BIN]), None).unwrap();
        assert_eq!(memory.port, 7437);
        assert_eq!(memory.data_dir, Path::new(r"C:\Users\me").join(".engram"));
        assert_eq!(memory.server.program, r"C:\tools\engram.exe");
        assert_eq!(memory.server.args, ["serve"]);
        let envs: HashMap<_, _> = memory.server.envs.iter().cloned().collect();
        assert_eq!(envs["ENGRAM_DATA_DIR"], Path::new(r"C:\Users\me").join(".engram").display().to_string());
        assert_eq!(envs["ENGRAM_PORT"], "7437");
        assert_eq!(envs["ENGRAM_CLOUD_AUTOSYNC"], "1");
    }

    #[test]
    fn the_data_folder_and_port_follow_the_same_variables_as_the_daemon() {
        let base = [("HOME", r"C:\h"), BIN, ("ENGRAM_PORT", "7500"), ("ENGRAM_DATA_DIR", r"D:\engram")];
        let memory = shared_memory(env_of(&base), None).unwrap();
        assert_eq!((memory.port, memory.data_dir), (7500, PathBuf::from(r"D:\engram")));
        let mut chosen = base.to_vec();
        chosen.push(("GENTLE_DOT_ENGRAM_DATA_DIR", r"E:\dot"));
        assert_eq!(shared_memory(env_of(&chosen), None).unwrap().data_dir, PathBuf::from(r"E:\dot"));
        // HOME wins over USERPROFILE, as `HOME || homedir()` does in the daemon.
        let homes = [("HOME", r"C:\h"), ("USERPROFILE", r"C:\Users\me"), BIN];
        assert_eq!(shared_memory(env_of(&homes), None).unwrap().data_dir, Path::new(r"C:\h").join(".engram"));
    }

    #[test]
    fn a_port_that_is_not_a_number_or_no_home_starts_nothing() {
        assert_eq!(shared_memory(env_of(&[("USERPROFILE", r"C:\u"), BIN, ("ENGRAM_PORT", "x")]), None), None);
        assert_eq!(shared_memory(env_of(&[("USERPROFILE", r"C:\u"), BIN, ("ENGRAM_PORT", "0")]), None), None);
        assert_eq!(shared_memory(env_of(&[BIN]), None), None);
    }

    /// A port nothing listens on right now.
    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("gentle-dot-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The test binary standing in for `engram serve`: it listens on `ENGRAM_PORT` and writes what
    /// it was given to `report`.
    fn fake_server(port: u16, data_dir: &Path, report: &Path) -> SharedMemory {
        let mut server = crate::win_spawn::tests::helper_spec("listen");
        server.envs.extend([
            ("ENGRAM_DATA_DIR".to_string(), data_dir.display().to_string()),
            ("ENGRAM_PORT".to_string(), port.to_string()),
            ("ENGRAM_CLOUD_AUTOSYNC".to_string(), "1".to_string()),
            ("GENTLE_DOT_TEST_REPORT".to_string(), report.display().to_string()),
        ]);
        SharedMemory { port, data_dir: data_dir.to_path_buf(), server }
    }

    fn end(pid: u32) {
        let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
    }

    #[test]
    fn when_nothing_listens_the_app_starts_the_server_with_the_daemons_data_folder() {
        let dir = scratch("engram-start");
        let (port, report) = (free_port(), dir.join("report"));
        let memory = fake_server(port, &dir.join("data"), &report);
        let outcome = ensure(&memory, Duration::from_secs(20));
        let Outcome::Started(pid) = outcome else { panic!("not started: {outcome:?}") };
        assert!(listening(port));
        assert_eq!(std::fs::read_to_string(&report).unwrap(), format!("{}|1", dir.join("data").display()));
        // The server is the app's only to start, never to own: dropping everything here leaves it running.
        assert!(crate::daemon::process_started(pid).is_some());
        end(pid);
    }

    #[test]
    fn a_server_that_already_listens_is_left_alone_and_nothing_is_started() {
        let dir = scratch("engram-listening");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut memory = fake_server(port, &dir.join("data"), &dir.join("report"));
        memory.server.program = dir.join("no-such-engram.exe").display().to_string();
        assert_eq!(ensure(&memory, Duration::from_secs(2)), Outcome::Listening);
        assert!(!dir.join("report").exists());
    }

    #[test]
    fn a_missing_binary_starts_nothing_and_reports_why() {
        let dir = scratch("engram-missing");
        let port = free_port();
        let mut memory = fake_server(port, &dir.join("data"), &dir.join("report"));
        memory.server.program = dir.join("no-such-engram.exe").display().to_string();
        let outcome = ensure(&memory, Duration::from_secs(2));
        assert!(matches!(&outcome, Outcome::NotStarted(why) if why.contains("no-such-engram")), "{outcome:?}");
        assert!(!listening(port));
    }
}
