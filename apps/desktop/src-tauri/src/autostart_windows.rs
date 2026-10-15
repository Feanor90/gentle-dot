//! Launch at login on Windows, quoted (S4). `tauri-plugin-autostart` (through `auto-launch`) writes
//! the `HKCU\...\CurrentVersion\Run` value as `<exe> <args>` without quotes. The per-user install
//! lives in `%LOCALAPPDATA%\Gentle Dot`, and Windows resolves an unquoted path with a space by
//! trying `%LOCALAPPDATA%\Gentle.exe` first, so any program of the same user dropped there would
//! run at login instead of the app. Windows operations therefore use HKCU directly, never the
//! plugin's unquoted write or its elevated HKLM mode. Startup preserves quoted absolute paths
//! verbatim (including their args), removes ambiguous legacy entries and reports that removal.
//! It never substitutes the running dev/installed binary or creates an entry at startup.
use std::io;
use std::ptr;
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_SET_VALUE, REG_SZ, RRF_RT_REG_SZ,
};

/// The key `auto-launch` writes for the current user.
pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The command line for a `Run` value: the executable quoted, then each argument quoted by the
/// rules `CommandLineToArgvW` and the C runtime parse. A path cannot hold `"` on Windows, so one
/// that does is refused rather than guessed at.
pub fn run_command_line(exe: &str, args: &[&str]) -> Result<String, String> {
    if exe.is_empty() || exe.contains(['"', '\0']) || args.iter().any(|arg| arg.contains('\0')) {
        return Err(format!("cannot quote the executable path `{exe}`"));
    }
    let mut line = format!("\"{exe}\"");
    for arg in args {
        line.push_str(" \"");
        let mut backslashes = 0;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    // Each backslash before a quote is doubled, and the quote itself escaped.
                    line.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                    backslashes = 0;
                }
                _ => {
                    line.extend(std::iter::repeat_n('\\', backslashes));
                    backslashes = 0;
                }
            }
            if c != '\\' {
                line.push(c);
            }
        }
        // Backslashes before the closing quote are doubled too.
        line.extend(std::iter::repeat_n('\\', backslashes * 2));
        line.push('"');
    }
    Ok(line)
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn check(status: u32) -> io::Result<()> {
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

/// The current user's `Run` value `name`, or `None` when it does not exist.
pub fn run_value(name: &str) -> io::Result<Option<String>> {
    let (key, name) = (wide(RUN_KEY), wide(name));
    let mut size = 0u32;
    // SAFETY: the strings are NUL-terminated; a null buffer asks only for the size in bytes.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut size,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    check(status)?;
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    // SAFETY: `buffer` holds `size` bytes, as `RegGetValueW` was told.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    check(status)?;
    let len = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16(&buffer[..len])
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Publishes a complete command in one REG_SZ write. No unquoted intermediate value.
fn write_run_value(name: &str, command: &str) -> io::Result<()> {
    let mut key: HKEY = ptr::null_mut();
    // SAFETY: the subkey is NUL-terminated and `key` receives the opened handle.
    check(unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            wide(RUN_KEY).as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut key,
        )
    })?;
    let data = wide(command);
    // SAFETY: `key` is open for writing; `data` is a NUL-terminated REG_SZ, its length in bytes.
    let status = unsafe {
        RegSetValueExW(
            key,
            wide(name).as_ptr(),
            0,
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    // SAFETY: `key` was opened above and is closed once.
    unsafe { RegCloseKey(key) };
    check(status)
}

/// Injectable HKCU operations. A failed write/remove must leave the previous value intact.
pub trait Registry {
    fn read(&self, name: &str) -> io::Result<Option<String>>;
    fn write(&mut self, name: &str, command: &str) -> io::Result<()>;
    fn remove(&mut self, name: &str) -> io::Result<()>;
    fn login_allowed(&self, _name: &str) -> io::Result<bool> {
        Ok(true)
    }
}

pub struct CurrentUser;
impl Registry for CurrentUser {
    fn read(&self, name: &str) -> io::Result<Option<String>> {
        run_value(name)
    }
    fn write(&mut self, name: &str, command: &str) -> io::Result<()> {
        write_run_value(name, command)
    }
    fn remove(&mut self, name: &str) -> io::Result<()> {
        use windows_sys::Win32::System::Registry::RegDeleteKeyValueW;
        // SAFETY: both strings are terminated; only this named HKCU value is removed.
        let status = unsafe {
            RegDeleteKeyValueW(
                HKEY_CURRENT_USER,
                wide(RUN_KEY).as_ptr(),
                wide(name).as_ptr(),
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            check(status)
        }
    }
    fn login_allowed(&self, name: &str) -> io::Result<bool> {
        use windows_sys::Win32::System::Registry::RRF_RT_REG_BINARY;
        let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run");
        let mut bytes = [0u8; 12];
        let mut size = bytes.len() as u32;
        // SAFETY: the output buffer holds `size` bytes; strings are terminated.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                wide(name).as_ptr(),
                RRF_RT_REG_BINARY,
                ptr::null_mut(),
                bytes.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(true);
        }
        check(status)?;
        Ok(size == 12 && bytes[4..].iter().all(|b| *b == 0))
    }
}

/// Public operation boundary; no plugin or HKLM operations are involved.
pub fn enable(
    registry: &mut impl Registry,
    name: &str,
    exe: &str,
    args: &[&str],
) -> Result<(), String> {
    let command = run_command_line(exe, args)?;
    if !quoted_absolute_executable(&command) {
        return Err("Launch at login requires a quoted absolute executable path".into());
    }
    if !registry
        .login_allowed(name)
        .map_err(|e| format!("Cannot query StartupApproved: {e}"))?
    {
        return Err("Launch at login is disabled by Windows. Enable Gentle Dot in Task Manager > Startup apps, then try again.".into());
    }
    registry.write(name, &command).map_err(|e| format!("Cannot register quoted launch at login under HKCU: {e}. Previous registration was not changed."))
}

pub fn disable(registry: &mut impl Registry, name: &str) -> Result<(), String> {
    registry.remove(name).map_err(|e| format!("Cannot remove launch at login under HKCU: {e}. The registration may remain; remove Gentle Dot from Windows Startup apps manually."))
}

pub fn is_enabled(registry: &impl Registry, name: &str) -> Result<bool, String> {
    let value = registry
        .read(name)
        .map_err(|e| format!("Cannot read HKCU launch at login: {e}"))?;
    match value {
        None => Ok(false),
        Some(value) if quoted_absolute_executable(&value) => registry.login_allowed(name).map_err(|e| format!("Cannot query StartupApproved: {e}")),
        Some(_) => Err("Unsafe launch-at-login registration; restart Gentle Dot to remove it or remove its HKCU Run entry manually.".into()),
    }
}

/// Returns true only when an ambiguous entry was removed. No executable guessing or filesystem
/// probes: any unquoted entry is removed, even a legacy path without spaces. Quoted absolute
/// executable paths are preserved byte-for-byte, including args and a different installation path.
pub fn reconcile(registry: &mut impl Registry, name: &str) -> Result<bool, String> {
    let value = registry.read(name).map_err(|e| format!("Cannot inspect launch at login: {e}. Its safety is unknown; inspect HKCU Run manually."))?;
    if value
        .as_deref()
        .is_some_and(|v| !quoted_absolute_executable(v))
    {
        disable(registry, name)?;
        return Ok(true);
    }
    Ok(false)
}

fn quoted_absolute_executable(command: &str) -> bool {
    if command.contains('\0') {
        return false;
    }
    let Some(rest) = command.strip_prefix('"') else {
        return false;
    };
    let Some((exe, args)) = rest.split_once('"') else {
        return false;
    };
    let bytes = exe.as_bytes();
    let drive =
        bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    let unc = exe
        .strip_prefix(r"\\")
        .is_some_and(|p| p.split('\\').filter(|s| !s.is_empty()).count() >= 3);
    (drive || unc)
        && exe.to_ascii_lowercase().ends_with(".exe")
        && (args.is_empty() || args.starts_with(char::is_whitespace))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        value: Option<String>,
        writes: RefCell<Vec<String>>,
        deny_write: bool,
        deny_remove: bool,
        deny_read: bool,
        blocked: bool,
    }
    impl Registry for Fake {
        fn read(&self, _: &str) -> io::Result<Option<String>> {
            if self.deny_read {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            Ok(self.value.clone())
        }
        fn login_allowed(&self, _: &str) -> io::Result<bool> {
            Ok(!self.blocked)
        }
        fn write(&mut self, _: &str, value: &str) -> io::Result<()> {
            if self.deny_write {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            self.writes.borrow_mut().push(value.to_string());
            self.value = Some(value.to_string());
            Ok(())
        }
        fn remove(&mut self, _: &str) -> io::Result<()> {
            if self.deny_remove {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            self.value = None;
            Ok(())
        }
    }

    #[test]
    fn autostart_query_failures_and_task_manager_block_are_not_success() {
        let mut registry = Fake {
            deny_read: true,
            ..Fake::default()
        };
        assert!(is_enabled(&registry, "app").is_err());
        assert!(reconcile(&mut registry, "app").is_err());
        assert_eq!(registry.value, None);
        registry.deny_read = false;
        registry.blocked = true;
        assert!(enable(&mut registry, "app", r"C:\app.exe", &[])
            .unwrap_err()
            .contains("Task Manager"));
        assert_eq!(registry.value, None);
        assert!(registry.writes.borrow().is_empty());
        registry.value = Some(r#""C:\app.exe""#.into());
        assert!(!is_enabled(&registry, "app").unwrap());
        assert!(!reconcile(&mut registry, "app").unwrap());
        assert_eq!(registry.value.as_deref(), Some(r#""C:\app.exe""#));
    }

    #[test]
    fn autostart_invalid_input_does_not_publish_or_change_storage() {
        let mut registry = Fake::default();
        for path in ["", "relative.exe", "C:\\a\0b.exe", r#"C:\a"b.exe"#] {
            assert!(enable(&mut registry, "app", path, &[]).is_err());
            assert_eq!(registry.value, None);
            assert!(registry.writes.borrow().is_empty());
        }
        assert!(enable(&mut registry, "app", r"C:\app.exe", &["arg\0hidden"]).is_err());
        assert_eq!(registry.value, None);
        assert!(registry.writes.borrow().is_empty());
    }

    #[test]
    fn autostart_initial_write_is_always_quoted() {
        let mut registry = Fake::default();
        enable(
            &mut registry,
            "app",
            r"C:\Gentle Dot\app.exe",
            &["two words"],
        )
        .unwrap();
        assert_eq!(
            registry.writes.into_inner(),
            vec![r#""C:\Gentle Dot\app.exe" "two words""#]
        );
        assert_eq!(
            registry.value.as_deref(),
            Some(r#""C:\Gentle Dot\app.exe" "two words""#)
        );
    }

    #[test]
    fn autostart_write_failure_is_not_success_and_preserves_value() {
        for old in [None, Some(r#""D:\other\app.exe""#.to_string())] {
            let mut registry = Fake {
                value: old.clone(),
                deny_write: true,
                ..Fake::default()
            };
            assert!(enable(&mut registry, "app", r"C:\new\app.exe", &[]).is_err());
            assert_eq!(registry.value, old);
            assert!(registry.writes.borrow().is_empty());
        }
    }

    #[test]
    fn autostart_disable_and_query_preserve_behavior() {
        let mut registry = Fake::default();
        assert!(!is_enabled(&registry, "app").unwrap());
        enable(&mut registry, "app", r"C:\app.exe", &[]).unwrap();
        assert!(is_enabled(&registry, "app").unwrap());
        registry.deny_remove = true;
        let previous = registry.value.clone();
        assert!(disable(&mut registry, "app").is_err());
        assert_eq!(registry.value, previous);
        registry.deny_remove = false;
        disable(&mut registry, "app").unwrap();
        assert!(!is_enabled(&registry, "app").unwrap());
    }

    #[test]
    fn autostart_reconcile_preserves_quoted_entry_and_never_creates_one() {
        for value in [
            None,
            Some(r#""D:\installed app\app.exe" --old-args"#.to_string()),
        ] {
            let mut registry = Fake {
                value: value.clone(),
                ..Fake::default()
            };
            assert!(!reconcile(&mut registry, "app").unwrap());
            assert_eq!(registry.value, value);
            assert!(registry.writes.borrow().is_empty());
        }
    }

    #[test]
    fn autostart_legacy_entry_removed_or_removal_failure_reported() {
        for legacy in [
            r"C:\Gentle Dot\app.exe ",
            r"C:\app.exe --arg",
            "malformed",
            r#""relative.exe""#,
        ] {
            let mut registry = Fake {
                value: Some(legacy.to_string()),
                deny_remove: true,
                ..Fake::default()
            };
            assert!(reconcile(&mut registry, "app").is_err());
            assert_eq!(registry.value.as_deref(), Some(legacy));
            registry.deny_remove = false;
            assert!(reconcile(&mut registry, "app").unwrap());
            assert_eq!(registry.value, None);
            assert!(registry.writes.borrow().is_empty());
        }
    }

    use super::*;

    #[test]
    fn autostart_quotes_a_path_with_spaces() {
        let exe = r"C:\Users\me\AppData\Local\Gentle Dot\gentle-dot.exe";
        assert_eq!(run_command_line(exe, &[]).unwrap(), format!("\"{exe}\""));
    }

    #[test]
    fn autostart_quotes_a_path_without_spaces() {
        let exe = r"C:\Tools\gentle-dot.exe";
        assert_eq!(run_command_line(exe, &[]).unwrap(), format!("\"{exe}\""));
    }

    #[test]
    fn autostart_quotes_each_argument() {
        let line = run_command_line(r"C:\A B\app.exe", &["--flag", "two words", ""]).unwrap();
        assert_eq!(line, r#""C:\A B\app.exe" "--flag" "two words" """#);
    }

    #[test]
    fn autostart_escapes_quotes_and_the_backslashes_before_them_in_arguments() {
        let line = run_command_line(
            r"C:\app.exe",
            &[r#"say "hi""#, r#"a\"b"#, r"dir\", r"C:\x\y"],
        )
        .unwrap();
        assert_eq!(
            line,
            r#""C:\app.exe" "say \"hi\"" "a\\\"b" "dir\\" "C:\x\y""#
        );
    }

    #[test]
    fn autostart_refuses_an_executable_path_with_a_quote_or_none_at_all() {
        assert!(run_command_line(r#"C:\a"b\app.exe"#, &[]).is_err());
        assert!(run_command_line("", &[]).is_err());
    }

    /// Writes, reads and removes a throwaway `Run` value under a unique name (never the app's).
    #[test]
    #[ignore = "writes the current user's registry"]
    fn autostart_registry_round_trip() {
        use windows_sys::Win32::System::Registry::RegDeleteKeyValueW;

        let name = format!("GentleDotAutostartTest-{}", std::process::id());
        let remove = || {
            // SAFETY: both strings are NUL-terminated.
            unsafe {
                RegDeleteKeyValueW(
                    HKEY_CURRENT_USER,
                    wide(RUN_KEY).as_ptr(),
                    wide(&name).as_ptr(),
                )
            }
        };
        assert_eq!(run_value(&name).unwrap(), None);
        assert!(!reconcile(&mut CurrentUser, &name).unwrap());
        let registered = enable(
            &mut CurrentUser,
            &name,
            r"C:\Temp\Gentle Dot\gentle-dot.exe",
            &[],
        );
        let read = run_value(&name);
        let enabled = is_enabled(&CurrentUser, &name);
        let disabled = disable(&mut CurrentUser, &name);
        // A second cleanup attempt precedes assertions, including on a failed operation.
        let removed = remove();
        registered.unwrap();
        assert!(enabled.unwrap());
        disabled.unwrap();
        assert_eq!(
            read.unwrap().as_deref(),
            Some(r#""C:\Temp\Gentle Dot\gentle-dot.exe""#)
        );
        assert!(removed == ERROR_SUCCESS || removed == ERROR_FILE_NOT_FOUND);
        assert_eq!(run_value(&name).unwrap(), None);
    }
}
