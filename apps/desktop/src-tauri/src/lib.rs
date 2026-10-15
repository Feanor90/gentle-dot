pub mod alert;
pub mod app_channel;
#[cfg(windows)]
pub mod autostart_windows;
pub mod approvals;
pub mod computer;
pub mod config;
pub mod daemon;
#[cfg(target_os = "macos")]
pub mod disclaimed;
#[cfg(windows)]
pub mod engram_bootstrap;
pub mod geometry;
pub mod health;
pub mod platform;
pub mod position;
pub mod secure_store;
mod shell;
pub mod shortcut;
pub mod status;
pub mod voice;
#[cfg(windows)]
pub mod win_file;
#[cfg(windows)]
pub mod win_pipe;
#[cfg(windows)]
pub mod win_spawn;

pub use shell::run;
