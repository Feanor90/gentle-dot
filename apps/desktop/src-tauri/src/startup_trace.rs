//! Allowlisted startup diagnostics to shell stderr; no application data or error text.
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Step {
    StartupBegin,
    StartupSucceeded,
    StartupFailed,
    ReadyEmitBegin,
    ReadyEmitSucceeded,
    ReadyEmitFailed,
    ConnectionWaitBegin,
    ConnectionWaitSucceeded,
    ConnectionWaitFailed,
    TokenReadBegin,
    TokenReadSucceeded,
    TokenReadFailed,
}

#[derive(serde::Serialize)]
struct Record {
    request: u64,
    step: Step,
    surface: &'static str,
    time_ms: u128,
}

pub(crate) struct Trace(u64);

impl Trace {
    pub(crate) fn begin(step: Step) -> Self {
        let trace = Self(NEXT_REQUEST.fetch_add(1, Ordering::Relaxed));
        trace.record(step);
        trace
    }

    pub(crate) fn record(&self, step: Step) {
        let time_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        // A closed or unavailable diagnostic stream must not interrupt startup.
        let _ = writeln!(std::io::stderr().lock(), "{}", line(self.0, step, time_ms));
    }

    pub(crate) fn outcome<T, E>(&self, result: &Result<T, E>, succeeded: Step, failed: Step) {
        self.record(if result.is_ok() { succeeded } else { failed });
    }
}

fn line(request: u64, step: Step, time_ms: u128) -> String {
    let record = Record {
        request,
        step,
        surface: "shell",
        time_ms,
    };
    format!(
        "[startup-trace] {}",
        serde_json::to_string(&record).expect("static trace metadata")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_has_only_safe_fields_and_fixed_outcome_stages() {
        let stages = [
            (Step::StartupBegin, "startup-begin"),
            (Step::StartupSucceeded, "startup-succeeded"),
            (Step::StartupFailed, "startup-failed"),
            (Step::ReadyEmitBegin, "ready-emit-begin"),
            (Step::ReadyEmitSucceeded, "ready-emit-succeeded"),
            (Step::ReadyEmitFailed, "ready-emit-failed"),
            (Step::ConnectionWaitBegin, "connection-wait-begin"),
            (Step::ConnectionWaitSucceeded, "connection-wait-succeeded"),
            (Step::ConnectionWaitFailed, "connection-wait-failed"),
            (Step::TokenReadBegin, "token-read-begin"),
            (Step::TokenReadSucceeded, "token-read-succeeded"),
            (Step::TokenReadFailed, "token-read-failed"),
        ];
        for (step, label) in stages {
            let output = line(7, step, 123);
            let record: serde_json::Value =
                serde_json::from_str(output.strip_prefix("[startup-trace] ").unwrap()).unwrap();
            assert_eq!(
                record,
                serde_json::json!({
                    "request": 7, "step": label, "surface": "shell", "time_ms": 123
                })
            );
        }
    }
}
