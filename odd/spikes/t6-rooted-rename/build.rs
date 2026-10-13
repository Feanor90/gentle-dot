use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let backend = manifest.join("../../../apps/desktop/src-tauri/src/win_file.rs");
    println!("cargo:rerun-if-changed={}", backend.display());
    println!("cargo:rerun-if-changed=src/diagnostic.rs");
    // Compile the exact current helpers inside this standalone harness, without editing them.
    // Remove only the inner module documentation line so include! is syntactically valid.
    let source = fs::read_to_string(backend).unwrap();
    assert!(source.starts_with("//! Windows filesystem privacy."));
    let (_, body) = source.split_once('\n').unwrap();
    let diagnostic = fs::read_to_string(manifest.join("src/diagnostic.rs")).unwrap();
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("backend_diagnostic.rs");
    fs::write(output, format!("{body}\n{diagnostic}")).unwrap();
}
