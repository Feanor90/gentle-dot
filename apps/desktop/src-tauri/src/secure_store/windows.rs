//! Connector secrets in the Windows Credential Manager (S25.5 on Windows). Each secret is a generic
//! credential with the target `<service>/<id>` ([`SERVICE`](super::SERVICE) for the app; each
//! upper-case letter of the id written `^` + its lower-case form, since the Credential Manager
//! ignores case in targets and ids do not, [`encode_case`]), the user name = the secret id, and the comment "Gentle Dot connector: <id>", persisted on this
//! computer only (`CRED_PERSIST_LOCAL_MACHINE`: it never roams with the profile). Windows encrypts
//! it at rest with the user's logon credentials (DPAPI). The value is stored as UTF-8.
//!
//! A credential holds at most 2,560 bytes ([`PART`]), and a sign-in (an OAuth state) can be longer,
//! so a longer secret is kept in parts: the first in `<service>/<id>`, whose `GentleDotParts`
//! attribute says `<count>:<generation>`, the others in `<service>/<id>#<generation>-2`, `-3`, …
//! (`#` is never in an id). Each write picks a new random generation, stores the other parts under
//! it, then the first part, which switches to them in one call, and then removes every part of
//! older generations. A write cut short leaves the previous value whole, never a mix of old and new
//! parts; a read with a missing part fails ([`StoreError::Failed`]) rather than return a piece. One
//! lock serializes the calls of this app, which serves secret requests on several threads.
//!
//! Documented limit (S4, like S25.7 on Linux; docs/install.md): the Credential Manager has no
//! per-program access list, so any process of the same user can read these credentials
//! (`CredReadW`), the agent's shell included. Without a logon session that can keep credentials
//! (for example a service or a network logon), every call fails with [`StoreError::Unavailable`],
//! so connectors that need a secret fail closed.

use super::{check_id, wipe, Secret, SecretStore, StoreError, SERVICE};
use std::sync::{Mutex, PoisonError};
use std::{mem, ptr, slice};
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_NOT_FOUND, ERROR_NO_SUCH_LOGON_SESSION, GetLastError};
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredEnumerateW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CREDENTIAL_ATTRIBUTEW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

/// The most a credential holds (`CRED_MAX_CREDENTIAL_BLOB_SIZE`).
pub const PART: usize = 5 * 512;
/// The most parts a secret is kept in: 160 KiB, far above any token or sign-in.
pub const MAX_PARTS: usize = 64;
/// The attribute of the first part that says how many parts there are.
const PARTS_ATTRIBUTE: &str = "GentleDotParts";

/// The Credential Manager, under [`SERVICE`] (or another service, for tests).
pub struct CredentialManager {
    service: String,
    lock: Mutex<()>,
}

impl CredentialManager {
    pub fn new() -> Self {
        Self::with_service(SERVICE)
    }

    pub fn with_service(service: impl Into<String>) -> Self {
        CredentialManager { service: service.into(), lock: Mutex::new(()) }
    }

    /// `<service>/<id, case-encoded>`: the secret, or its first part (see [`encode_case`]).
    fn target(&self, id: &str) -> String {
        format!("{}/{}", self.service, encode_case(id))
    }

    /// `<service>/<id>#<generation>-<part>`, for the second part on.
    fn part_target(&self, id: &str, generation: &str, part: usize) -> String {
        format!("{}#{generation}-{part}", self.target(id))
    }
}

impl Default for CredentialManager {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for CredentialManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialManager").field("service", &self.service).finish()
    }
}

/// The Credential Manager finds targets without regard to case, and which of two targets that
/// differ only in case it returns is not fixed, while ids are case-sensitive (`env/FOO` and
/// `env/foo` are two secrets). So a target never holds an upper-case letter: each one becomes `^`
/// and its lower-case form (`^` is never in an id), and two ids always make two targets.
fn encode_case(id: &str) -> String {
    let mut target = String::with_capacity(id.len() + 8);
    for c in id.chars() {
        if c.is_ascii_uppercase() {
            target.push('^');
            target.push(c.to_ascii_lowercase());
        } else {
            target.push(c);
        }
    }
    target
}

/// The id [`encode_case`] made `target` from; `None` for a target it could not have made.
fn decode_case(target: &str) -> Option<String> {
    let mut id = String::with_capacity(target.len());
    let mut chars = target.chars();
    while let Some(c) = chars.next() {
        match c {
            '^' => id.push(chars.next().filter(char::is_ascii_lowercase)?.to_ascii_uppercase()),
            c if c.is_ascii_uppercase() => return None,
            c => id.push(c),
        }
    }
    Some(id)
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// A NUL-terminated UTF-16 string from the Credential Manager.
///
/// # Safety
/// `text` is null or points to a NUL-terminated UTF-16 string.
unsafe fn from_wide(text: *const u16) -> String {
    if text.is_null() {
        return String::new();
    }
    // SAFETY: NUL-terminated, per the caller.
    let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    // SAFETY: `len` units before the NUL.
    String::from_utf16_lossy(unsafe { slice::from_raw_parts(text, len) })
}

pub(crate) fn store_error(code: u32) -> StoreError {
    match code {
        ERROR_ACCESS_DENIED => StoreError::Denied,
        ERROR_NO_SUCH_LOGON_SESSION => StoreError::Unavailable(
            "this Windows logon cannot keep credentials (for example a service or a network logon); sign in to Windows interactively".into(),
        ),
        code => StoreError::Failed(format!("{} (error {code})", std::io::Error::from_raw_os_error(code as i32))),
    }
}

fn last_error() -> u32 {
    // SAFETY: no preconditions.
    unsafe { GetLastError() }
}

/// One credential as read: its blob (wiped when dropped) and its parts attribute.
struct Read {
    blob: Vec<u8>,
    parts: Option<String>,
}

/// The first part's `<count>:<generation>`; none (one part) when there is no attribute.
fn parse_parts(attribute: Option<&str>) -> Result<(usize, &str), StoreError> {
    let foreign = || StoreError::Failed("the stored secret is not one Gentle Dot wrote".into());
    let Some(text) = attribute else {
        return Ok((1, ""));
    };
    let (count, generation) = text.split_once(':').ok_or_else(foreign)?;
    let count: usize = count.parse().map_err(|_| foreign())?;
    let generation_ok = !generation.is_empty() && generation.len() <= 32 && generation.bytes().all(|b| b.is_ascii_hexdigit());
    if count == 0 || count > MAX_PARTS || !generation_ok {
        return Err(foreign());
    }
    Ok((count, generation))
}

impl Drop for Read {
    fn drop(&mut self) {
        wipe(&mut self.blob);
    }
}

/// Reads the generic credential `target`; `None` when there is none.
fn read(target: &str) -> Result<Option<Read>, StoreError> {
    let name = wide(target);
    let mut found: *mut CREDENTIALW = ptr::null_mut();
    // SAFETY: a NUL-terminated name and an out-pointer, released with CredFree below.
    if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut found) } == 0 {
        return match last_error() {
            ERROR_NOT_FOUND => Ok(None),
            code => Err(store_error(code)),
        };
    }
    // SAFETY: CredReadW returned a credential, valid until CredFree.
    let credential = unsafe { &*found };
    let size = credential.CredentialBlobSize as usize;
    let blob = if size == 0 || credential.CredentialBlob.is_null() {
        Vec::new()
    } else {
        // SAFETY: the blob holds `size` bytes, ours to read and to wipe until CredFree.
        let bytes = unsafe { slice::from_raw_parts_mut(credential.CredentialBlob, size) };
        let copy = bytes.to_vec();
        wipe(bytes);
        copy
    };
    let mut parts = None;
    let attributes: &[CREDENTIAL_ATTRIBUTEW] = if credential.Attributes.is_null() {
        &[]
    } else {
        // SAFETY: `AttributeCount` attributes, valid until CredFree.
        unsafe { slice::from_raw_parts(credential.Attributes, credential.AttributeCount as usize) }
    };
    for attribute in attributes {
        // SAFETY: a NUL-terminated keyword and `ValueSize` bytes of value, valid until CredFree.
        let keyword = unsafe { from_wide(attribute.Keyword) };
        if keyword == PARTS_ATTRIBUTE && !attribute.Value.is_null() {
            // SAFETY: as above.
            let value = unsafe { slice::from_raw_parts(attribute.Value, attribute.ValueSize as usize) };
            parts = Some(String::from_utf8_lossy(value).into_owned());
        }
    }
    // SAFETY: the credential CredReadW returned, freed once.
    unsafe { CredFree(found.cast()) };
    Ok(Some(Read { blob, parts }))
}

/// Writes `target`, replacing any credential there. `parts` goes in the first part's attribute.
fn write(target: &str, id: &str, comment: &str, blob: &[u8], parts: Option<&str>) -> Result<(), StoreError> {
    let (mut name, mut user, mut comment) = (wide(target), wide(id), wide(comment));
    let mut keyword = wide(PARTS_ATTRIBUTE);
    let mut value = parts.map(|text| text.as_bytes().to_vec()).unwrap_or_default();
    let mut attribute = CREDENTIAL_ATTRIBUTEW {
        Keyword: keyword.as_mut_ptr(),
        Flags: 0,
        ValueSize: value.len() as u32,
        Value: value.as_mut_ptr(),
    };
    // SAFETY: an all-zero CREDENTIALW is valid.
    let mut credential: CREDENTIALW = unsafe { mem::zeroed() };
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = name.as_mut_ptr();
    credential.UserName = user.as_mut_ptr();
    credential.Comment = comment.as_mut_ptr();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.CredentialBlobSize = blob.len() as u32;
    // CredWriteW only reads the blob.
    credential.CredentialBlob = if blob.is_empty() { ptr::null_mut() } else { blob.as_ptr().cast_mut() };
    if parts.is_some() {
        credential.AttributeCount = 1;
        credential.Attributes = &mut attribute;
    }
    // SAFETY: every pointer in `credential` points to a buffer alive for the call.
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(store_error(last_error()));
    }
    Ok(())
}

/// Deletes `target`; false when there was none.
fn remove(target: &str) -> Result<bool, StoreError> {
    let name = wide(target);
    // SAFETY: a NUL-terminated name.
    if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
        return match last_error() {
            ERROR_NOT_FOUND => Ok(false),
            code => Err(store_error(code)),
        };
    }
    Ok(true)
}

/// The targets of every generic credential matching `filter` (a trailing `*` matches any end).
fn targets(filter: &str) -> Result<Vec<String>, StoreError> {
    let filter = wide(filter);
    let mut count = 0u32;
    let mut found: *mut *mut CREDENTIALW = ptr::null_mut();
    // SAFETY: a NUL-terminated filter and out-pointers, released with CredFree below.
    if unsafe { CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut found) } == 0 {
        return match last_error() {
            ERROR_NOT_FOUND => Ok(Vec::new()),
            code => Err(store_error(code)),
        };
    }
    // SAFETY: `count` credential pointers, valid until CredFree.
    let credentials = unsafe { slice::from_raw_parts(found, count as usize) };
    let names = credentials
        .iter()
        // SAFETY: each pointer is a credential with a NUL-terminated target, valid until CredFree.
        .filter(|credential| unsafe { (***credential).Type } == CRED_TYPE_GENERIC)
        // SAFETY: as above.
        .map(|credential| unsafe { from_wide((**credential).TargetName) })
        .collect();
    // SAFETY: the array CredEnumerateW returned, freed once.
    unsafe { CredFree(found.cast()) };
    Ok(names)
}

impl CredentialManager {
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Removes every part of `id` but those of `keep` (a generation); true when one was removed.
    fn remove_parts_except(&self, id: &str, keep: Option<&str>) -> Result<bool, StoreError> {
        let prefix = format!("{}#", self.target(id));
        let kept = keep.map(|generation| format!("{prefix}{generation}-"));
        let mut removed = false;
        for target in targets(&format!("{prefix}*"))? {
            if kept.as_deref().is_some_and(|kept| target.starts_with(kept)) {
                continue;
            }
            removed |= remove(&target)?;
        }
        Ok(removed)
    }
}

impl SecretStore for CredentialManager {
    fn put(&self, id: &str, secret: &Secret) -> Result<(), StoreError> {
        check_id(id)?;
        let bytes = secret.expose().as_bytes();
        let pieces: Vec<&[u8]> = if bytes.is_empty() { vec![&[][..]] } else { bytes.chunks(PART).collect() };
        if pieces.len() > MAX_PARTS {
            return Err(StoreError::Failed(format!(
                "the secret is too large for the Windows Credential Manager (over {} KiB)",
                MAX_PARTS * PART / 1024
            )));
        }
        let _guard = self.guard();
        let comment = format!("Gentle Dot connector: {id}");
        if pieces.len() == 1 {
            write(&self.target(id), id, &comment, pieces[0], None)?;
            self.remove_parts_except(id, None)?;
            return Ok(());
        }
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|error| StoreError::Failed(format!("no random generation: {error}")))?;
        let generation: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        for (index, piece) in pieces.iter().enumerate().skip(1) {
            let part = index + 1;
            write(&self.part_target(id, &generation, part), id, &format!("{comment} (part {part})"), piece, None)?;
        }
        // The first part switches to the new parts in one write; the old ones go after it.
        write(&self.target(id), id, &comment, pieces[0], Some(&format!("{}:{generation}", pieces.len())))?;
        self.remove_parts_except(id, Some(&generation))?;
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<Secret>, StoreError> {
        check_id(id)?;
        let _guard = self.guard();
        let Some(first) = read(&self.target(id))? else {
            return Ok(None);
        };
        let (parts, generation) = parse_parts(first.parts.as_deref())?;
        let mut value = Read { blob: Vec::with_capacity(parts * PART), parts: None };
        value.blob.extend_from_slice(&first.blob);
        for part in 2..=parts {
            let Some(next) = read(&self.part_target(id, generation, part))? else {
                return Err(StoreError::Failed("the stored secret is incomplete (a part is missing)".into()));
            };
            value.blob.extend_from_slice(&next.blob);
        }
        match String::from_utf8(mem::take(&mut value.blob)) {
            Ok(text) => Ok(Some(Secret::new(text))),
            Err(error) => {
                wipe(&mut error.into_bytes());
                Err(StoreError::NotText)
            }
        }
    }

    fn delete(&self, id: &str) -> Result<bool, StoreError> {
        check_id(id)?;
        let _guard = self.guard();
        let first = remove(&self.target(id))?;
        let rest = self.remove_parts_except(id, None)?;
        Ok(first || rest)
    }

    fn list_ids(&self) -> Result<Vec<String>, StoreError> {
        let _guard = self.guard();
        let prefix = format!("{}/", self.service);
        let mut ids: Vec<String> = targets(&format!("{prefix}*"))?
            .into_iter()
            .filter_map(|target| target.strip_prefix(&prefix).and_then(decode_case))
            .filter(|id| check_id(id).is_ok())
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_store_shows_its_service_only() {
        assert_eq!(
            format!("{:?}", CredentialManager::new()),
            "CredentialManager { service: \"dev.gentleman.gentle-dot.connectors\" }"
        );
    }

    #[test]
    fn targets_name_the_service_the_id_and_later_parts() {
        let store = CredentialManager::new();
        assert_eq!(store.target("connector/slack/value/token"), "dev.gentleman.gentle-dot.connectors/connector/slack/value/token");
        assert_eq!(store.part_target("a", "0f", 2), "dev.gentleman.gentle-dot.connectors/a#0f-2");
        // A part's target is never a valid id, so it never shows up as one.
        assert_eq!(check_id("a#0f-2"), Err(StoreError::InvalidId));
    }

    #[test]
    fn ids_keep_their_case_in_targets_that_have_none() {
        for id in ["connector/slack/header/Authorization", "env/FOO", "env/foo", "a.b@c:d-e_f/G", "lower/only"] {
            let target = encode_case(id);
            assert!(!target.chars().any(|c| c.is_ascii_uppercase()), "{target}");
            assert_eq!(decode_case(&target).as_deref(), Some(id));
        }
        assert_eq!(encode_case("env/Foo"), "env/^foo");
        assert_ne!(encode_case("env/FOO"), encode_case("env/foo"));
        // A target the encoding could not make is no id.
        for foreign in ["Env/foo", "env/^", "env/^1", "env/^^a"] {
            assert_eq!(decode_case(foreign), None, "{foreign}");
        }
        assert_eq!(CredentialManager::new().target("env/Foo"), "dev.gentleman.gentle-dot.connectors/env/^foo");
    }

    #[test]
    fn the_parts_attribute_is_a_count_and_a_hex_generation() {
        assert_eq!(parse_parts(None), Ok((1, "")));
        assert_eq!(parse_parts(Some("3:a1b2")), Ok((3, "a1b2")));
        let long = format!("2:{}", "a".repeat(33));
        for bad in ["3", "0:aa", "65:aa", "x:aa", "2:", "2:../x", "2:zz", long.as_str(), "2:a*", "2:a-1", "64:", "-1:aa", " 2:aa"] {
            assert!(matches!(parse_parts(Some(bad)), Err(StoreError::Failed(_))), "{bad}");
        }
        assert_eq!(parse_parts(Some("64:00")), Ok((64, "00")));
    }

    #[test]
    fn credential_errors_map_to_denied_unavailable_or_failed() {
        assert_eq!(store_error(ERROR_ACCESS_DENIED), StoreError::Denied);
        assert!(matches!(store_error(ERROR_NO_SUCH_LOGON_SESSION), StoreError::Unavailable(_)));
        let StoreError::Failed(why) = store_error(87) else { panic!("not failed") };
        assert!(why.ends_with("(error 87)"), "{why}");
    }

    /// A throwaway service in the real Credential Manager, emptied whatever happens.
    fn with_throwaway(test: impl FnOnce(&CredentialManager) + std::panic::UnwindSafe) {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let store = CredentialManager::with_service(format!("dev.gentleman.gentle-dot.test.{suffix}"));
        let outcome = std::panic::catch_unwind(|| test(&store));
        for target in targets(&format!("{}/*", store.service)).unwrap_or_default() {
            let _ = remove(&target);
        }
        assert!(targets(&format!("{}/*", store.service)).unwrap().is_empty(), "something was left behind");
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }

    /// Touches the real Credential Manager of the user running the tests, under a throwaway
    /// service, and removes everything it created. `cargo test real_credential -- --ignored`.
    #[test]
    #[ignore = "uses the real Credential Manager"]
    fn real_credential_manager_keeps_the_contract_under_a_throwaway_service() {
        with_throwaway(|store| super::super::check_contract(store));
    }

    #[test]
    #[ignore = "uses the real Credential Manager"]
    fn real_credential_manager_keeps_a_long_secret_in_parts_and_never_returns_a_piece() {
        with_throwaway(|store| {
            let id = "connector/notion/signin";
            let long: String = (0..3 * PART + 17).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
            store.put(id, &Secret::new(long.as_str())).unwrap();
            assert_eq!(store.get(id).unwrap().unwrap().expose(), long);
            let all = |store: &CredentialManager| targets(&format!("{}*", store.target(id))).unwrap();
            // Parts never show up as ids.
            assert_eq!(store.list_ids().unwrap(), vec![id]);
            assert_eq!(all(store).len(), 4);
            // Rewriting it leaves only the new generation's parts.
            let other: String = long.chars().rev().collect();
            store.put(id, &Secret::new(other.as_str())).unwrap();
            assert_eq!(store.get(id).unwrap().unwrap().expose(), other);
            assert_eq!(all(store).len(), 4);
            // A shorter value leaves no part of the longer one behind.
            store.put(id, &Secret::new("short")).unwrap();
            assert_eq!(store.get(id).unwrap().unwrap().expose(), "short");
            assert_eq!(all(store), vec![store.target(id)]);
            // A missing part fails instead of returning a piece.
            store.put(id, &Secret::new(long.as_str())).unwrap();
            let third = all(store).into_iter().find(|target| target.ends_with("-3")).unwrap();
            assert!(remove(&third).unwrap());
            assert!(matches!(store.get(id).unwrap_err(), StoreError::Failed(why) if why.contains("incomplete")));
            // Deleting removes every part.
            assert!(store.delete(id).unwrap());
            assert!(all(store).is_empty());
            // Over the limit nothing is written.
            let huge = "x".repeat(MAX_PARTS * PART + 1);
            assert!(matches!(store.put(id, &Secret::new(huge.as_str())).unwrap_err(), StoreError::Failed(why) if why.contains("too large")));
            assert!(store.list_ids().unwrap().is_empty());
        });
    }

    /// A write cut short after its new parts, before the first part switches to them (a crash), or
    /// parts a same-user process planted under another generation: the stored value reads whole.
    #[test]
    #[ignore = "uses the real Credential Manager"]
    fn real_credential_manager_never_mixes_parts_of_two_writes() {
        with_throwaway(|store| {
            let id = "connector/slack/signin";
            let old: String = "o".repeat(2 * PART + 5);
            store.put(id, &Secret::new(old.as_str())).unwrap();
            for part in 2..=3 {
                write(&store.part_target(id, "deadbeef", part), id, "cut short", &vec![b'n'; PART], None).unwrap();
            }
            assert_eq!(store.get(id).unwrap().unwrap().expose(), old);
            // The next write removes the stray parts too.
            store.put(id, &Secret::new("new")).unwrap();
            assert_eq!(targets(&format!("{}*", store.target(id))).unwrap(), vec![store.target(id)]);
        });
    }

    #[test]
    #[ignore = "uses the real Credential Manager"]
    fn real_credential_manager_delete_never_touches_a_neighbouring_id() {
        with_throwaway(|store| {
            let long: String = "z".repeat(2 * PART + 1);
            for id in ["a", "a/b", "ab"] {
                store.put(id, &Secret::new(long.as_str())).unwrap();
            }
            assert!(store.delete("a").unwrap());
            assert_eq!(store.list_ids().unwrap(), vec!["a/b", "ab"]);
            assert_eq!(store.get("a/b").unwrap().unwrap().expose(), long);
            assert_eq!(store.get("ab").unwrap().unwrap().expose(), long);
        });
    }

    /// Two ids that differ only in case are two secrets, as on macOS and Linux. Without the case
    /// encoding the Credential Manager answered either value for either id, varying between runs.
    #[test]
    #[ignore = "uses the real Credential Manager"]
    fn real_credential_manager_keeps_ids_that_differ_only_in_case_apart() {
        with_throwaway(|store| {
            let long = "L".repeat(PART + 1);
            store.put("x/Foo", &Secret::new("upper")).unwrap();
            store.put("x/foo", &Secret::new(long.as_str())).unwrap();
            store.put("x/FOO", &Secret::new("all upper")).unwrap();
            let read = |id: &str| store.get(id).unwrap().map(|s| s.expose().to_owned());
            assert_eq!(read("x/Foo").as_deref(), Some("upper"));
            assert_eq!(read("x/foo"), Some(long.clone()));
            assert_eq!(read("x/FOO").as_deref(), Some("all upper"));
            assert_eq!(store.list_ids().unwrap(), vec!["x/FOO", "x/Foo", "x/foo"]);
            assert!(store.delete("x/foo").unwrap());
            assert_eq!(read("x/foo"), None);
            assert_eq!(read("x/Foo").as_deref(), Some("upper"));
            assert_eq!(store.list_ids().unwrap(), vec!["x/FOO", "x/Foo"]);
        });
    }

    /// The documented limit (S4): any process of the same user reads the credential.
    #[test]
    #[ignore = "uses the real Credential Manager"]
    fn real_credential_manager_is_readable_by_any_process_of_the_user() {
        with_throwaway(|store| {
            store.put("limit/demo", &Secret::new("readable-by-the-same-user")).unwrap();
            let script = format!(
                "$t=Add-Type -PassThru -Name C -Namespace W -MemberDefinition '[DllImport(\"advapi32\",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CredReadW(string t,int y,int f,out System.IntPtr c);';\
                 $p=[IntPtr]::Zero; if($t::CredReadW('{}',1,0,[ref]$p)){{$s=[Runtime.InteropServices.Marshal]::ReadInt32($p,32);$b=[Runtime.InteropServices.Marshal]::ReadIntPtr($p,40);\
                 $a=New-Object byte[] $s;[Runtime.InteropServices.Marshal]::Copy($b,$a,0,$s);[Text.Encoding]::UTF8.GetString($a)}}",
                store.target("limit/demo")
            );
            match std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output() {
                Ok(output) => assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "readable-by-the-same-user"),
                Err(error) => eprintln!("powershell not run ({error}); the same-user read is not shown"),
            }
        });
    }
}
