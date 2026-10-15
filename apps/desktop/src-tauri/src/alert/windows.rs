//! Windows approvals use an explicit safe default, which the dialog plugin cannot configure.
use super::{Choice, ALLOW_RESPONSE, REFUSE_RESPONSE};
use std::{mem, ptr};
use windows_sys::Win32::UI::Controls::{
    TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TASKDIALOG_BUTTON,
    TDF_ALLOW_DIALOG_CANCELLATION, TDF_SIZE_TO_CONTENT, TD_WARNING_ICON,
};

fn config(title: &[u16], message: &[u16], buttons: &[TASKDIALOG_BUTTON; 2]) -> TASKDIALOGCONFIG {
    TASKDIALOGCONFIG {
        cbSize: mem::size_of::<TASKDIALOGCONFIG>() as u32,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT,
        pszWindowTitle: title.as_ptr(),
        pszContent: message.as_ptr(),
        Anonymous1: TASKDIALOGCONFIG_0 { pszMainIcon: TD_WARNING_ICON },
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        // Enter must refuse unless the user explicitly changes the selection.
        nDefaultButton: REFUSE_RESPONSE as i32,
        ..unsafe { mem::zeroed() }
    }
}

pub fn ask(title: &str, message: &str, choice: Choice) -> bool {
    if choice.allow == choice.refuse {
        return false;
    }
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let (title, message, allow, refuse) = (wide(title), wide(message), wide(choice.allow), wide(choice.refuse));
    let buttons = [
        TASKDIALOG_BUTTON { nButtonID: ALLOW_RESPONSE as i32, pszButtonText: allow.as_ptr() },
        TASKDIALOG_BUTTON { nButtonID: REFUSE_RESPONSE as i32, pszButtonText: refuse.as_ptr() },
    ];
    let config = config(&title, &message, &buttons);
    let mut response = 0;
    // SAFETY: every pointer in config refers to NUL-terminated text or the two-button array
    // above, all alive until this synchronous call returns. Optional outputs are unused.
    let status = unsafe { TaskDialogIndirect(&config, &mut response, ptr::null_mut(), ptr::null_mut()) };
    allows(choice, status, response)
}

fn allows(choice: Choice, status: i32, response: i32) -> bool {
    status == 0 && choice.allows_response(Some(response as isize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enter_defaults_to_refusal_and_escape_and_close_remain_enabled() {
        let text = [0u16];
        let buttons = [
            TASKDIALOG_BUTTON { nButtonID: ALLOW_RESPONSE as i32, pszButtonText: text.as_ptr() },
            TASKDIALOG_BUTTON { nButtonID: REFUSE_RESPONSE as i32, pszButtonText: text.as_ptr() },
        ];
        let config = config(&text, &text, &buttons);
        // TASKDIALOGCONFIG is packed: copy fields before assertions take references.
        let default = config.nDefaultButton;
        let flags = config.dwFlags;
        assert_eq!(default, REFUSE_RESPONSE as i32);
        assert_ne!(flags & TDF_ALLOW_DIALOG_CANCELLATION, 0);
    }

    #[test]
    fn explicit_allow_still_works_but_cancel_unknown_and_failure_refuse() {
        let choice = Choice { allow: "Limit access", refuse: "Cancel" };
        assert!(allows(choice, 0, ALLOW_RESPONSE as i32));
        for response in [REFUSE_RESPONSE as i32, 2, 0, -1, 1, 1002] {
            assert!(!allows(choice, 0, response), "{response}");
        }
        for status in [-1, i32::MIN, 1] {
            assert!(!allows(choice, status, ALLOW_RESPONSE as i32));
        }
        assert!(!allows(Choice { allow: "OK", refuse: "OK" }, 0, ALLOW_RESPONSE as i32));
    }
}
