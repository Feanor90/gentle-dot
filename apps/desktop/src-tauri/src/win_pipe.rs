//! The app's private channel on Windows (S25.1, docs/design.md §4), as proven in the T1 spike
//! (odd/spikes/t1-app-channel-windows). Windows has no socketpair, so the app makes a connected pair
//! from a named pipe that exists only for that moment:
//!
//! - its name holds 128 random bits from the system's CSPRNG (`getrandom`);
//! - it has one instance (`FILE_FLAG_FIRST_PIPE_INSTANCE`, at most 1), refuses remote clients, and
//!   its access list names only the user (`D:P(A;;GA;;;<user SID>)`);
//! - the app opens the client end itself and checks that the client is its own process.
//!
//! Once connected, the single instance is taken: a second open of the name fails with
//! `ERROR_PIPE_BUSY`. Another process of the same user that opened the name first makes the app's own
//! open or the pid check fail, so the pair is refused (fail closed); nothing ever listens.
//!
//! Both ends are overlapped. On a synchronous pipe a pending read blocks every write on the same
//! handle, so a reader thread waiting for the daemon would stop the app from ever writing to it.

use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::{mem, ptr};
use windows_sys::Win32::Foundation::{
    DuplicateHandle, GetLastError, LocalFree, DUPLICATE_SAME_ACCESS, ERROR_BROKEN_PIPE, ERROR_IO_PENDING,
    ERROR_OPERATION_ABORTED, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, FALSE, GENERIC_READ, GENERIC_WRITE,
    HANDLE, INVALID_HANDLE_VALUE, TRUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId, PeekNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{CreateEventW, GetCurrentProcess, GetCurrentProcessId, OpenProcessToken};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

/// Room for a frame or two in each direction; a longer write waits for the reader.
const BUFFER: u32 = 64 * 1024;

/// One end of the pair, read and written with overlapped I/O.
#[derive(Debug)]
pub struct PipeStream {
    handle: OwnedHandle,
    /// The app's end: shutting it down disconnects the pipe, which ends the daemon's side.
    server: bool,
}

/// A connected pair: the app's end, and the daemon's (not inheritable; `win_spawn` hands a copy over).
pub fn private_pair() -> io::Result<(PipeStream, OwnedHandle)> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| io::Error::other(format!("no random name for the channel: {error}")))?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    pair_named(&format!(r"\\.\pipe\gentle-dot-{suffix}"))
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// A local allocation freed with `LocalFree`.
struct Local(*mut core::ffi::c_void);

impl Drop for Local {
    fn drop(&mut self) {
        // SAFETY: the pointer came from a Win32 call that documents LocalFree as its release.
        unsafe { LocalFree(self.0) };
    }
}

/// The current user's SID as text (`S-1-5-21-…`).
fn user_sid() -> io::Result<String> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: a valid out-pointer; the pseudo handle of this process needs no closing.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken returned a handle we now own.
    let token = unsafe { OwnedHandle::from_raw_handle(token as RawHandle) };
    let mut len = 0u32;
    // SAFETY: a size query (null buffer, 0 bytes); it fails and sets `len`.
    unsafe { GetTokenInformation(token.as_raw_handle() as HANDLE, TokenUser, ptr::null_mut(), 0, &mut len) };
    // usize-aligned, which TOKEN_USER needs.
    let mut buffer = vec![0usize; (len as usize).div_ceil(mem::size_of::<usize>())];
    // SAFETY: the buffer holds at least `len` bytes.
    if unsafe { GetTokenInformation(token.as_raw_handle() as HANDLE, TokenUser, buffer.as_mut_ptr().cast(), len, &mut len) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetTokenInformation(TokenUser) filled the aligned buffer with a TOKEN_USER.
    let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    let mut text: *mut u16 = ptr::null_mut();
    // SAFETY: the SID points into `buffer`, alive here; `text` is released by `Local`.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let owned = Local(text.cast());
    // SAFETY: ConvertSidToStringSidW returned a NUL-terminated string.
    let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    // SAFETY: `len` UTF-16 units before the NUL, alive until `owned` drops.
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    drop(owned);
    Ok(sid)
}

/// The access list that lets only the user in, protected from inheriting any other entry.
fn owner_only() -> io::Result<Local> {
    let sddl = wide(&format!("D:P(A;;GA;;;{})", user_sid()?));
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: a NUL-terminated SDDL string and an out-pointer; the result is released by `Local`.
    let made = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, ptr::null_mut())
    };
    if made == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Local(descriptor))
}

fn pair_named(name: &str) -> io::Result<(PipeStream, OwnedHandle)> {
    let name = wide(name);
    let descriptor = owner_only()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: FALSE,
    };
    // SAFETY: a NUL-terminated name and attributes that outlive the call.
    let server = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            BUFFER,
            BUFFER,
            0,
            &attributes,
        )
    };
    if server == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateNamedPipeW returned a handle we now own.
    let server = PipeStream { handle: unsafe { OwnedHandle::from_raw_handle(server as RawHandle) }, server: true };
    // SAFETY: a NUL-terminated name; no attributes, so the handle is not inheritable. The server may
    // only identify the client, never act as it (it is this app; the flag costs nothing).
    let client = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            ptr::null_mut(),
        )
    };
    if client == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a handle we now own.
    let client = unsafe { OwnedHandle::from_raw_handle(client as RawHandle) };
    let connected = overlapped(server.raw(), |ov| {
        // SAFETY: the server handle and an OVERLAPPED that `overlapped` keeps alive until completion.
        unsafe { ConnectNamedPipe(server.raw(), ov) }
    });
    match connected {
        Ok(_) => {}
        Err(error) if error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) => {}
        Err(error) => return Err(error),
    }
    let mut client_pid = 0u32;
    // SAFETY: the server handle and a valid out-pointer.
    let known = unsafe { GetNamedPipeClientProcessId(server.raw(), &mut client_pid) } != 0;
    // SAFETY: no preconditions.
    if !known || client_pid != unsafe { GetCurrentProcessId() } {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "another process opened the assistant's channel"));
    }
    Ok((server, client))
}

/// Runs one overlapped operation on `handle` and waits for it; the bytes it moved.
fn overlapped(handle: HANDLE, start: impl FnOnce(*mut OVERLAPPED) -> i32) -> io::Result<u32> {
    // SAFETY: an unnamed manual-reset event, initially clear.
    let event = unsafe { CreateEventW(ptr::null(), TRUE, FALSE, ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateEventW returned a handle we now own.
    let event = unsafe { OwnedHandle::from_raw_handle(event as RawHandle) };
    // SAFETY: an all-zero OVERLAPPED is valid.
    let mut ov: OVERLAPPED = unsafe { mem::zeroed() };
    ov.hEvent = event.as_raw_handle() as HANDLE;
    if start(&mut ov) == 0 {
        // SAFETY: no preconditions.
        let error = unsafe { GetLastError() };
        if error != ERROR_IO_PENDING {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
    }
    let mut moved = 0u32;
    // SAFETY: `ov` stays alive and unmoved until the operation completes (bWait = TRUE).
    if unsafe { GetOverlappedResult(handle, &ov, &mut moved, TRUE) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(moved)
}

impl PipeStream {
    /// Wraps an end this process owns (the daemon's side in tests and in `win_spawn`'s helpers).
    pub fn from_owned(handle: OwnedHandle) -> Self {
        PipeStream { handle, server: false }
    }

    fn raw(&self) -> HANDLE {
        self.handle.as_raw_handle() as HANDLE
    }

    /// How many bytes wait to be read, without reading them.
    pub fn available(&self) -> io::Result<u32> {
        let mut available = 0u32;
        // SAFETY: our pipe handle, no buffer, and a valid out-pointer.
        let ok = unsafe { PeekNamedPipe(self.raw(), ptr::null_mut(), 0, ptr::null_mut(), &mut available, ptr::null_mut()) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(available)
    }

    /// Another handle to the same end, not inheritable, for a reader thread.
    pub fn try_clone(&self) -> io::Result<Self> {
        let mut copy: HANDLE = ptr::null_mut();
        // SAFETY: duplicating a handle we own within this process.
        let ok = unsafe {
            DuplicateHandle(GetCurrentProcess(), self.raw(), GetCurrentProcess(), &mut copy, 0, FALSE, DUPLICATE_SAME_ACCESS)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: DuplicateHandle returned a handle we now own.
        Ok(PipeStream { handle: unsafe { OwnedHandle::from_raw_handle(copy as RawHandle) }, server: self.server })
    }

    /// Ends the channel in both directions, whatever `how`: pending reads and writes of this process
    /// are cancelled, and the app's end disconnects, so the daemon reads the end of the channel.
    pub fn shutdown(&self, _how: std::net::Shutdown) -> io::Result<()> {
        // SAFETY: cancels this process's I/O on the handle; failing (nothing pending) is fine.
        unsafe { CancelIoEx(self.raw(), ptr::null()) };
        // SAFETY: the server end of a named pipe we own.
        if self.server && unsafe { DisconnectNamedPipe(self.raw()) } == 0 {
            // SAFETY: no preconditions.
            let error = unsafe { GetLastError() };
            if error != ERROR_PIPE_NOT_CONNECTED {
                return Err(io::Error::from_raw_os_error(error as i32));
            }
        }
        Ok(())
    }
}

impl Read for PipeStream {
    /// The other end gone, the pipe disconnected, or a read cancelled by `shutdown` read as the end.
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        let handle = self.raw();
        // SAFETY: `buf` holds `len` bytes and outlives the call, which waits for completion.
        match overlapped(handle, |ov| unsafe { ReadFile(handle, buf.as_mut_ptr(), len, ptr::null_mut(), ov) }) {
            Ok(read) => Ok(read as usize),
            Err(error)
                if [ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, ERROR_OPERATION_ABORTED]
                    .iter()
                    .any(|code| error.raw_os_error() == Some(*code as i32)) =>
            {
                Ok(0)
            }
            Err(error) => Err(error),
        }
    }
}

impl Write for PipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let len = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        let handle = self.raw();
        // SAFETY: `buf` holds `len` bytes and outlives the call, which waits for completion.
        overlapped(handle, |ov| unsafe { WriteFile(handle, buf.as_ptr(), len, ptr::null_mut(), ov) }).map(|n| n as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for &PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.try_clone()?.read(buf)
    }
}

impl Write for &PipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.try_clone()?.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY};
    use windows_sys::Win32::Security::Authorization::{ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT};
    use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION};

    fn unique_name(tag: &str) -> String {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        format!(r"\\.\pipe\gentle-dot-test-{tag}-{}", u64::from_le_bytes(random))
    }

    fn open(name: &str) -> Result<OwnedHandle, u32> {
        let name = wide(name);
        // SAFETY: a NUL-terminated name.
        let handle =
            unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, ptr::null(), OPEN_EXISTING, 0, ptr::null_mut()) };
        if handle == INVALID_HANDLE_VALUE {
            // SAFETY: no preconditions.
            return Err(unsafe { GetLastError() });
        }
        // SAFETY: CreateFileW returned a handle we now own.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) })
    }

    #[test]
    fn the_pair_carries_lines_both_ways() {
        let (app, daemon) = private_pair().unwrap();
        let daemon = PipeStream::from_owned(daemon);
        (&app).write_all(b"ping\n").unwrap();
        let mut line = String::new();
        BufReader::new(daemon.try_clone().unwrap()).read_line(&mut line).unwrap();
        assert_eq!(line, "ping\n");
        (&daemon).write_all(b"pong\n").unwrap();
        line.clear();
        BufReader::new(app.try_clone().unwrap()).read_line(&mut line).unwrap();
        assert_eq!(line, "pong\n");
    }

    #[test]
    fn a_pending_read_never_blocks_a_write_on_the_same_end() {
        let (app, daemon) = private_pair().unwrap();
        let mut reader = app.try_clone().unwrap();
        let waiting = std::thread::spawn(move || {
            let mut buf = [0u8; 16];
            let n = reader.read(&mut buf).unwrap();
            buf[..n].to_vec()
        });
        std::thread::sleep(Duration::from_millis(100));
        // The app writes while its reader waits; the daemon reads it, then answers the reader.
        (&app).write_all(b"request\n").unwrap();
        let mut line = String::new();
        let daemon = PipeStream::from_owned(daemon);
        BufReader::new(daemon.try_clone().unwrap()).read_line(&mut line).unwrap();
        assert_eq!(line, "request\n");
        (&daemon).write_all(b"answer").unwrap();
        assert_eq!(waiting.join().unwrap(), b"answer");
    }

    #[test]
    fn the_name_lets_no_one_else_in_once_paired() {
        let name = unique_name("busy");
        let (_app, _daemon) = pair_named(&name).unwrap();
        assert_eq!(open(&name).unwrap_err(), ERROR_PIPE_BUSY);
    }

    #[test]
    fn a_name_someone_else_holds_is_refused() {
        // Another process of the user created the name first, with any number of instances and the
        // default access list, to be the one the daemon would talk to.
        let name = unique_name("taken");
        let wname = wide(&name);
        // SAFETY: a NUL-terminated name; default security.
        let squatter = unsafe {
            CreateNamedPipeW(wname.as_ptr(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_WAIT, 255, BUFFER, BUFFER, 0, ptr::null())
        };
        assert_ne!(squatter, INVALID_HANDLE_VALUE);
        // SAFETY: CreateNamedPipeW returned a handle we now own.
        let _squatter = unsafe { OwnedHandle::from_raw_handle(squatter as RawHandle) };
        let refused = pair_named(&name).unwrap_err();
        assert_eq!(refused.raw_os_error(), Some(ERROR_ACCESS_DENIED as i32), "{refused}");
        // A name already paired is refused too: it allows a single instance.
        let paired = unique_name("paired");
        let (_app, _daemon) = pair_named(&paired).unwrap();
        assert_eq!(pair_named(&paired).unwrap_err().raw_os_error(), Some(ERROR_PIPE_BUSY as i32));
    }

    #[test]
    fn the_pipe_lets_only_the_user_in() {
        let (app, _daemon) = private_pair().unwrap();
        let mut dacl = ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: out-pointers; the descriptor is released by `Local`.
        let status = unsafe {
            GetSecurityInfo(
                app.raw(),
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0);
        let _descriptor = Local(descriptor);
        let mut text: *mut u16 = ptr::null_mut();
        // SAFETY: a valid descriptor; `text` is released by `Local`.
        let ok = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                &mut text,
                ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0);
        let _text = Local(text.cast());
        // SAFETY: a NUL-terminated string from the call above.
        let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
        // SAFETY: `len` units before the NUL.
        let sddl = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
        assert_eq!(sddl, format!("D:P(A;;FA;;;{})", user_sid().unwrap()));
    }

    #[test]
    fn neither_end_is_inheritable() {
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
        let (app, daemon) = private_pair().unwrap();
        for handle in [app.raw(), daemon.as_raw_handle() as HANDLE] {
            let mut flags = 0u32;
            // SAFETY: a handle we own and a valid out-pointer.
            assert_ne!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
            assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        }
    }

    #[test]
    fn every_pair_has_a_fresh_random_name() {
        // Two pairs at once: the second could not exist under the first one's name.
        let first = private_pair().unwrap();
        let second = private_pair().unwrap();
        drop((first, second));
    }

    #[test]
    fn shutting_down_the_apps_end_ends_the_daemons_side_and_wakes_its_own_reader() {
        let (app, daemon) = private_pair().unwrap();
        let mut reader = app.try_clone().unwrap();
        let waiting = std::thread::spawn(move || reader.read(&mut [0u8; 8]).unwrap());
        std::thread::sleep(Duration::from_millis(100));
        app.shutdown(std::net::Shutdown::Both).unwrap();
        assert_eq!(waiting.join().unwrap(), 0);
        let mut daemon = PipeStream::from_owned(daemon);
        assert_eq!(daemon.read(&mut [0u8; 8]).unwrap(), 0);
        assert!(daemon.write(b"late").is_err());
    }

    #[test]
    fn dropping_the_apps_end_ends_the_daemons_side() {
        let (app, daemon) = private_pair().unwrap();
        drop(app);
        assert_eq!(PipeStream::from_owned(daemon).read(&mut [0u8; 8]).unwrap(), 0);
    }
}
