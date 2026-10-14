//! Windows filesystem privacy. The trusted desktop confirmation boundary is outside this module.
use std::{fs::File, io::{self, Read, Write}, path::{Path, PathBuf}, ptr, mem};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT, ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertSecurityDescriptorToStringSecurityDescriptorW, SDDL_REVISION_1};
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_USER, TOKEN_QUERY, PSECURITY_DESCRIPTOR, OWNER_SECURITY_INFORMATION, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, GetSecurityDescriptorControl, GetAclInformation, GetAce, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, ACE_HEADER, ACCESS_ALLOWED_ACE};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

struct Local(*mut core::ffi::c_void);
impl Drop for Local { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }
fn text(pointer: *const u16) -> String {
    let len = (0..).take_while(|&i| unsafe { *pointer.add(i) } != 0).count();
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(pointer, len) })
}
fn sid_text(sid: *mut core::ffi::c_void) -> io::Result<String> {
    let mut out = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut out) } == 0 { return Err(io::Error::last_os_error()); }
    let allocation = Local(out.cast());
    let result = text(out);
    drop(allocation);
    Ok(result)
}
fn user_sid() -> io::Result<String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 { return Err(io::Error::last_os_error()); }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut len = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, ptr::null_mut(), 0, &mut len); }
    let mut buffer = vec![0usize; (len as usize).div_ceil(mem::size_of::<usize>())];
    if unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, buffer.as_mut_ptr().cast(), len, &mut len) } == 0 { return Err(io::Error::last_os_error()); }
    sid_text(unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid })
}
fn descriptor(sid: &str, kind: Kind) -> io::Result<Local> {
    // A directory's ACE is inherited by what is created in it (OI, CI): files Node writes there are
    // owner-only without any ACL work of its own. A file's ACE is its own and inherits nothing.
    let inherit = if kind == Kind::Directory { "OICI" } else { "" };
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;{inherit};FA;;;{sid})").encode_utf16().chain(Some(0)).collect();
    let mut out = ptr::null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut out, ptr::null_mut()) } == 0 { return Err(io::Error::last_os_error()); }
    Ok(Local(out))
}
fn descriptor_text(sd: PSECURITY_DESCRIPTOR) -> io::Result<String> {
    let mut out = ptr::null_mut();
    if unsafe { ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &mut out, ptr::null_mut()) } == 0 { return Err(io::Error::last_os_error()); }
    let allocation = Local(out.cast());
    let result = text(out);
    drop(allocation);
    Ok(result)
}
fn security(handle: HANDLE) -> io::Result<(String, String)> {
    let mut owner = ptr::null_mut();
    let mut sd = ptr::null_mut();
    let status = unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &mut owner, ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), &mut sd) };
    if status != 0 { return Err(io::Error::from_raw_os_error(status as i32)); }
    let allocation = Local(sd);
    let result = (sid_text(owner)?, descriptor_text(sd)?);
    drop(allocation);
    Ok(result)
}
fn denied(message: &str) -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, message) }
/// What a private object is: a directory also hands its owner-only access to what is created in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind { Directory, File }
// ACE bits from winnt.h.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const OBJECT_INHERIT_ACE: u8 = 0x1;
const CONTAINER_INHERIT_ACE: u8 = 0x2;
const NO_PROPAGATE_INHERIT_ACE: u8 = 0x4;
const INHERIT_ONLY_ACE: u8 = 0x8;
const INHERITED_ACE: u8 = 0x10;
const SE_DACL_PROTECTED: u16 = 0x1000;
const FILE_ALL_ACCESS: u32 = 0x1f_01ff;
/// Whether `sd` leaves the object to the user alone: owner is the user, a DACL is present with exactly
/// one ACCESS_ALLOWED ACE granting the user full access, and that ACE is either explicit under a
/// protected DACL or (only when `inherited_ok`, i.e. inside the pinned private directory) inherited.
/// A directory's ACE must inherit to files and folders; a file's must not. Anything else is not
/// private: a missing or NULL DACL, an extra or deny ACE, another trustee or owner, partial rights.
fn private_descriptor(sd: PSECURITY_DESCRIPTOR, sid: &str, kind: Kind, inherited_ok: bool) -> io::Result<bool> {
    let mut owner = ptr::null_mut();
    let mut defaulted = 0;
    if unsafe { GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted) } == 0 { return Err(io::Error::last_os_error()); }
    if owner.is_null() || sid_text(owner)? != sid { return Ok(false); }
    let (mut control, mut revision) = (0u16, 0u32);
    if unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) } == 0 { return Err(io::Error::last_os_error()); }
    let (mut present, mut acl): (_, *mut ACL) = (0, ptr::null_mut());
    if unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted) } == 0 { return Err(io::Error::last_os_error()); }
    if present == 0 || acl.is_null() { return Ok(false); }
    let mut size: ACL_SIZE_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { GetAclInformation(acl, ptr::addr_of_mut!(size).cast(), mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) } == 0 { return Err(io::Error::last_os_error()); }
    if size.AceCount != 1 { return Ok(false); }
    let mut ace = ptr::null_mut();
    if unsafe { GetAce(acl, 0, &mut ace) } == 0 { return Err(io::Error::last_os_error()); }
    let (header, allowed) = (ace.cast::<ACE_HEADER>(), ace.cast::<ACCESS_ALLOWED_ACE>());
    let (kind_of_ace, flags, ace_size) = unsafe { ((*header).AceType, (*header).AceFlags, (*header).AceSize) };
    if kind_of_ace != ACCESS_ALLOWED_ACE_TYPE || (ace_size as usize) < mem::size_of::<ACCESS_ALLOWED_ACE>() { return Ok(false); }
    if unsafe { (*allowed).Mask } & FILE_ALL_ACCESS != FILE_ALL_ACCESS { return Ok(false); }
    if sid_text(unsafe { ptr::addr_of_mut!((*allowed).SidStart) }.cast())? != sid { return Ok(false); }
    if flags & (INHERIT_ONLY_ACE | NO_PROPAGATE_INHERIT_ACE) != 0 { return Ok(false); }
    let inherits = flags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE);
    if inherits != if kind == Kind::Directory { OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE } else { 0 } { return Ok(false); }
    // SE_DACL_AUTO_INHERITED is bookkeeping, not an inherited ACE or loss of protection.
    Ok(match (control & SE_DACL_PROTECTED != 0, flags & INHERITED_ACE != 0) {
        (true, false) => true,
        (false, true) => inherited_ok,
        _ => false,
    })
}
fn private_handle(handle: HANDLE, sid: &str, kind: Kind, inherited_ok: bool) -> io::Result<bool> {
    let mut sd = ptr::null_mut();
    let status = unsafe { GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), &mut sd) };
    if status != 0 { return Err(io::Error::from_raw_os_error(status as i32)); }
    let allocation = Local(sd);
    let result = private_descriptor(sd, sid, kind, inherited_ok);
    drop(allocation);
    result
}
// The raw descriptor text is kept in consent snapshots, to tell a stale preview from a current one.

use windows_sys::Win32::Storage::FileSystem::{CreateFileW, GetFileType, GetFileInformationByHandle, GetFinalPathNameByHandleW, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_RENAME_INFO, FILE_DISPOSITION_INFO, FileDispositionInfo, FILE_TYPE_DISK, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, OPEN_EXISTING};
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;

const READ_CONTROL: u32 = 0x20000;
const WRITE_DAC: u32 = 0x40000;
const DELETE: u32 = 0x10000;
const SYNCHRONIZE: u32 = 0x100000;
const ATTRIBUTES: u32 = 0x80;
const DIRECTORY_ACCESS: u32 = READ_CONTROL | WRITE_DAC | SYNCHRONIZE | ATTRIBUTES | 1 | 2;
// Listing is a share-checked right, which is what lets the share mode refuse DELETE: a handle with
// control and attribute access alone is not share-checked and would let the directory be renamed.
// Others may still read, write and watch it (they share READ|WRITE) and create or rename inside.
const PIN_ACCESS: u32 = READ_CONTROL | SYNCHRONIZE | ATTRIBUTES | 1;
const PEEK_ACCESS: u32 = READ_CONTROL | SYNCHRONIZE | ATTRIBUTES;
const FILE_ACCESS: u32 = READ_CONTROL | WRITE_DAC | SYNCHRONIZE | ATTRIBUTES;
const SENSITIVE: [&str; 4] = ["daemon.log", "daemon.pid", "token", "connectors.json"];
// ntifs.h FILE_INFORMATION_CLASS FileRenameInformationEx and its FILE_RENAME_* flags.
const FILE_RENAME_INFORMATION_EX: u32 = 65;
const RENAME_REPLACE_IF_EXISTS: u32 = 0x1;
const RENAME_POSIX_SEMANTICS: u32 = 0x2;

// ABI verified against the previously inspected Windows SDK winternl.h (10.0.26100.0).
// NtCreateFile is needed because CreateFileW cannot take a directory RootDirectory.
// All calls are synchronous; no APC or asynchronous IO_STATUS_BLOCK lifetimes are involved.
#[repr(C)]
struct UnicodeString { length: u16, maximum_length: u16, buffer: *mut u16 }
#[repr(C)]
struct ObjectAttributes { length: u32, root: HANDLE, name: *mut UnicodeString, attributes: u32, security: PSECURITY_DESCRIPTOR, qos: *mut core::ffi::c_void }
#[repr(C)]
struct IoStatus { status_or_pointer: usize, information: usize }
// This backend is scoped to the Windows x64 target in the feature document.
const _: () = {
    assert!(mem::size_of::<UnicodeString>() == 16);
    assert!(mem::offset_of!(UnicodeString, buffer) == 8);
    assert!(mem::size_of::<ObjectAttributes>() == 48);
    assert!(mem::offset_of!(ObjectAttributes, security) == 32);
    assert!(mem::size_of::<IoStatus>() == 16);
    assert!(mem::offset_of!(FILE_RENAME_INFO, RootDirectory) == 8);
    assert!(mem::offset_of!(FILE_RENAME_INFO, FileName) == 20);
};
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(handle: *mut HANDLE, access: u32, attributes: *mut ObjectAttributes, status: *mut IoStatus, allocation: *mut i64, file_attributes: u32, share: u32, disposition: u32, options: u32, ea: *mut core::ffi::c_void, ea_length: u32) -> i32;
    fn NtSetInformationFile(file: HANDLE, status: *mut IoStatus, information: *const core::ffi::c_void, length: u32, class: u32) -> i32;
}
fn native_open(root: HANDLE, name: &str, access: u32, share: u32, create: bool, directory: bool, sd: PSECURITY_DESCRIPTOR) -> io::Result<OwnedHandle> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['\\', '/', ':', '\0']) {
        return Err(denied("unsafe relative filesystem component"));
    }
    let mut name: Vec<u16> = name.encode_utf16().collect();
    let bytes = u16::try_from(name.len() * 2).map_err(|_| denied("filesystem component too long"))?;
    let mut unicode = UnicodeString { length: bytes, maximum_length: bytes, buffer: name.as_mut_ptr() };
    let mut attributes = ObjectAttributes { length: mem::size_of::<ObjectAttributes>() as u32, root, name: &mut unicode, attributes: 0x40, security: sd, qos: ptr::null_mut() };
    let mut status = IoStatus { status_or_pointer: 0, information: 0 };
    let mut handle = ptr::null_mut();
    // FILE_DIRECTORY_FILE or FILE_NON_DIRECTORY_FILE, FILE_SYNCHRONOUS_IO_NONALERT;
    // leaf files additionally use FILE_OPEN_REPARSE_POINT. Directories intentionally resolve links.
    let options = 0x20 | if directory { 1 } else { 0x40 | 0x200000 };
    let result = unsafe { NtCreateFile(&mut handle, access, &mut attributes, &mut status, ptr::null_mut(), 0x80, share, if create { 2 } else { 1 }, options, ptr::null_mut(), 0) };
    if result < 0 {
        return Err(if result as u32 == 0xc0000034 || result as u32 == 0xc000003a {
            io::Error::new(io::ErrorKind::NotFound, "filesystem object not found")
        } else { io::Error::other(format!("anchored filesystem open refused (NTSTATUS 0x{:08x})", result as u32)) });
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}
fn information(handle: HANDLE, directory: bool) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK { return Err(denied("not a disk filesystem object")); }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 { return Err(io::Error::last_os_error()); }
    if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(denied("sensitive leaf reparse or nonregular filesystem object refused"));
    }
    if !directory && info.nNumberOfLinks != 1 { return Err(denied("sensitive hardlinked file refused")); }
    Ok(info)
}
fn identity(info: &BY_HANDLE_FILE_INFORMATION) -> (u32, u64) {
    (info.dwVolumeSerialNumber, ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64)
}
fn final_path(handle: HANDLE) -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let len = unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if len == 0 { return Err(io::Error::last_os_error()); }
    if len as usize >= buffer.len() { return Err(denied("resolved filesystem path too long")); }
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])))
}
/// How the final directory is held. Only adoption needs it exclusive (share=0): Microsoft documents
/// that SetSecurityInfo does not propagate ACEs to descendants then. Renaming a file or watching
/// a directory makes Windows open that directory, so an exclusive or data-access handle would break
/// the daemon's own temp-file-and-rename writes and `fs.watch` in its data directory. Everything else
/// pins it with `PIN_ACCESS` and sharing READ|WRITE but not DELETE: others work inside it, and nobody
/// can rename or delete the pinned directory while it is held (verified by the pinned-directory test).
#[derive(Clone, Copy)]
enum Hold { Pinned, Exclusive }
fn open_directory(path: &Path, create: bool, hold: Hold) -> io::Result<OwnedHandle> {
    use std::path::{Component, Prefix};
    let absolute = std::path::absolute(path)?;
    let mut components = absolute.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() { Prefix::Disk(d) | Prefix::VerbatimDisk(d) => d, _ => return Err(denied("only verifiable local-volume filesystem paths are supported")) },
        _ => return Err(denied("a local-volume filesystem path is required")),
    };
    if !matches!(components.next(), Some(Component::RootDir)) { return Err(denied("a rooted filesystem path is required")); }
    let names: Vec<_> = components.map(|component| match component { Component::Normal(name) => name.to_str().map(str::to_owned).ok_or_else(|| denied("non-Unicode component refused")), _ => Err(denied("ambiguous filesystem component refused")) }).collect::<io::Result<_>>()?;
    if names.is_empty() { return Err(denied("a volume root cannot be application storage")); }
    let root: Vec<u16> = format!("{}:\\", drive as char).encode_utf16().chain(Some(0)).collect();
    let raw = unsafe { CreateFileW(root.as_ptr(), READ_CONTROL | SYNCHRONIZE | ATTRIBUTES | 1, 7, ptr::null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, ptr::null_mut()) };
    if raw == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    let mut handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    information(handle.as_raw_handle(), true)?;
    let sd = descriptor(&user_sid()?, Kind::Directory)?;
    for (index, name) in names.iter().enumerate() {
        let last = index + 1 == names.len();
        let (access, share) = match (last, hold) {
            (false, _) => (READ_CONTROL | SYNCHRONIZE | ATTRIBUTES | 1, 7),
            (true, Hold::Exclusive) => (DIRECTORY_ACCESS, 0),
            (true, Hold::Pinned) => (PIN_ACCESS, 3),
        };
        let next = match native_open(handle.as_raw_handle(), name, access, share, false, true, ptr::null_mut()) {
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => native_open(handle.as_raw_handle(), name, access, share, true, true, sd.0)?,
            result => result?,
        };
        information(next.as_raw_handle(), true)?;
        handle = next;
    }
    Ok(handle)
}

/// An actually opened object, not authorization inferred from a pathname or owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectPreview {
    pub name: String,
    pub resolved_path: PathBuf,
    pub volume: u32,
    pub file_id: u64,
    pub security: String,
}
struct Pinned { handle: OwnedHandle, description: ObjectPreview, directory: bool }
impl Pinned {
    fn new(handle: OwnedHandle, name: &str, directory: bool, sid: &str) -> io::Result<Self> {
        let info = information(handle.as_raw_handle(), directory)?;
        let (owner, security) = security(handle.as_raw_handle())?;
        if owner != sid { return Err(denied("filesystem object is not owned by the current user")); }
        let (volume, file_id) = identity(&info);
        let description = ObjectPreview { name: name.into(), resolved_path: final_path(handle.as_raw_handle())?, volume, file_id, security };
        Ok(Self { handle, description, directory })
    }
    fn unchanged(&self, sid: &str) -> io::Result<()> {
        let info = information(self.handle.as_raw_handle(), self.directory)?;
        let (owner, current) = security(self.handle.as_raw_handle())?;
        if owner != sid || current != self.description.security || identity(&info) != (self.description.volume, self.description.file_id) {
            return Err(denied("adoption preview is stale; inspect and confirm again"));
        }
        Ok(())
    }
}
/// Holds an exclusive directory handle. Children are always opened relative to it.
pub struct PrivateDir { directory: OwnedHandle, sid: String }
pub struct AdoptionPreview { directory: Pinned, files: Vec<Pinned>, sid: String }
pub struct AdoptionGrant { preview: AdoptionPreview }
pub enum DirectoryState { Ready(PrivateDir), Pending(AdoptionPreview) }
/// Exclusive handles on the directory and the sensitive files in it: adoption only.
fn preview(path: &Path) -> io::Result<AdoptionPreview> {
    let sid = user_sid()?;
    let directory = Pinned::new(open_directory(path, false, Hold::Exclusive)?, "application directory", true, &sid)?;
    let mut files = Vec::new();
    for name in SENSITIVE {
        match native_open(directory.handle.as_raw_handle(), name, FILE_ACCESS, 0, false, false, ptr::null_mut()) {
            Ok(handle) => files.push(Pinned::new(handle, name, false, &sid)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(error) => return Err(error),
        }
    }
    Ok(AdoptionPreview { directory, files, sid })
}
/// Whether the pinned directory and the sensitive files in it are private. The files are only
/// looked at (control access, full sharing), so a running daemon holding them does not matter.
fn is_ready(directory: &OwnedHandle, sid: &str) -> io::Result<bool> {
    if !private_handle(directory.as_raw_handle(), sid, Kind::Directory, false)? { return Ok(false); }
    for name in SENSITIVE {
        let file = match native_open(directory.as_raw_handle(), name, PEEK_ACCESS, 7, false, false, ptr::null_mut()) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        information(file.as_raw_handle(), false)?;
        // Inherited access counts here: the directory just proved private holds an inheritable ACE.
        if !private_handle(file.as_raw_handle(), sid, Kind::File, true)? { return Ok(false); }
    }
    Ok(true)
}
fn inspect_with_creation(path: &Path, create: bool) -> io::Result<DirectoryState> {
    let sid = user_sid()?;
    let directory = open_directory(path, create, Hold::Pinned)?;
    if is_ready(&directory, &sid)? { return Ok(DirectoryState::Ready(PrivateDir { directory, sid })); }
    // Needs adoption: take the exclusive handles it requires, never before knowing it does.
    drop(directory);
    Ok(DirectoryState::Pending(preview(path)?))
}
pub fn inspect(path: &Path) -> io::Result<DirectoryState> { inspect_with_creation(path, true) }
pub fn existing(path: &Path) -> io::Result<DirectoryState> { inspect_with_creation(path, false) }
pub fn prepare_adoption(path: &Path) -> io::Result<AdoptionPreview> { preview(path) }
/// Swaps adoption's exclusive handle for a pinned one. The exclusive handle must go first (its
/// sharing excludes any reader), so the directory is reopened by its resolved path and must be the
/// very same object (volume and file id) and still private; otherwise the pathname was swapped in
/// the gap and nothing is used.
fn release_to_pin(directory: Pinned, files: Vec<Pinned>, sid: &str) -> io::Result<OwnedHandle> {
    let ObjectPreview { resolved_path, volume, file_id, .. } = directory.description;
    drop(files);
    drop(directory.handle);
    let pinned = open_directory(&resolved_path, false, Hold::Pinned)?;
    if identity(&information(pinned.as_raw_handle(), true)?) != (volume, file_id) || !is_ready(&pinned, sid)? {
        return Err(denied("the adopted directory changed while its exclusive access was released"));
    }
    Ok(pinned)
}
impl AdoptionPreview {
    pub fn objects(&self) -> Vec<ObjectPreview> { std::iter::once(&self.directory).chain(&self.files).map(|object| object.description.clone()).collect() }
    /// The trusted desktop must confirm precisely objects() before calling this method.
    /// No daemon/runtime caller may treat selecting a directory as approval.
    pub fn explicitly_approve(self) -> AdoptionGrant { AdoptionGrant { preview: self } }
}
pub fn apply_adoption(grant: AdoptionGrant) -> io::Result<PrivateDir> {
    let preview = grant.preview;
    // Validate every snapshot before the first mutation. Exclusive handles prevent pathname
    // replacement; metadata-only same-user security handles can still invalidate a snapshot.
    for object in std::iter::once(&preview.directory).chain(&preview.files) { object.unchanged(&preview.sid)?; }
    for object in std::iter::once(&preview.directory).chain(&preview.files) {
        let kind = if object.directory { Kind::Directory } else { Kind::File };
        let sd = descriptor(&preview.sid, kind)?;
        let mut acl = ptr::null_mut(); let mut present = 0; let mut defaulted = 0;
        if unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut acl, &mut defaulted) } == 0 || present == 0 || acl.is_null() { return Err(io::Error::last_os_error()); }
        // Microsoft SetSecurityInfo documents no descendant propagation with an exclusively
        // opened directory (share=0), unlike protected-DACL alone. No MAXIMUM_ALLOWED access.
        let status = unsafe { SetSecurityInfo(object.handle.as_raw_handle(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, ptr::null_mut(), ptr::null_mut(), acl, ptr::null_mut()) };
        if status != 0 { return Err(io::Error::other(format!("applying private access failed: {}", io::Error::from_raw_os_error(status as i32)))); }
        if !private_handle(object.handle.as_raw_handle(), &preview.sid, kind, false)? { return Err(denied("private filesystem DACL readback failed")); }
    }
    // Partial setter failure may leave approved objects tighter; no unapproved object is repaired.
    // From here on the directory is only pinned: the exclusive handle exists for the adoption alone.
    let AdoptionPreview { directory, files, sid } = preview;
    let directory = release_to_pin(directory, files, &sid)?;
    Ok(PrivateDir { directory, sid })
}
impl PrivateDir {
    fn open_file(&self, name: &str, access: u32, share: u32, create: bool) -> io::Result<File> {
        let sd = descriptor(&self.sid, Kind::File)?;
        let handle = match native_open(self.directory.as_raw_handle(), name, access | READ_CONTROL | SYNCHRONIZE | ATTRIBUTES, share, false, false, ptr::null_mut()) {
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => native_open(self.directory.as_raw_handle(), name, access | READ_CONTROL | SYNCHRONIZE | ATTRIBUTES, share, true, false, sd.0)?,
            result => result?,
        };
        information(handle.as_raw_handle(), false)?;
        // Created here it is explicit; made by plain std::fs inside the pinned directory it is inherited.
        if !private_handle(handle.as_raw_handle(), &self.sid, Kind::File, true)? { return Err(denied("existing sensitive file requires explicit adoption")); }
        Ok(File::from(handle))
    }
    pub fn open_log(&self) -> io::Result<File> { self.open_file("daemon.log", 4, 3, true) }
    pub fn read_pid(&self) -> io::Result<Option<String>> {
        let file = match self.open_file("daemon.pid", 1, 1, false) { Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None), result => result? };
        if file.metadata()?.len() > 64 { return Err(denied("PID record exceeds 64 bytes")); }
        let mut record = String::new(); file.take(65).read_to_string(&mut record)?;
        if record.len() > 64 { return Err(denied("PID record exceeds 64 bytes")); }
        Ok(Some(record))
    }
    pub fn publish_pid(&self, record: &str) -> io::Result<()> {
        if record.len() > 64 { return Err(denied("PID record exceeds 64 bytes")); }
        let mut random = [0; 16]; getrandom::fill(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let name = format!(".daemon.pid.{suffix}");
        let sd = descriptor(&self.sid, Kind::File)?;
        let handle = native_open(self.directory.as_raw_handle(), &name, FILE_ACCESS | DELETE | 2, 0, true, false, sd.0)?;
        let mut temp = File::from(handle);
        let result = (|| {
            information(temp.as_raw_handle(), false)?;
            if !private_handle(temp.as_raw_handle(), &self.sid, Kind::File, false)? { return Err(denied("PID temporary file is not private")); }
            // Validate the existing destination before writing; keep its opened identity until rename.
            // Replacement requires delete sharing. The private directory excludes other-user races;
            // this does not defend against malicious same-user writers changing the destination name.
            let destination = match self.open_file("daemon.pid", DELETE, 4, false) { Err(error) if error.kind() == io::ErrorKind::NotFound => None, result => Some(result?) };
            temp.write_all(record.as_bytes())?; temp.sync_all()?;
            let name: Vec<u16> = "daemon.pid".encode_utf16().collect();
            let offset = mem::offset_of!(FILE_RENAME_INFO, FileName);
            let length = offset + name.len() * 2;
            let mut buffer = vec![0usize; length.div_ceil(mem::size_of::<usize>())];
            let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
            // Native FileRenameInformationEx (65), not Win32 FileRenameInfo (3), for two reasons
            // recorded in windows-support.md L42-L50 (diagnostic: odd/spikes/t6-rooted-rename):
            // 1. A simple name with NULL RootDirectory renames within the opened source file's
            //    parent; it does NOT resolve against CWD. An explicit root makes the native
            //    target open sharing-conflict with our exclusive parent handle (0xc0000043),
            //    which Win32 surfaced as ERROR_INVALID_PARAMETER (87).
            // 2. Plain replacement fails while the target has open handles (0xc0000022), and we
            //    deliberately hold `destination` so the validated entry cannot be swapped.
            //    POSIX semantics replace it while that handle stays open (Windows 10 RS1+).
            // A volume without POSIX rename support is refused below; FAT-family volumes also
            // lack the DACLs this module requires. Never release the pin as a workaround.
            // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information
            // Use the binding's asserted layout, not the anomalous Win32 webpage structure.
            unsafe {
                (*info).Anonymous.Flags = RENAME_REPLACE_IF_EXISTS | RENAME_POSIX_SEMANTICS;
                (*info).RootDirectory = ptr::null_mut();
                (*info).FileNameLength = (name.len() * 2) as u32;
                ptr::copy_nonoverlapping(name.as_ptr(), ptr::addr_of_mut!((*info).FileName).cast(), name.len());
            }
            let mut status = IoStatus { status_or_pointer: 0, information: 0 };
            let result = unsafe { NtSetInformationFile(temp.as_raw_handle(), &mut status, info.cast(), length as u32, FILE_RENAME_INFORMATION_EX) };
            if result < 0 { return Err(io::Error::other(format!("same-parent PID rename refused (NTSTATUS 0x{:08x})", result as u32))); }
            drop(destination);
            Ok(())
        })();
        if result.is_err() {
            // Delete this opened temporary object, not a name a racer could have substituted.
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            let cleanup = unsafe { SetFileInformationByHandle(temp.as_raw_handle(), FileDispositionInfo, (&disposition as *const FILE_DISPOSITION_INFO).cast(), mem::size_of::<FILE_DISPOSITION_INFO>() as u32) };
            if cleanup == 0 { return Err(io::Error::other(format!("{result:?}; owned PID temporary cleanup failed: {}", io::Error::last_os_error()))); }
        }
        result
    }
    pub fn remove_pid_if(&self, matches: impl FnOnce(&str) -> bool) -> io::Result<bool> {
        let mut file = match self.open_file("daemon.pid", DELETE | 1, 0, false) { Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false), result => result? };
        if file.metadata()?.len() > 64 { return Err(denied("PID record exceeds 64 bytes")); }
        let mut record = String::new(); (&mut file).take(65).read_to_string(&mut record)?;
        if record.len() > 64 || !matches(&record) { return Ok(false); }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe { SetFileInformationByHandle(file.as_raw_handle(), FileDispositionInfo, (&disposition as *const FILE_DISPOSITION_INFO).cast(), mem::size_of::<FILE_DISPOSITION_INFO>() as u32) } == 0 { return Err(io::Error::last_os_error()); }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
    fn scratch(label: &str) -> PathBuf {
        let mut random = [0; 16]; getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/privacy-tests").join(format!("{label}-{suffix}"))
    }
    fn state(path: &Path) -> String {
        let file = OpenOptions::new().access_mode(0x20000).share_mode(7).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(path).unwrap();
        security(file.as_raw_handle()).unwrap().1
    }
    // The expectation was the exact old SDDL; it is now the structural check (explicit, protected, owner-only).
    fn assert_private(path: &Path) { let kind = if path.is_dir() { Kind::Directory } else { Kind::File }; assert!(path_private(path, kind, false), "not private: {}", state(path)); }
    fn ready(path: &Path) -> PrivateDir {
        match inspect(path).unwrap() { DirectoryState::Ready(dir) => dir, DirectoryState::Pending(_) => panic!("fresh storage unexpectedly requires adoption") }
    }
    fn sd_of(sddl: &str) -> Local {
        let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut out = ptr::null_mut();
        assert_ne!(unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(wide.as_ptr(), SDDL_REVISION_1, &mut out, ptr::null_mut()) }, 0, "bad SDDL {sddl}");
        Local(out)
    }
    fn path_private(path: &Path, kind: Kind, inherited_ok: bool) -> bool {
        let file = OpenOptions::new().access_mode(0x20000).share_mode(7).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(path).unwrap();
        private_handle(file.as_raw_handle(), &user_sid().unwrap(), kind, inherited_ok).unwrap()
    }
    /// Replaces the protected DACL of `path` (as another same-user tool could).
    fn set_dacl(path: &Path, sddl: &str) {
        let handle = OpenOptions::new().access_mode(0x60000).share_mode(7).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(path).unwrap();
        let sd = sd_of(sddl); let mut acl = ptr::null_mut(); let mut present = 0; let mut defaulted = 0;
        assert_ne!(unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut acl, &mut defaulted) }, 0);
        assert_eq!(unsafe { SetSecurityInfo(handle.as_raw_handle(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, ptr::null_mut(), ptr::null_mut(), acl, ptr::null_mut()) }, 0);
    }
    #[test]
    fn a_ready_directory_is_pinned_without_blocking_ordinary_work_inside_it() {
        let path = scratch("pinned"); let dir = ready(&path);
        // What the Node daemon does in its data directory: temp file plus rename, replacement, a watch.
        fs::write(path.join("state.tmp"), "1").unwrap();
        fs::rename(path.join("state.tmp"), path.join("state.json")).unwrap();
        fs::write(path.join("state.tmp"), "2").unwrap();
        fs::rename(path.join("state.tmp"), path.join("state.json")).unwrap();
        assert_eq!(fs::read_to_string(path.join("state.json")).unwrap(), "2");
        let watch = OpenOptions::new().access_mode(1).share_mode(7).custom_flags(FILE_FLAG_BACKUP_SEMANTICS | 0x4000_0000).open(&path).unwrap();
        // The anchored operations keep working through the pin, next to those path-based ones.
        dir.open_log().unwrap(); dir.publish_pid("1 2\n").unwrap();
        assert_eq!(dir.read_pid().unwrap().as_deref(), Some("1 2\n"));
        assert!(dir.remove_pid_if(|record| record == "1 2\n").unwrap());
        // Nobody can rename or delete the pinned directory itself.
        let moved = PathBuf::from(format!("{}-moved", path.display()));
        assert!(fs::rename(&path, &moved).is_err());
        assert!(path.is_dir() && !moved.exists());
        let empty = scratch("pinned-empty"); let held = ready(&empty);
        assert!(fs::remove_dir(&empty).is_err());
        assert!(empty.is_dir());
        // Controls: it is the pin that refuses, not the watch or the content.
        drop(held); fs::remove_dir(&empty).unwrap();
        drop(dir); fs::rename(&path, &moved).unwrap();
        drop(watch);
    }
    #[test]
    fn an_adopted_directory_is_released_for_ordinary_work_inside_it() {
        let path = scratch("adopted-pin"); fs::create_dir_all(&path).unwrap();
        let dir = apply_adoption(prepare_adoption(&path).unwrap().explicitly_approve()).unwrap();
        fs::write(path.join("state.tmp"), "1").unwrap();
        fs::rename(path.join("state.tmp"), path.join("state.json")).unwrap();
        let watch = OpenOptions::new().access_mode(1).share_mode(7).custom_flags(FILE_FLAG_BACKUP_SEMANTICS | 0x4000_0000).open(&path).unwrap();
        dir.publish_pid("3 4\n").unwrap();
        let moved = PathBuf::from(format!("{}-moved", path.display()));
        assert!(fs::rename(&path, &moved).is_err(), "the adopted directory stays pinned");
        drop(watch); drop(dir);
        fs::rename(&path, &moved).unwrap();
    }
    #[test]
    fn plain_std_fs_objects_inside_a_ready_directory_are_private_by_inheritance() {
        let path = scratch("inherit"); let dir = ready(&path);
        fs::write(path.join("token"), "t").unwrap();
        fs::write(path.join("connectors.json"), "{}").unwrap();
        assert!(path_private(&path.join("token"), Kind::File, true));
        assert!(!path_private(&path.join("token"), Kind::File, false), "an inherited ACE counts only inside the pinned private directory");
        drop(dir);
        assert!(matches!(existing(&path).unwrap(), DirectoryState::Ready(_)));
        assert!(matches!(inspect(&path).unwrap(), DirectoryState::Ready(_)));
    }
    #[test]
    fn a_directory_that_is_not_exactly_owner_only_and_inheritable_needs_adoption() {
        let sid = user_sid().unwrap();
        for (label, sddl) in [
            ("extra ACE", format!("D:P(A;OICI;FA;;;{sid})(A;OICI;FR;;;BU)")),
            ("not inheritable", format!("D:P(A;;FA;;;{sid})")),
            ("object-only inheritance", format!("D:P(A;OI;FA;;;{sid})")),
        ] {
            let path = scratch("rejected"); drop(ready(&path));
            set_dacl(&path, &sddl);
            let before = state(&path);
            assert!(matches!(existing(&path).unwrap_or_else(|error| panic!("{label}: {error}")), DirectoryState::Pending(_)), "{label}");
            assert_eq!(state(&path), before, "{label}: inspection changes nothing");
        }
    }
    #[test]
    fn a_sensitive_file_with_extra_access_keeps_the_directory_pending() {
        let path = scratch("extra-file"); drop(ready(&path));
        fs::write(path.join("token"), "t").unwrap();
        set_dacl(&path.join("token"), &format!("D:P(A;;FA;;;{})(A;;FR;;;BU)", user_sid().unwrap()));
        assert!(matches!(existing(&path).unwrap(), DirectoryState::Pending(_)));
        assert_eq!(fs::read_to_string(path.join("token")).unwrap(), "t");
    }
    #[test]
    fn only_an_owner_only_single_ace_that_is_protected_or_inherited_is_private() {
        let sid = user_sid().unwrap();
        let check = |sddl: String, kind, inherited_ok| private_descriptor(sd_of(&sddl).0, &sid, kind, inherited_ok).unwrap();
        assert!(check(format!("O:{sid}D:P(A;OICI;FA;;;{sid})"), Kind::Directory, false));
        assert!(check(format!("O:{sid}D:P(A;;FA;;;{sid})"), Kind::File, false));
        assert!(check(format!("O:{sid}D:AI(A;ID;FA;;;{sid})"), Kind::File, true), "inherited inside the pinned directory");
        assert!(!check(format!("O:{sid}D:AI(A;ID;FA;;;{sid})"), Kind::File, false), "inherited elsewhere");
        for (label, kind, sddl) in [
            ("extra ACE", Kind::File, format!("O:{sid}D:P(A;;FA;;;{sid})(A;;FR;;;BU)")),
            ("another trustee", Kind::File, format!("O:{sid}D:P(A;;FA;;;SY)")),
            ("less than full access", Kind::File, format!("O:{sid}D:P(A;;FR;;;{sid})")),
            ("a deny ACE", Kind::File, format!("O:{sid}D:P(D;;FA;;;{sid})")),
            ("another owner", Kind::File, format!("O:SYD:P(A;;FA;;;{sid})")),
            ("no DACL", Kind::File, format!("O:{sid}")),
            ("a NULL DACL", Kind::File, format!("O:{sid}D:NO_ACCESS_CONTROL")),
            ("an empty DACL", Kind::File, format!("O:{sid}D:P")),
            ("an unprotected explicit ACE", Kind::File, format!("O:{sid}D:(A;;FA;;;{sid})")),
            ("a directory that does not inherit", Kind::Directory, format!("O:{sid}D:P(A;;FA;;;{sid})")),
            ("a file ACE that inherits", Kind::File, format!("O:{sid}D:P(A;OICI;FA;;;{sid})")),
            ("an inherit-only ACE", Kind::Directory, format!("O:{sid}D:P(A;OICIIO;FA;;;{sid})")),
            ("an inherited ACE under a protected DACL", Kind::File, format!("O:{sid}D:P(A;ID;FA;;;{sid})")),
        ] {
            assert!(!check(sddl, kind, true), "{label}");
        }
    }
    #[test]
    fn fresh_directory_log_and_pid_are_private_before_use() {
        let path = scratch("fresh"); let dir = ready(&path);
        let log = dir.open_log().unwrap(); drop(log);
        dir.publish_pid("123 456\n").unwrap(); drop(dir);
        assert_private(&path);
        assert_private(&path.join("daemon.log"));
        assert_private(&path.join("daemon.pid"));
    }
    #[test]
    fn pid_publication_replaces_privately_and_sharing_refusal_preserves_state() {
        let path = scratch("publish"); let dir = ready(&path);
        dir.publish_pid("123 456\n").unwrap();
        assert_eq!(dir.read_pid().unwrap().as_deref(), Some("123 456\n"));
        dir.publish_pid("789 012\n").unwrap();
        assert_eq!(dir.read_pid().unwrap().as_deref(), Some("789 012\n"));
        let before_directory = security(dir.directory.as_raw_handle()).unwrap();
        let held = native_open(dir.directory.as_raw_handle(), "daemon.pid", READ_CONTROL | SYNCHRONIZE | ATTRIBUTES | 1, 1, false, false, ptr::null_mut()).unwrap();
        let before_file = security(held.as_raw_handle()).unwrap();
        let before_identity = identity(&information(held.as_raw_handle(), false).unwrap());
        let error = dir.publish_pid("999 999\n").unwrap_err();
        assert_eq!(error.to_string(), "anchored filesystem open refused (NTSTATUS 0xc0000043)");
        assert_eq!(dir.read_pid().unwrap().as_deref(), Some("789 012\n"));
        assert_eq!(security(dir.directory.as_raw_handle()).unwrap(), before_directory);
        assert_eq!(security(held.as_raw_handle()).unwrap(), before_file);
        assert_eq!(identity(&information(held.as_raw_handle(), false).unwrap()), before_identity);
        drop(held); drop(dir);
        assert_private(&path); assert_private(&path.join("daemon.pid"));
        assert_eq!(fs::read_to_string(path.join("daemon.pid")).unwrap(), "789 012\n");
        let mut names: Vec<_> = fs::read_dir(&path).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        names.sort();
        // Both successful rename and failure cleanup must consume only their owned temporary.
        assert_eq!(names, vec![std::ffi::OsString::from("daemon.pid")]);
    }
    #[test]
    fn old_default_requires_consent_and_rejection_changes_nothing() {
        let path = scratch("legacy"); fs::create_dir_all(&path).unwrap();
        fs::write(path.join("daemon.log"), "keep\n").unwrap();
        let before = state(&path); let log_before = state(&path.join("daemon.log"));
        assert!(matches!(inspect(&path).unwrap(), DirectoryState::Pending(_)));
        assert_eq!(state(&path), before); assert_eq!(state(&path.join("daemon.log")), log_before);
        assert_eq!(fs::read_to_string(path.join("daemon.log")).unwrap(), "keep\n");
    }
    #[test]
    fn explicit_adoption_is_nonpropagating_and_preserves_contents() {
        let path = scratch("adopt"); fs::create_dir_all(path.join("unapproved/subdir")).unwrap();
        fs::write(path.join("unapproved/subdir/data"), "unrelated").unwrap();
        fs::write(path.join("daemon.log"), "old\n").unwrap();
        let descendants = [path.join("unapproved"), path.join("unapproved/subdir"), path.join("unapproved/subdir/data")];
        let before: Vec<_> = descendants.iter().map(|p| state(p)).collect();
        let preview = prepare_adoption(&path).unwrap();
        let dir = apply_adoption(preview.explicitly_approve()).unwrap(); drop(dir);
        assert_private(&path);
        assert_private(&path.join("daemon.log"));
        assert_eq!(descendants.iter().map(|p| state(p)).collect::<Vec<_>>(), before);
        assert_eq!(fs::read_to_string(path.join("daemon.log")).unwrap(), "old\n");
        assert_eq!(fs::read_to_string(path.join("unapproved/subdir/data")).unwrap(), "unrelated");
    }
    #[test]
    fn hardlinked_sensitive_leaves_are_refused_without_mutation() {
        let path = scratch("hardlink"); fs::create_dir_all(&path).unwrap();
        fs::write(path.join("unrelated"), "keep").unwrap();
        fs::hard_link(path.join("unrelated"), path.join("daemon.log")).unwrap();
        let before = state(&path.join("unrelated"));
        assert!(prepare_adoption(&path).is_err());
        assert_eq!(state(&path.join("unrelated")), before);
        assert_eq!(fs::read_to_string(path.join("unrelated")).unwrap(), "keep");
    }
    #[test]
    fn adoption_requires_exclusive_directory_access() {
        let path = scratch("sharing"); fs::create_dir_all(&path).unwrap();
        let before = state(&path);
        let held = OpenOptions::new().access_mode(0x20001).share_mode(7).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(&path).unwrap();
        assert!(prepare_adoption(&path).is_err()); drop(held);
        assert_eq!(state(&path), before);
    }
    #[test]
    fn stale_security_preview_is_refused_without_repair() {
        let path = scratch("stale"); fs::create_dir_all(&path).unwrap();
        let preview = prepare_adoption(&path).unwrap();
        // A same-user security change through the OS, not replacement of the pinned pathname.
        let handle = OpenOptions::new().access_mode(0x60000).share_mode(7).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(&path).unwrap();
        let sd = descriptor(&user_sid().unwrap(), Kind::Directory).unwrap(); let mut acl = ptr::null_mut(); let mut present = 0; let mut defaulted = 0;
        assert_ne!(unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut acl, &mut defaulted) }, 0);
        assert_eq!(unsafe { SetSecurityInfo(handle.as_raw_handle(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, ptr::null_mut(), ptr::null_mut(), acl, ptr::null_mut()) }, 0);
        drop(handle);
        assert!(apply_adoption(preview.explicitly_approve()).is_err());
        assert_private(&path);
    }
    #[test]
    fn oversized_pid_is_not_read() {
        let path = scratch("large"); let dir = ready(&path);
        fs::write(path.join("daemon.pid"), "x".repeat(65)).unwrap();
        assert!(dir.read_pid().is_err()); drop(dir);
        assert_eq!(fs::read_to_string(path.join("daemon.pid")).unwrap(), "x".repeat(65));
    }

    // Pins of existing behavior found by the independent T6 verification (windows-support.md L63).
    /// Scratch the pins below own: one root under the crate target directory, removed on drop even when an
    /// assertion fails. Links are unlinked first, so removal can never follow a junction or symlink into the
    /// folder it points at (one pin links to the home folder and to the drive root).
    struct Owned { root: PathBuf, links: std::cell::RefCell<Vec<PathBuf>> }
    impl Owned {
        fn new(label: &str) -> Self {
            let mut random = [0; 8]; getrandom::fill(&mut random).unwrap();
            let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
            Owned { root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/privacy-probes").join(format!("{label}-{suffix}")), links: Default::default() }
        }
        fn path(&self, name: &str) -> PathBuf { self.root.join(name) }
        /// `mklink /J` needs no administrator rights, so a failure here is an environment problem, not a skip.
        fn junction(&self, link: &Path, target: &Path) {
            self.links.borrow_mut().push(link.to_path_buf());
            let windows = |path: &Path| path.to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR);
            let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(windows(link)).arg(windows(target)).output()
                .unwrap_or_else(|error| panic!("cannot run `cmd /c mklink /J` to make the junction {} -> {}: {error}", link.display(), target.display()));
            assert!(made.status.success(), "`mklink /J {} {}` failed ({}); a junction needs no administrator rights: {}{}",
                link.display(), target.display(), made.status, String::from_utf8_lossy(&made.stdout), String::from_utf8_lossy(&made.stderr));
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            let mut stuck = Vec::new();
            for link in self.links.borrow().iter().rev() {
                if fs::symlink_metadata(link).is_ok() && fs::remove_dir(link).or_else(|_| fs::remove_file(link)).is_err() { stuck.push(link.clone()); }
            }
            // With a link left in place, removing the root could reach what it points at: leave it and say so.
            if !stuck.is_empty() { eprintln!("scratch {} kept: could not unlink {stuck:?}", self.root.display()); return; }
            if let Err(error) = fs::remove_dir_all(&self.root) { eprintln!("scratch {} not removed: {error}", self.root.display()); }
        }
    }
    #[test]
    fn private_predicate_rejects_inherited_foreign_owner_deny_generic_and_scoped_aces() {
        let sid = user_sid().unwrap();
        let check = |sddl: String, kind, ok| private_descriptor(sd_of(&sddl).0, &sid, kind, ok).unwrap();
        for (label, kind, ok, sddl) in [
            ("dir inherited ACE even with inherited_ok=false", Kind::Directory, false, format!("O:{sid}D:AI(A;OICIID;FA;;;{sid})")),
            ("Administrators owner", Kind::Directory, false, format!("O:BAD:P(A;OICI;FA;;;{sid})")),
            ("Administrators owner file", Kind::File, true, format!("O:BAD:P(A;;FA;;;{sid})")),
            ("deny first + allow", Kind::File, true, format!("O:{sid}D:P(D;;FR;;;WD)(A;;FA;;;{sid})")),
            ("Everyone full", Kind::File, true, format!("O:{sid}D:P(A;;FA;;;WD)")),
            ("generic all only (not mapped)", Kind::File, true, format!("O:{sid}D:P(A;;GA;;;{sid})")),
            ("audit-only/empty protected dir", Kind::Directory, true, format!("O:{sid}D:PAI")),
            ("CI only dir", Kind::Directory, false, format!("O:{sid}D:P(A;CI;FA;;;{sid})")),
            ("NP dir", Kind::Directory, false, format!("O:{sid}D:P(A;OICINP;FA;;;{sid})")),
            ("file ID under protected+inherited", Kind::File, true, format!("O:{sid}D:PAI(A;ID;FA;;;{sid})")),
        ] { assert!(!check(sddl, kind, ok), "wrongly accepted: {label}"); }
        assert!(check(format!("O:{sid}D:P(A;;0x1f01ff;;;{sid})"), Kind::File, false));
        assert!(check(format!("O:{sid}D:PAI(A;OICI;FA;;;{sid})"), Kind::Directory, false), "protected + auto-inherited bookkeeping is accepted");
    }
    #[test]
    fn a_pinned_directory_allows_node_style_work_and_blocks_renaming_it() {
        let owned = Owned::new("pin"); let path = owned.path("data"); let dir = ready(&path);
        fs::write(path.join("token"), "a").unwrap();
        fs::write(path.join("token.tmp"), "b").unwrap();
        fs::rename(path.join("token.tmp"), path.join("token")).unwrap();
        assert_eq!(fs::read_to_string(path.join("token")).unwrap(), "b");
        fs::create_dir(path.join("sessions")).unwrap();
        fs::write(path.join("sessions/x.json"), "{}").unwrap();
        fs::rename(path.join("sessions/x.json"), path.join("sessions/y.json")).unwrap();
        fs::remove_file(path.join("sessions/y.json")).unwrap();
        // ReadDirectoryChangesW-style directory handle as libuv opens it (LIST, share RWD).
        let watch = OpenOptions::new().access_mode(1).share_mode(7).custom_flags(FILE_FLAG_BACKUP_SEMANTICS | 0x4000_0000).open(&path).unwrap();
        // The pin is held during every anchored op; the inherited copy is private.
        assert!(matches!(existing(&path).unwrap(), DirectoryState::Ready(_)));
        dir.publish_pid("5 6\n").unwrap();
        assert!(fs::rename(&path, path.with_extension("moved")).is_err());
        drop(watch); drop(dir);
    }
    #[test]
    fn a_hardlinked_or_oversized_pid_in_a_ready_directory_is_refused_and_kept() {
        let owned = Owned::new("pidlink"); let path = owned.path("data"); let dir = ready(&path);
        fs::write(path.join("other"), "1 2\n").unwrap();
        fs::hard_link(path.join("other"), path.join("daemon.pid")).unwrap();
        assert!(dir.read_pid().is_err());
        assert!(dir.remove_pid_if(|_| true).is_err());
        assert!(dir.publish_pid("7 8\n").is_err());
        assert_eq!(fs::read_to_string(path.join("daemon.pid")).unwrap(), "1 2\n");
        let names: Vec<_> = fs::read_dir(&path).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).filter(|n| n.starts_with(".daemon.pid.")).collect();
        assert!(names.is_empty(), "temporary left: {names:?}");
        fs::remove_file(path.join("daemon.pid")).unwrap();
        fs::write(path.join("daemon.pid"), "x".repeat(65)).unwrap();
        assert!(dir.remove_pid_if(|_| true).is_err());
        assert!(path.join("daemon.pid").exists());
        fs::write(path.join("daemon.pid"), format!("{}\n", "1".repeat(63))).unwrap();
        assert_eq!(dir.read_pid().unwrap().map(|r| r.len()), Some(64));
        assert!(!dir.remove_pid_if(|_| false).unwrap());
        assert!(path.join("daemon.pid").exists());
        assert!(dir.publish_pid(&"9".repeat(65)).is_err());
    }
    #[test]
    fn a_pid_destination_that_is_a_directory_is_refused_without_a_temporary() {
        let owned = Owned::new("piddir"); let path = owned.path("data"); let dir = ready(&path);
        fs::create_dir(path.join("daemon.pid")).unwrap();
        assert!(dir.publish_pid("1 2\n").is_err());
        assert!(path.join("daemon.pid").is_dir());
        assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
    }
    /// Needs the symlink privilege (administrator or Developer Mode). Without it the test returns early and
    /// prints `SKIPPED` (visible with `--nocapture`): the symlink case was NOT exercised, whatever the result says.
    #[test]
    fn a_leaf_symlink_named_token_is_never_adopted_when_symlinks_can_be_created() {
        let owned = Owned::new("symlink"); let path = owned.path("data"); drop(ready(&path));
        let target = owned.path("symlink-target"); fs::create_dir_all(&target).unwrap(); fs::write(target.join("t"), "s").unwrap();
        if std::os::windows::fs::symlink_file(target.join("t"), path.join("token")).is_err() {
            eprintln!("SKIPPED (not exercised): no symlink privilege, the leaf symlink case was not tested");
            return;
        }
        owned.links.borrow_mut().push(path.join("token"));
        assert!(owned.links.borrow().contains(&path.join("token")), "the created symlink must be explicitly unlinked before root cleanup");
        let before = state(&target.join("t"));
        assert!(existing(&path).is_err() || matches!(existing(&path), Ok(DirectoryState::Pending(_))));
        assert!(crate::daemon::adopt_data_dir(&path, &[], &|_, _| true).is_err(), "a leaf link is never adopted");
        assert_eq!(state(&target.join("t")), before, "link target untouched");
    }
    #[test]
    fn a_junction_to_a_private_folder_is_usable_and_one_to_home_or_a_volume_root_is_refused_unasked() {
        let owned = Owned::new("junction");
        let real = owned.path("real"); drop(ready(&real));
        let parent = owned.path("links"); fs::create_dir_all(&parent).unwrap();
        let link = parent.join("data"); owned.junction(&link, &real);
        assert!(matches!(existing(&link).unwrap(), DirectoryState::Ready(_)), "S7: redirected private folder is usable");
        let home = owned.path("home"); fs::create_dir_all(&home).unwrap(); fs::write(home.join("token"), "t").unwrap();
        let before = state(&home);
        let to_home = parent.join("tohome"); owned.junction(&to_home, &home);
        let never = |_: &str, _: &str| -> bool { panic!("asked for a refused folder") };
        let error = crate::daemon::adopt_data_dir(&to_home, std::slice::from_ref(&home), &never).unwrap_err();
        assert!(error.contains("home folder"), "{error}");
        assert_eq!(state(&home), before);
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let to_root = parent.join("toroot"); owned.junction(&to_root, Path::new(&format!("{drive}{}", std::path::MAIN_SEPARATOR)));
        let error = crate::daemon::adopt_data_dir(&to_root, &[], &never).unwrap_err();
        eprintln!("junction-to-root refusal: {error}");
    }
    #[test]
    fn declined_adoption_changes_nothing_including_unlisted_files() {
        let owned = Owned::new("decline"); let path = owned.path("data"); fs::create_dir_all(path.join("sessions")).unwrap();
        fs::write(path.join("token"), "t").unwrap(); fs::write(path.join("secrets.enc.json"), "s").unwrap();
        let names = ["", "token", "secrets.enc.json", "sessions"];
        let before: Vec<_> = names.iter().map(|n| state(&path.join(n))).collect();
        let asked = std::cell::Cell::new(false);
        assert!(crate::daemon::adopt_data_dir(&path, &[], &|_, msg| { asked.set(true); assert!(msg.contains("token")); false }).is_err());
        assert!(asked.get());
        assert_eq!(names.iter().map(|n| state(&path.join(n))).collect::<Vec<_>>(), before);
        assert!(crate::daemon::adopt_data_dir(&path, &[], &|_, _| true).is_ok());
        let after: Vec<_> = names.iter().map(|n| state(&path.join(n))).collect();
        assert_ne!(after[0], before[0]); assert_ne!(after[1], before[1]);
        assert_eq!(after[2], before[2], "unlisted file unchanged"); assert_eq!(after[3], before[3], "subfolder unchanged");
        assert!(matches!(existing(&path).unwrap(), DirectoryState::Ready(_)));
    }
}
