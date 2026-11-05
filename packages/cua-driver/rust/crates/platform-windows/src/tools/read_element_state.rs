use async_trait::async_trait;
use cua_driver_core::{
    element_token::{resolve_element_args, ResolvedElement},
    protocol::ToolResult,
    tool::{Tool, ToolDef},
    tool_args::ArgsExt,
};
use serde_json::{json, Value};
use windows::core::Interface;
use windows::Win32::{
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    },
    UI::Accessibility::*,
};

pub struct ReadElementStateTool;

#[async_trait]
impl Tool for ReadElementStateTool {
    fn def(&self) -> &ToolDef {
        static DEF: std::sync::OnceLock<ToolDef> = std::sync::OnceLock::new();
        DEF.get_or_init(|| ToolDef {
            name: "read_element_state".into(),
            description: "Internal live state read of the exact retained element.".into(),
            input_schema: json!({"type":"object"}),
            read_only: true,
            destructive: false,
            idempotent: true,
            open_world: false,
        })
    }

    async fn invoke(&self, args: Value) -> ToolResult {
        if let Some(result) =
            crate::uia_worker::forward_required("read_element_state", args.clone()).await
        {
            return result;
        }
        let pid = match args.require_u32("pid") {
            Ok(value) => value,
            Err(error) => return error,
        };
        let hwnd = match args.require_u64("window_id") {
            Ok(value) => value,
            Err(error) => return error,
        };
        let resolved = match resolve_element_args(
            pid as i32,
            None,
            args.get("element_token").and_then(Value::as_str),
            None,
            Some(hwnd as u32),
            "read_element_state",
        ) {
            Ok(value) => value,
            Err(error) => return error,
        };
        let cache = crate::uia::cache::BoundElementCache::from_resolved(&resolved);
        let index = match resolved {
            ResolvedElement::Element { element_index, .. } => Some(element_index),
            _ => None,
        };
        let focused = args.bool_or("focused", false);
        let fields = args.str_array("fields");
        let timeout =
            std::time::Duration::from_millis(args.u64_or("timeout_ms", 100).clamp(1, 400));
        let deadline = std::time::Instant::now() + timeout;
        let cancellation = CancelRead(std::sync::Arc::new(std::sync::Mutex::new((None, false))));
        let worker_cancellation = cancellation.0.clone();
        let lifetime = cua_driver_core::tool::retain_dispatch_lifetime();
        let worker = tokio::task::spawn_blocking(move || unsafe {
            let _lifetime = lifetime;
            {
                let mut control = worker_cancellation.lock().unwrap();
                if control.1 || std::time::Instant::now() >= deadline {
                    return json!({"readable":false,"readback_timed_out":true});
                }
                control.0 = Some(windows::Win32::System::Threading::GetCurrentThreadId());
            }
            let _ = windows::Win32::System::Com::CoEnableCallCancellation(None);
            let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let state = (|| {
                let automation: IUIAutomation =
                    CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).ok()?;
                let settings = automation.cast::<IUIAutomation2>().ok()?;
                // UIA rejects 25 ms; the outer deadline still cancels shorter reads.
                let transaction_ms = 50;
                settings.SetConnectionTimeout(transaction_ms).ok()?;
                settings.SetTransactionTimeout(transaction_ms).ok()?;
                if crate::win32::windows::find_window_by_pid_and_handle(pid, hwnd).is_none() {
                    return None;
                }
                let guard = index.and_then(|index| cache.get_element_retained(pid, hwnd, index));
                if let Some(guard) = guard {
                    if !guard.is_uia() {
                        return None;
                    }
                    let element = std::mem::ManuallyDrop::new(IUIAutomationElement::from_raw(
                        guard.as_ptr() as *mut _,
                    ));
                    Some(read_state(&element, &fields, deadline))
                } else if index.is_none() && focused {
                    let element = automation.GetFocusedElement().ok()?;
                    if !belongs_to_window(&automation, &element, pid, hwnd, deadline) {
                        return None;
                    }
                    let result = read_state(&element, &fields, deadline);
                    (result["editable"] == true).then_some(result)
                } else {
                    None
                }
            })()
            .unwrap_or_else(|| json!({"readable":false}));
            worker_cancellation.lock().unwrap().0 = None;
            let _ = windows::Win32::System::Com::CoDisableCallCancellation(None);
            if initialized {
                CoUninitialize();
            }
            state
        });
        let result = match tokio::time::timeout(timeout, worker).await {
            Ok(Ok(state)) => ToolResult::text("").with_structured(state),
            Ok(Err(error)) => ToolResult::error(format!("element read failed: {error}")),
            Err(_) => {
                let mut state = json!({"readable":false,"readback_timed_out":true});
                if crate::uia_worker::is_worker_process() {
                    state["_uia_worker_restart_required"] = json!(true);
                }
                ToolResult::text("").with_structured(state)
            }
        };
        drop(cancellation);
        result
    }
}

unsafe fn belongs_to_window(
    automation: &IUIAutomation,
    element: &IUIAutomationElement,
    pid: u32,
    hwnd: u64,
    deadline: std::time::Instant,
) -> bool {
    if element.CurrentProcessId().ok().map(|value| value as u32) != Some(pid) {
        return false;
    }
    let Ok(walker) = automation.RawViewWalker() else {
        return false;
    };
    let mut current = element.clone();
    for _ in 0..64 {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        if current
            .CurrentNativeWindowHandle()
            .ok()
            .map(|handle| handle.0 as usize as u64)
            == Some(hwnd)
        {
            return true;
        }
        let Ok(parent) = walker.GetParentElement(&current) else {
            return false;
        };
        current = parent;
    }
    false
}

unsafe fn read_state(
    element: &IUIAutomationElement,
    fields: &[String],
    deadline: std::time::Instant,
) -> Value {
    let role = element
        .CurrentControlType()
        .ok()
        .map(|value| crate::uia::control_type_name(value.0));
    let value_pattern = element
        .GetCurrentPattern(UIA_ValuePatternId)
        .ok()
        .and_then(|pattern| pattern.cast::<IUIAutomationValuePattern>().ok());
    let editable = value_pattern
        .as_ref()
        .and_then(|pattern| pattern.CurrentIsReadOnly().ok())
        .map(|readonly| !readonly.as_bool())
        .unwrap_or(role.as_deref() == Some("Edit"));
    let mut result = json!({"role":role,"editable":editable});
    for field in fields {
        if std::time::Instant::now() >= deadline {
            break;
        }
        let value = match field.as_str() {
            "value"
                if element
                    .CurrentIsPassword()
                    .ok()
                    .is_some_and(|password| !password.as_bool()) =>
            {
                value_pattern
                    .as_ref()
                    .and_then(|pattern| pattern.CurrentValue().ok())
                    .map(|value| json!(value.to_string()))
                    .or_else(|| {
                        element
                            .GetCurrentPattern(UIA_RangeValuePatternId)
                            .ok()
                            .and_then(|pattern| {
                                pattern.cast::<IUIAutomationRangeValuePattern>().ok()
                            })
                            .and_then(|pattern| pattern.CurrentValue().ok())
                            .map(|value| json!(value))
                    })
                    .or_else(|| {
                        element
                            .GetCurrentPattern(UIA_TextPatternId)
                            .ok()
                            .and_then(|pattern| pattern.cast::<IUIAutomationTextPattern>().ok())
                            .and_then(|pattern| pattern.DocumentRange().ok())
                            .and_then(|range| range.GetText(-1).ok())
                            .map(|value| json!(value.to_string()))
                    })
            }
            "checked" => element
                .GetCurrentPattern(UIA_TogglePatternId)
                .ok()
                .and_then(|pattern| pattern.cast::<IUIAutomationTogglePattern>().ok())
                .and_then(|pattern| pattern.CurrentToggleState().ok())
                .and_then(|state| {
                    if state == ToggleState_On {
                        Some(json!(true))
                    } else if state == ToggleState_Off {
                        Some(json!(false))
                    } else {
                        None
                    }
                })
                .or_else(|| {
                    if role.as_deref() == Some("RadioButton") {
                        selected(element)
                    } else {
                        None
                    }
                }),
            "selected" => selected(element),
            "expanded" => element
                .GetCurrentPattern(UIA_ExpandCollapsePatternId)
                .ok()
                .and_then(|pattern| pattern.cast::<IUIAutomationExpandCollapsePattern>().ok())
                .and_then(|pattern| pattern.CurrentExpandCollapseState().ok())
                .and_then(|state| {
                    if state == ExpandCollapseState_Expanded {
                        Some(json!(true))
                    } else if state == ExpandCollapseState_Collapsed {
                        Some(json!(false))
                    } else {
                        None
                    }
                }),
            _ => None,
        };
        if let Some(value) = value {
            result[field] = value;
        }
    }
    result["readable"] = json!(fields.iter().any(|field| result.get(field).is_some()));
    result
}

unsafe fn selected(element: &IUIAutomationElement) -> Option<Value> {
    element
        .GetCurrentPattern(UIA_SelectionItemPatternId)
        .ok()
        .and_then(|pattern| pattern.cast::<IUIAutomationSelectionItemPattern>().ok())
        .and_then(|pattern| pattern.CurrentIsSelected().ok())
        .map(|value| json!(value.as_bool()))
}

struct CancelRead(std::sync::Arc<std::sync::Mutex<(Option<u32>, bool)>>);

impl Drop for CancelRead {
    fn drop(&mut self) {
        let mut control = self.0.lock().unwrap();
        control.1 = true;
        if let Some(thread) = control.0 {
            unsafe {
                let _ = windows::Win32::System::Com::CoCancelCall(thread, 0);
            }
        }
    }
}
