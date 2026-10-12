//! T1 spike: the app channel on Windows.
//! parent <node> <daemon.mjs>   plays the app; spawns a control leaker, then the daemon with fd 3.
//! grandchild <handle> <how>    tries to write "LEAK" into the handle value it may have inherited.
use std::collections::hash_map::RandomState;
use std::ffi::c_void;
use std::hash::{BuildHasher, Hasher};
use std::{mem, ptr, sync::mpsc, thread, time::Duration};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::*;

fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("grandchild") => grandchild(&args[2], &args[3]),
        _ => parent(&args[1], &args[2]),
    }
}

fn grandchild(handle: &str, how: &str) {
    let h = handle.parse::<usize>().unwrap() as HANDLE;
    let mut flags = 0u32;
    let valid = unsafe { GetHandleInformation(h, &mut flags) } != 0;
    let mut server_pid = 0u32;
    let pipe = valid && unsafe { GetNamedPipeServerProcessId(h, &mut server_pid) } != 0;
    let mut wrote = false;
    if pipe {
        let msg = format!("LEAK {how} {}\n", std::process::id());
        let mut n = 0u32;
        wrote = unsafe { WriteFile(h, msg.as_ptr(), msg.len() as u32, &mut n, ptr::null_mut()) } != 0;
    }
    println!(r#"{{"how":"{how}","valid":{valid},"pipe":{pipe},"serverPid":{server_pid},"wrote":{wrote}}}"#);
}

unsafe fn user_sid() -> String {
    let mut token: HANDLE = ptr::null_mut();
    assert!(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0);
    let mut len = 0u32;
    GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut len);
    let mut buf = vec![0u8; len as usize];
    assert!(GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) != 0);
    let user = &*(buf.as_ptr() as *const TOKEN_USER);
    let mut s: *mut u16 = ptr::null_mut();
    assert!(ConvertSidToStringSidW(user.User.Sid, &mut s) != 0);
    let mut n = 0;
    while *s.add(n) != 0 {
        n += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(s, n))
}

fn spawn_raw(cmdline: &str, inherit: windows_sys::core::BOOL, si: *const STARTUPINFOW, flags: u32) -> PROCESS_INFORMATION {
    let mut cmd = w(cmdline);
    let mut pi: PROCESS_INFORMATION = unsafe { mem::zeroed() };
    let ok = unsafe {
        CreateProcessW(ptr::null(), cmd.as_mut_ptr(), ptr::null(), ptr::null(), inherit, flags, ptr::null(), ptr::null(), si, &mut pi)
    };
    assert!(ok != 0, "CreateProcessW failed: {}", unsafe { GetLastError() });
    pi
}

fn parent(node: &str, daemon: &str) {
    unsafe {
        let me = std::env::current_exe().unwrap().display().to_string();
        let sid = user_sid();
        let sddl = w(&format!("D:P(A;;GA;;;{sid})"));
        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        assert!(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, ptr::null_mut()) != 0);
        let sa_private = SECURITY_ATTRIBUTES { nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: FALSE };
        let sa_inherit = SECURITY_ATTRIBUTES { nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: ptr::null_mut(), bInheritHandle: TRUE };

        let mut rnd = RandomState::new().build_hasher();
        rnd.write_u32(GetCurrentProcessId());
        let name = format!(r"\\.\pipe\gentle-dot-spike-{:016x}{:016x}", rnd.finish(), RandomState::new().build_hasher().finish());
        let wname = w(&name);
        let server = CreateNamedPipeW(
            wname.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1, 65536, 65536, 0, &sa_private,
        );
        assert!(server != INVALID_HANDLE_VALUE, "CreateNamedPipeW: {}", GetLastError());
        let client = CreateFileW(wname.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, &sa_inherit, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, ptr::null_mut());
        assert!(client != INVALID_HANDLE_VALUE, "CreateFileW client: {}", GetLastError());
        let connected = ConnectNamedPipe(server, ptr::null_mut()) != 0 || GetLastError() == ERROR_PIPE_CONNECTED;
        let mut client_pid = 0u32;
        GetNamedPipeClientProcessId(server, &mut client_pid);
        println!("pipe {name}\nconnected={connected} clientPidIsMe={}", client_pid == GetCurrentProcessId());
        // P1: nothing listens: a second open of the name must fail.
        let other = CreateFileW(wname.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, ptr::null(), OPEN_EXISTING, 0, ptr::null_mut());
        println!("secondOpenRefused={} (error {})", other == INVALID_HANDLE_VALUE, GetLastError());
        let h = client as usize;
        println!("client handle value={h}");

        // Control: a child created with plain handle inheritance does leak (detector works).
        let si: STARTUPINFOW = STARTUPINFOW { cb: mem::size_of::<STARTUPINFOW>() as u32, ..mem::zeroed() };
        let control = spawn_raw(&format!("\"{me}\" grandchild {h} control"), TRUE, &si, 0);
        WaitForSingleObject(control.hProcess, 10_000);

        // The daemon: fd 0 NUL, fd 1/2 a log file, fd 3 the client end, and nothing else inheritable.
        let nul = CreateFileW(w("NUL").as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa_inherit, OPEN_EXISTING, 0, ptr::null_mut());
        let out = CreateFileW(w("daemon-out.txt").as_ptr(), GENERIC_WRITE, FILE_SHARE_READ, &sa_inherit, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, ptr::null_mut());
        assert!(nul != INVALID_HANDLE_VALUE && out != INVALID_HANDLE_VALUE);
        const FOPEN: u8 = 0x01;
        const FPIPE: u8 = 0x08;
        const FDEV: u8 = 0x40;
        let fds: [(u8, HANDLE); 4] = [(FOPEN | FDEV, nul), (FOPEN, out), (FOPEN, out), (FOPEN | FPIPE, client)];
        let mut reserved = Vec::new();
        reserved.extend_from_slice(&(fds.len() as i32).to_le_bytes());
        reserved.extend(fds.iter().map(|f| f.0));
        for f in &fds {
            reserved.extend_from_slice(&(f.1 as usize).to_le_bytes());
        }
        let list_handles: [HANDLE; 3] = [nul, out, client];
        let mut size = 0usize;
        InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
        let mut list_buf = vec![0u8; size];
        let list = list_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        assert!(InitializeProcThreadAttributeList(list, 1, 0, &mut size) != 0);
        assert!(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, list_handles.as_ptr() as *const c_void, mem::size_of_val(&list_handles), ptr::null_mut(), ptr::null()) != 0);
        let mut six: STARTUPINFOEXW = mem::zeroed();
        six.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
        six.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        six.StartupInfo.hStdInput = nul;
        six.StartupInfo.hStdOutput = out;
        six.StartupInfo.hStdError = out;
        six.StartupInfo.cbReserved2 = reserved.len() as u16;
        six.StartupInfo.lpReserved2 = reserved.as_mut_ptr();
        six.lpAttributeList = list;
        let pi = spawn_raw(&format!("\"{node}\" \"{daemon}\" {h} \"{me}\""), TRUE, &six.StartupInfo, EXTENDED_STARTUPINFO_PRESENT);
        DeleteProcThreadAttributeList(list);
        CloseHandle(client);
        CloseHandle(nul);
        CloseHandle(out);

        // Read lines until the daemon's report.
        let server_addr = server as usize;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut all = String::new();
            let mut buf = [0u8; 4096];
            loop {
                let mut n = 0u32;
                let ok = ReadFile(server_addr as HANDLE, buf.as_mut_ptr(), buf.len() as u32, &mut n, ptr::null_mut()) != 0;
                if !ok || n == 0 {
                    break;
                }
                all.push_str(&String::from_utf8_lossy(&buf[..n as usize]));
                if all.contains("\"kind\":\"report\"") && all.ends_with('\n') {
                    break;
                }
            }
            tx.send(all).ok();
        });
        let received = rx.recv_timeout(Duration::from_secs(60)).unwrap_or_else(|_| "TIMEOUT".into());
        println!("--- received on the app's end ---\n{received}---");
        let leaks: Vec<&str> = received.lines().filter(|l| l.starts_with("LEAK")).collect();
        println!("controlLeakDetected={}", leaks.iter().any(|l| l.starts_with("LEAK control")));
        println!("daemonChildLeaks={:?}", leaks.iter().filter(|l| !l.starts_with("LEAK control")).collect::<Vec<_>>());

        // P4: closing the app's end stops the daemon.
        CloseHandle(server);
        let waited = WaitForSingleObject(pi.hProcess, 10_000);
        let mut code = 0u32;
        GetExitCodeProcess(pi.hProcess, &mut code);
        println!("daemonExitedOnClose={} exitCode={code}", waited == WAIT_OBJECT_0);
    }
}
