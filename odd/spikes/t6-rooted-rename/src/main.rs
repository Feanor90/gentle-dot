#[cfg(not(all(windows, target_pointer_width = "64")))]
compile_error!("This diagnostic requires Windows x64.");

#[allow(dead_code)]
mod backend {
    include!(concat!(env!("OUT_DIR"), "/backend_diagnostic.rs"));
}

fn main() {
    if let Err(error) = backend::run_diagnostic() {
        eprintln!("diagnostic_failed: {error}");
        std::process::exit(1);
    }
}
