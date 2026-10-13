// Diagnostic extension compiled beside the current backend helpers, never into the app.
// NtSetInformationFile is now declared by that backend; avoid a second declaration.
// Historical run job-33 used backend hash 541c052552fc7361bf61910eb44833bfbc250132:
// rooted=STATUS_SHARING_VIOLATION, NULL root=success (windows-support.md L45).
// This harness recompiles CURRENT source; it is not a frozen historical candidate.
// Reproduce (only with explicit isolated-execution authorization): cargo run --offline
// --manifest-path odd/spikes/t6-rooted-rename/Cargo.toml --target x86_64-pc-windows-msvc
// --target-dir odd/spikes/t6-rooted-rename/target/build
// Native same-parent semantics: https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information
// Fixtures are random dedicated target/fixtures children; retained, not globally cleaned.

pub fn run_diagnostic() -> io::Result<()> {
    use std::io::{Seek, SeekFrom};
    const NATIVE_FILE_RENAME_INFORMATION: u32 = 10;
    const RECORD: &str = "123 456\n";
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|e| io::Error::other(e.to_string()))?;
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/fixtures").join(suffix);
    let sid = user_sid()?;
    let sd = descriptor(&sid)?;
    let expected_security = descriptor_text(sd.0)?;
    let name: Vec<u16> = "daemon.pid".encode_utf16().collect();
    let offset = mem::offset_of!(FILE_RENAME_INFO, FileName);
    let length = offset + name.len() * 2;
    println!("layout root_offset={} name_offset={} payload_bytes={length} native_class={NATIVE_FILE_RENAME_INFORMATION}", mem::offset_of!(FILE_RENAME_INFO, RootDirectory), offset);
    for (label, rooted) in [("native_rooted", true), ("native_null_root", false)] {
        let path = base.join(label);
        // Unique, never previously existing fixtures. Same exclusive access and ACL as production.
        let directory = open_directory(&path, true)?;
        let parent_info = information(directory.as_raw_handle(), true)?;
        if !private_matches(&security(directory.as_raw_handle())?.1, &expected_security) {
            return Err(denied("diagnostic directory is not private"));
        }
        let resolved_parent = final_path(directory.as_raw_handle())?;
        let source = native_open(directory.as_raw_handle(), "before.pid", FILE_ACCESS | DELETE | 3, 0, true, false, sd.0)?;
        let mut file = File::from(source);
        let source_identity = identity(&information(file.as_raw_handle(), false)?);
        if !private_matches(&security(file.as_raw_handle())?.1, &expected_security) {
            return Err(denied("diagnostic source is not private"));
        }
        file.write_all(RECORD.as_bytes())?;
        file.sync_all()?;
        let mut buffer = vec![0usize; length.div_ceil(mem::size_of::<usize>())];
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        unsafe {
            (*info).Anonymous.ReplaceIfExists = true;
            (*info).RootDirectory = if rooted { directory.as_raw_handle() } else { ptr::null_mut() };
            (*info).FileNameLength = (name.len() * 2) as u32;
            ptr::copy_nonoverlapping(name.as_ptr(), ptr::addr_of_mut!((*info).FileName).cast(), name.len());
        }
        // Sentinel distinguishes an untouched output buffer from an actual returned zero status.
        let mut ios = IoStatus { status_or_pointer: usize::MAX, information: usize::MAX };
        let status = unsafe { NtSetInformationFile(file.as_raw_handle(), &mut ios, info.cast(), length as u32, NATIVE_FILE_RENAME_INFORMATION) };
        println!("{label} ntstatus=0x{:08x} io_status=0x{:016x} io_information=0x{:016x}", status as u32, ios.status_or_pointer, ios.information);
        let succeeded = status >= 0;
        if identity(&information(file.as_raw_handle(), false)?) != source_identity ||
            identity(&information(directory.as_raw_handle(), true)?) != identity(&parent_info) {
            return Err(denied("diagnostic object identity changed"));
        }
        let resolved_file = final_path(file.as_raw_handle())?;
        let expected_name = if succeeded { "daemon.pid" } else { "before.pid" };
        if resolved_file.parent() != Some(resolved_parent.as_path()) || resolved_file.file_name() != Some(std::ffi::OsStr::new(expected_name)) {
            return Err(denied("diagnostic file escaped its pinned parent or has unexpected name"));
        }
        file.seek(SeekFrom::Start(0))?;
        let mut content = String::new();
        file.read_to_string(&mut content)?;
        if content != RECORD || !private_matches(&security(file.as_raw_handle())?.1, &expected_security) {
            return Err(denied("diagnostic content or ACL changed"));
        }
        drop(file);
        let present = native_open(directory.as_raw_handle(), expected_name, READ_CONTROL | SYNCHRONIZE | ATTRIBUTES | 1, 7, false, false, ptr::null_mut())?;
        if identity(&information(present.as_raw_handle(), false)?) != source_identity {
            return Err(denied("diagnostic published identity differs"));
        }
        let absent_name = if succeeded { "before.pid" } else { "daemon.pid" };
        match native_open(directory.as_raw_handle(), absent_name, READ_CONTROL | SYNCHRONIZE | ATTRIBUTES | 1, 7, false, false, ptr::null_mut()) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            _ => return Err(denied("diagnostic unexpected source/destination entry")),
        }
        println!("{label} renamed={succeeded} identity=unchanged content=unchanged acl=private parent=pinned opposite_entry=absent fixture={}", path.display());
        // Retain only these new harmless fixtures as evidence; do not delete pre-existing data.
    }
    println!("diagnostic_complete: observations only; no production fix or cross-platform claim");
    Ok(())
}
