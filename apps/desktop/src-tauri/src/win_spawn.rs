//! Spawns the daemon on Windows with exactly the handles it needs (S25.1, review R3-001): stdin
//! from `NUL`, its output in the log, and, when there is one, the app's channel as CRT fd 3.
//!
//! `std::process::Command` lets the child inherit every inheritable handle of the app. Here the
//! child is created with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, so only the listed handles reach it,
//! whatever else in the app is inheritable. The channel goes in `STARTUPINFO.lpReserved2`, the table
//! the C runtime (and so Node, through libuv) reads its descriptors from: Node opens fd 3 with
//! `new net.Socket({fd: 3})` and clears the handle's inherit flag at startup, so the daemon's own
//! children never get it (proven in the T1 spike, odd/spikes/t1-app-channel-windows).
//!
//! The listed handles are inheritable copies made just before `CreateProcessW` and closed right
//! after it. While they exist, a process another thread of the app spawns with plain inheritance
//! could get them too; the window is that one call. On macOS and Linux the same choice is made in
//! the child itself, with no such window.

use crate::daemon::ChildProcess;
use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::os::windows::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::{mem, ptr};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, HANDLE, TRUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::SystemInformation::{GetSystemDirectoryW, GetWindowsDirectoryW};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess, InitializeProcThreadAttributeList,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

/// The C runtime's flags for an inherited descriptor (`lpReserved2`).
const FOPEN: u8 = 0x01;
const FPIPE: u8 = 0x08;
const FDEV: u8 = 0x40;

/// What to start: a program, its arguments, and the variables set over the app's environment.
pub struct Spawn<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub envs: &'a [(String, String)],
}

/// A process this app started, owned through its process handle.
#[derive(Debug)]
pub struct WinChild {
    process: OwnedHandle,
    pid: u32,
    status: Option<ExitStatus>,
    /// The channel's handle value in the child (an inherited handle keeps its value), for tests.
    #[cfg(test)]
    pub(crate) channel_value: Option<usize>,
}

/// Starts `spawn` without a window, stdin `NUL`, stdout and stderr `log`, `channel` on fd 3, and no
/// other handle of the app.
pub fn spawn(spawn: &Spawn<'_>, log: &File, channel: Option<BorrowedHandle<'_>>) -> io::Result<WinChild> {
    let program = resolve(spawn.program, path_of(spawn.envs).as_deref())?;
    let mut command_line = wide_nul(command_line(spawn.program, spawn.args));
    let environment = environment_block(spawn.envs);
    let application = wide_nul(program.as_os_str());

    let nul = File::options().read(true).write(true).open("NUL")?;
    let nul = inheritable(borrow(&nul))?;
    let out = inheritable(borrow(log))?;
    let channel = channel.map(inheritable).transpose()?;

    let mut listed: Vec<HANDLE> = vec![raw(&nul), raw(&out)];
    listed.extend(channel.as_ref().map(raw));
    let mut attributes = AttributeList::with_handles(&mut listed)?;

    // SAFETY: an all-zero STARTUPINFOEXW is valid.
    let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() };
    startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = raw(&nul);
    startup.StartupInfo.hStdOutput = raw(&out);
    startup.StartupInfo.hStdError = raw(&out);
    startup.lpAttributeList = attributes.as_ptr();
    let mut descriptors = channel.as_ref().map(|channel| {
        crt_descriptors(&[(FOPEN | FDEV, raw(&nul)), (FOPEN, raw(&out)), (FOPEN, raw(&out)), (FOPEN | FPIPE, raw(channel))])
    });
    if let Some(table) = descriptors.as_mut() {
        startup.StartupInfo.cbReserved2 = u16::try_from(table.len()).map_err(io::Error::other)?;
        startup.StartupInfo.lpReserved2 = table.as_mut_ptr();
    }

    // SAFETY: an all-zero PROCESS_INFORMATION is valid.
    let mut info: PROCESS_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: every pointer is valid for the call: NUL-terminated application name, a mutable
    // command line, a double-NUL environment block, a startup info whose attribute list and
    // descriptor table outlive the call.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            TRUE,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            ptr::null(),
            &startup.StartupInfo,
            &mut info,
        )
    };
    let error = io::Error::last_os_error();
    #[cfg(test)]
    let channel_value = channel.as_ref().map(|channel| raw(channel) as usize);
    drop(attributes);
    // The inheritable copies close here; the child holds its own.
    drop((nul, out, channel, descriptors));
    if created == 0 {
        return Err(error);
    }
    // SAFETY: CreateProcessW returned both handles; we keep the process and close the thread.
    unsafe { CloseHandle(info.hThread) };
    // SAFETY: the process handle CreateProcessW returned, now owned.
    let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess as RawHandle) };
    Ok(WinChild {
        process,
        pid: info.dwProcessId,
        status: None,
        #[cfg(test)]
        channel_value,
    })
}

fn borrow(file: &File) -> BorrowedHandle<'_> {
    use std::os::windows::io::AsHandle;
    file.as_handle()
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

/// An inheritable copy of `handle`, for the child only (it is listed in the handle list).
fn inheritable(handle: BorrowedHandle<'_>) -> io::Result<OwnedHandle> {
    let mut copy: HANDLE = ptr::null_mut();
    // SAFETY: duplicating a handle we hold within this process.
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle.as_raw_handle() as HANDLE,
            GetCurrentProcess(),
            &mut copy,
            0,
            TRUE,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: DuplicateHandle returned a handle we now own.
    Ok(unsafe { OwnedHandle::from_raw_handle(copy as RawHandle) })
}

/// A `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` over `handles`, which must outlive it.
struct AttributeList {
    buffer: Vec<usize>,
}

impl AttributeList {
    fn with_handles(handles: &mut [HANDLE]) -> io::Result<Self> {
        let mut size = 0usize;
        // SAFETY: a size query for one attribute.
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size) };
        let mut list = AttributeList { buffer: vec![0usize; size.div_ceil(mem::size_of::<usize>())] };
        // SAFETY: the buffer holds `size` bytes, aligned for the list.
        if unsafe { InitializeProcThreadAttributeList(list.as_ptr(), 1, 0, &mut size) } == 0 {
            list.buffer.clear();
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the list was initialized above; `handles` outlives the list (the caller keeps it).
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list.as_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_mut_ptr().cast(),
                mem::size_of_val(handles),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        if updated == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(list)
    }

    fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            // SAFETY: the list was initialized in `with_handles`.
            unsafe { DeleteProcThreadAttributeList(self.as_ptr()) };
        }
    }
}

/// The C runtime's inherited-descriptor table: a count, one flag byte per descriptor, then the
/// handles (pointer-sized, unaligned).
fn crt_descriptors(descriptors: &[(u8, HANDLE)]) -> Vec<u8> {
    let mut table = Vec::new();
    table.extend_from_slice(&(descriptors.len() as i32).to_le_bytes());
    table.extend(descriptors.iter().map(|(flags, _)| *flags));
    for (_, handle) in descriptors {
        table.extend_from_slice(&(*handle as usize).to_le_bytes());
    }
    table
}

/// `program` and `args` quoted the way the C runtime splits a command line.
pub fn command_line(program: &str, args: &[String]) -> String {
    let mut line = String::new();
    quote(program, &mut line);
    for arg in args {
        line.push(' ');
        quote(arg, &mut line);
    }
    line
}

fn quote(arg: &str, line: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        line.push_str(arg);
        return;
    }
    line.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                line.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                line.push('"');
                backslashes = 0;
            }
            _ => {
                line.extend(std::iter::repeat_n('\\', backslashes));
                line.push(c);
                backslashes = 0;
            }
        }
    }
    line.extend(std::iter::repeat_n('\\', backslashes * 2));
    line.push('"');
}

fn wide_nul(text: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain(Some(0)).collect()
}

/// The `PATH` the spawn sets, if it sets one.
fn path_of(envs: &[(String, String)]) -> Option<String> {
    envs.iter().rev().find(|(key, _)| key.eq_ignore_ascii_case("PATH")).map(|(_, value)| value.clone())
}

/// The program to run. A bare name is looked up the way `std::process::Command` does, never in the
/// current folder: the spawn's `PATH`, the system folders, then the app's `PATH`; `.exe` is added
/// when it has no extension.
pub fn resolve(program: &str, child_path: Option<&str>) -> io::Result<PathBuf> {
    let given = Path::new(program);
    if given.is_absolute() || given.components().count() > 1 {
        return Ok(given.to_path_buf());
    }
    let name = if given.extension().is_some() { program.to_string() } else { format!("{program}.exe") };
    let mut folders: Vec<PathBuf> = child_path.map(|path| std::env::split_paths(path).collect()).unwrap_or_default();
    folders.extend(system_folders());
    if let Some(path) = std::env::var_os("PATH") {
        folders.extend(std::env::split_paths(&path));
    }
    folders
        .into_iter()
        .filter(|folder| folder.is_absolute())
        .map(|folder| folder.join(&name))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{program} was not found")))
}

fn system_folders() -> Vec<PathBuf> {
    let mut folders = Vec::new();
    for get in [GetSystemDirectoryW, GetWindowsDirectoryW] {
        let mut buffer = [0u16; 512];
        // SAFETY: the buffer holds 512 units.
        let len = unsafe { get(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if len > 0 && len < buffer.len() {
            use std::os::windows::ffi::OsStringExt;
            folders.push(PathBuf::from(OsString::from_wide(&buffer[..len])));
        }
    }
    folders
}

/// The app's environment with `envs` set over it (names compare without case, as Windows does),
/// sorted, as a double-NUL-terminated UTF-16 block.
fn environment_block(envs: &[(String, String)]) -> Vec<u16> {
    let mut vars: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    for (key, value) in envs {
        vars.retain(|(existing, _)| !existing.eq_ignore_ascii_case(key));
        vars.push((key.into(), value.into()));
    }
    vars.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in vars {
        block.extend(key.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

impl WinChild {
    fn raw(&self) -> HANDLE {
        self.process.as_raw_handle() as HANDLE
    }

    fn exit_status(&mut self) -> io::Result<ExitStatus> {
        let mut code = 0u32;
        // SAFETY: our process handle and a valid out-pointer.
        if unsafe { GetExitCodeProcess(self.raw(), &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let status = ExitStatus::from_raw(code);
        self.status = Some(status);
        Ok(status)
    }
}

impl ChildProcess for WinChild {
    fn id(&self) -> u32 {
        self.pid
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if let Some(status) = self.status {
            return Ok(Some(status));
        }
        // SAFETY: our process handle; a zero timeout only polls.
        match unsafe { WaitForSingleObject(self.raw(), 0) } {
            WAIT_OBJECT_0 => self.exit_status().map(Some),
            _ => Ok(None),
        }
    }

    /// Ends the process unless it already ended.
    fn kill(&mut self) -> io::Result<()> {
        if self.try_wait()?.is_some() {
            return Ok(());
        }
        // SAFETY: our process handle, which keeps the pid from being reused.
        if unsafe { TerminateProcess(self.raw(), 1) } == 0 {
            // SAFETY: no preconditions.
            let error = unsafe { GetLastError() };
            if self.try_wait()?.is_none() {
                return Err(io::Error::from_raw_os_error(error as i32));
            }
        }
        Ok(())
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        if let Some(status) = self.status {
            return Ok(status);
        }
        // SAFETY: our process handle.
        if unsafe { WaitForSingleObject(self.raw(), INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        self.exit_status()
    }
}

/// The test binary doubles as a child process the tests start (`helper_spec`): it is this module's
/// ignored test `child_helper`, run alone, told what to do by `GENTLE_DOT_TEST_CHILD`.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::daemon::LaunchSpec;
    use crate::win_pipe::{private_pair, PipeStream};
    use std::io::{BufRead, BufReader, Write};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::GetHandleInformation;
    use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;

    const MODE: &str = "GENTLE_DOT_TEST_CHILD";

    /// The test binary as a child, in `mode`: `fd3` answers one line on fd 3 with what fd 3 is,
    /// `echo` answers every request on fd 3 like a daemon, `handle:<value>:<path>` reports whether
    /// the handle `<value>` is open on `<path>` in the child, `pipe:<value>:<pid>` whether it is an
    /// end of a pipe served by `<pid>` (the app's channel), `stdio` prints a line on stdout and
    /// stderr, and `sleep` waits 30 s.
    pub(crate) fn helper_spec(mode: &str) -> LaunchSpec {
        LaunchSpec {
            program: std::env::current_exe().unwrap().display().to_string(),
            args: ["win_spawn::tests::child_helper", "--exact", "--ignored", "--nocapture", "--test-threads=1", "-q"]
                .map(String::from)
                .to_vec(),
            envs: vec![(MODE.into(), mode.into())],
        }
    }

    /// The path a handle is open on, if `handle` is an open file handle in this process.
    fn path_of_handle(handle: HANDLE) -> Option<String> {
        let mut buffer = [0u16; 1024];
        // SAFETY: the buffer holds 1024 units; an invalid handle fails.
        let len = unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, FILE_NAME_NORMALIZED) };
        (len > 0 && (len as usize) < buffer.len()).then(|| String::from_utf16_lossy(&buffer[..len as usize]))
    }

    extern "C" {
        fn _set_invalid_parameter_handler(handler: Option<InvalidParameter>) -> Option<InvalidParameter>;
    }
    type InvalidParameter = extern "C" fn(*const u16, *const u16, *const u16, u32, usize);
    extern "C" fn ignore_invalid_parameter(_: *const u16, _: *const u16, _: *const u16, _: u32, _: usize) {}

    /// fd 3 of the C runtime, as a stream, when it is open. The C runtime keeps owning the handle:
    /// the stream is never dropped, so it never closes it.
    fn fd3() -> Option<std::mem::ManuallyDrop<PipeStream>> {
        // An fd the C runtime never opened is an invalid parameter, which aborts by default; with
        // this handler `_get_osfhandle` returns -1 instead.
        // SAFETY: installs a handler that does nothing, for this short-lived child.
        unsafe { _set_invalid_parameter_handler(Some(ignore_invalid_parameter)) };
        // SAFETY: _get_osfhandle has no preconditions; a closed fd gives -1.
        let handle = unsafe { libc::get_osfhandle(3) };
        (handle != -1 && handle != -2).then(|| {
            // SAFETY: fd 3's handle, wrapped without ever being closed (ManuallyDrop).
            std::mem::ManuallyDrop::new(PipeStream::from_owned(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
        })
    }

    /// Whether `handle` is, in this process, an end of a pipe whose server is the process `server`.
    fn holds_pipe_of(handle: HANDLE, server: u32) -> bool {
        let mut flags = 0u32;
        let mut owner = 0u32;
        // SAFETY: queries on a handle value; an invalid one fails.
        unsafe { GetHandleInformation(handle, &mut flags) != 0 && GetNamedPipeServerProcessId(handle, &mut owner) != 0 && owner == server }
    }

    #[test]
    #[ignore = "a child process the other tests start"]
    fn child_helper() {
        let Ok(mode) = std::env::var(MODE) else { return };
        match mode.as_str() {
            "fd3" => match fd3() {
                Some(channel) => {
                    let mut line = String::new();
                    BufReader::new(channel.try_clone().unwrap()).read_line(&mut line).unwrap();
                    (&*channel).write_all(format!("pipe {line}").as_bytes()).unwrap();
                }
                None => println!("fd3 none"),
            },
            "echo" => {
                let channel = fd3().expect("a channel on fd 3");
                let mut reader = BufReader::new(channel.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let value: serde_json::Value = serde_json::from_str(&line).unwrap();
                    let id = &value["id"];
                    let answer = format!("{{\"kind\":\"response\",\"id\":{id},\"result\":{{\"echo\":{id}}}}}\n");
                    (&*channel).write_all(answer.as_bytes()).unwrap();
                    line.clear();
                }
            }
            "stdio" => {
                println!("to stdout");
                eprintln!("to stderr");
            }
            "sleep" => std::thread::sleep(Duration::from_secs(30)),
            probe if probe.starts_with("pipe:") => {
                let (value, server) = probe["pipe:".len()..].split_once(':').unwrap();
                let held = holds_pipe_of(value.parse::<usize>().unwrap() as HANDLE, server.parse().unwrap());
                println!("probe {}", if held { "leaked" } else { "closed" });
            }
            probe => {
                let (value, path) = probe.strip_prefix("handle:").and_then(|rest| rest.split_once(':')).unwrap();
                let handle = value.parse::<usize>().unwrap() as HANDLE;
                let held = path_of_handle(handle).is_some_and(|open| open.eq_ignore_ascii_case(path));
                println!("probe {}", if held { "leaked" } else { "closed" });
            }
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("gentle-dot-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run(spec: &LaunchSpec, log: &File, channel: Option<BorrowedHandle<'_>>) -> WinChild {
        spawn(&Spawn { program: &spec.program, args: &spec.args, envs: &spec.envs }, log, channel).unwrap()
    }

    #[test]
    fn the_child_gets_its_end_of_the_channel_on_fd_3() {
        let dir = scratch("win-fd3");
        let log = File::create(dir.join("log")).unwrap();
        let (app, daemon_end) = private_pair().unwrap();
        let mut child = run(&helper_spec("fd3"), &log, Some(daemon_end.as_handle_borrowed()));
        drop(daemon_end);
        (&app).write_all(b"ping\n").unwrap();
        let mut line = String::new();
        BufReader::new(app.try_clone().unwrap()).read_line(&mut line).unwrap();
        assert_eq!(line, "pipe ping\n", "{}", std::fs::read_to_string(dir.join("log")).unwrap_or_default());
        assert!(child.wait().unwrap().success());
        // Once the child is gone, nothing else holds the other end.
        line.clear();
        assert_eq!(BufReader::new(app.try_clone().unwrap()).read_line(&mut line).unwrap(), 0);
    }

    #[test]
    fn without_a_channel_fd_3_is_closed_in_the_child() {
        let dir = scratch("win-fd3-none");
        let log = File::create(dir.join("log")).unwrap();
        let mut child = run(&helper_spec("fd3"), &log, None);
        assert!(child.wait().unwrap().success());
        assert!(std::fs::read_to_string(dir.join("log")).unwrap().contains("fd3 none"));
    }

    #[test]
    fn stdout_and_stderr_go_to_the_log() {
        let dir = scratch("win-stdio");
        let log = File::create(dir.join("log")).unwrap();
        let mut child = run(&helper_spec("stdio"), &log, None);
        assert!(child.wait().unwrap().success());
        let text = std::fs::read_to_string(dir.join("log")).unwrap();
        assert!(text.contains("to stdout") && text.contains("to stderr"), "{text}");
    }

    /// A handle some library of the app made inheritable, and what a child started each way sees.
    fn stray_reaches(by_std: bool) -> String {
        let dir = scratch(if by_std { "win-stray-std" } else { "win-stray" });
        let target = dir.join("stray");
        let stray_file = File::create(&target).unwrap();
        let stray = inheritable(borrow(&stray_file)).unwrap();
        let path = path_of_handle(raw(&stray)).unwrap();
        let mode = format!("handle:{}:{path}", raw(&stray) as usize);
        let log_path = dir.join("log");
        let log = File::create(&log_path).unwrap();
        let spec = helper_spec(&mode);
        if by_std {
            let status = std::process::Command::new(&spec.program)
                .args(&spec.args)
                .envs(spec.envs.iter().map(|(k, v)| (k, v)))
                .stdout(log.try_clone().unwrap())
                .status()
                .unwrap();
            assert!(status.success());
        } else {
            let (_app, daemon_end) = private_pair().unwrap();
            assert!(run(&spec, &log, Some(daemon_end.as_handle_borrowed())).wait().unwrap().success());
        }
        drop(stray);
        std::fs::read_to_string(log_path).unwrap()
    }

    #[test]
    fn no_other_handle_of_the_app_reaches_the_child() {
        assert!(stray_reaches(false).contains("probe closed"));
    }

    #[test]
    fn the_stray_handle_probe_sees_a_leak_when_there_is_one() {
        // `std::process::Command` inherits every inheritable handle: the probe must see it.
        assert!(stray_reaches(true).contains("probe leaked"));
    }

    /// What a child started by `std::process::Command` sees of an inheritable copy of the channel's
    /// end: the control for the `pipe:` probe the daemon's grandchildren run (daemon.rs).
    #[test]
    fn the_channel_probe_sees_a_child_that_holds_the_pipe() {
        let dir = scratch("win-pipe-probe");
        let (_app, daemon_end) = private_pair().unwrap();
        let leaked = inheritable(daemon_end.as_handle_borrowed()).unwrap();
        let me = std::process::id();
        let probe = |value: usize| {
            let log = File::create(dir.join("log")).unwrap();
            let spec = helper_spec(&format!("pipe:{value}:{me}"));
            let status = std::process::Command::new(&spec.program)
                .args(&spec.args)
                .envs(spec.envs.iter().map(|(k, v)| (k, v)))
                .stdout(log)
                .status()
                .unwrap();
            assert!(status.success());
            std::fs::read_to_string(dir.join("log")).unwrap()
        };
        assert!(probe(raw(&leaked) as usize).contains("probe leaked"));
        // A value that is no pipe of this app reads as closed.
        let other = File::create(dir.join("other")).unwrap();
        let not_a_pipe = inheritable(borrow(&other)).unwrap();
        assert!(probe(raw(&not_a_pipe) as usize).contains("probe closed"));
    }

    #[test]
    fn the_crt_table_is_a_count_flags_then_pointer_sized_handles() {
        let table = crt_descriptors(&[(FOPEN, 1 as HANDLE), (FOPEN | FPIPE, 2 as HANDLE)]);
        let width = mem::size_of::<usize>();
        assert_eq!(table.len(), 4 + 2 + 2 * width);
        assert_eq!(&table[..4], &2i32.to_le_bytes());
        assert_eq!(&table[4..6], &[FOPEN, FOPEN | FPIPE]);
        assert_eq!(&table[6..6 + width], &1usize.to_le_bytes());
        assert_eq!(&table[6 + width..], &2usize.to_le_bytes());
    }

    #[test]
    fn kill_ends_a_running_child_and_try_wait_reports_it() {
        let dir = scratch("win-kill");
        let log = File::create(dir.join("log")).unwrap();
        let mut child = run(&helper_spec("sleep"), &log, None);
        assert!(child.try_wait().unwrap().is_none());
        let started = Instant::now();
        child.kill().unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(child.try_wait().unwrap(), Some(status));
        // Killing an ended child is not an error.
        child.kill().unwrap();
    }

    #[test]
    fn a_program_that_does_not_exist_is_not_started() {
        let log = File::create(scratch("win-missing").join("log")).unwrap();
        let spec = Spawn { program: "gentle-dot-no-such-program", args: &[], envs: &[] };
        assert_eq!(spawn(&spec, &log, None).unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn a_bare_name_is_found_on_the_spawns_path_and_never_in_the_current_folder() {
        let dir = scratch("win-resolve");
        std::fs::write(dir.join("tool.exe"), b"").unwrap();
        let path = dir.display().to_string();
        assert_eq!(resolve("tool", Some(&path)).unwrap(), dir.join("tool.exe"));
        assert_eq!(resolve("tool.exe", Some(&path)).unwrap(), dir.join("tool.exe"));
        // A relative folder on PATH (the current folder, for one) is never searched.
        assert!(resolve("tool", Some(".")).is_err());
        assert!(resolve("cmd", None).unwrap().ends_with("cmd.exe"));
        assert_eq!(resolve(r"C:\x\y.exe", None).unwrap(), PathBuf::from(r"C:\x\y.exe"));
    }

    #[test]
    fn arguments_are_quoted_the_way_the_c_runtime_splits_them() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(command_line("node", &args(&["a", "b c", ""])), r#"node a "b c" """#);
        assert_eq!(command_line(r"C:\Program Files\node.exe", &[]), r#""C:\Program Files\node.exe""#);
        assert_eq!(command_line("x", &args(&[r#"say "hi""#])), r#"x "say \"hi\"""#);
        assert_eq!(command_line("x", &args(&[r"C:\dir with space\"])), r#"x "C:\dir with space\\""#);
        assert_eq!(command_line("x", &args(&[r"a\\b"])), r"x a\\b");
    }

    #[test]
    fn the_environment_is_the_apps_with_the_spawns_variables_over_it() {
        let block = environment_block(&[("Path".into(), r"C:\only".into()), ("GENTLE_DOT_X".into(), "1".into())]);
        let text = String::from_utf16_lossy(&block);
        let vars: Vec<&str> = text.split('\0').filter(|v| !v.is_empty()).collect();
        let paths: Vec<&&str> = vars.iter().filter(|v| v.to_uppercase().starts_with("PATH=")).collect();
        assert_eq!(paths, [&r"Path=C:\only"]);
        assert!(vars.contains(&"GENTLE_DOT_X=1"));
        assert!(block.ends_with(&[0, 0]));
        let keys: Vec<String> = vars.iter().map(|v| v.split('=').next().unwrap().to_uppercase()).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
    }

    trait Borrowed {
        fn as_handle_borrowed(&self) -> BorrowedHandle<'_>;
    }

    impl Borrowed for OwnedHandle {
        fn as_handle_borrowed(&self) -> BorrowedHandle<'_> {
            use std::os::windows::io::AsHandle;
            self.as_handle()
        }
    }
}
