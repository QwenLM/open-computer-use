use crate::ax::{bindings::*, cache::BoundElementCache};
use async_trait::async_trait;
use core_foundation::base::{CFRelease, CFTypeRef};
use cua_driver_core::{
    element_token::{resolve_element_args, ResolvedElement},
    protocol::ToolResult,
    tool::{Tool, ToolDef},
    tool_args::ArgsExt,
};
use serde_json::{json, Value};

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
        let pid = match args.require_i32("pid") {
            Ok(value) => value,
            Err(error) => return error,
        };
        let window_id = match args.require_u32("window_id") {
            Ok(value) => value,
            Err(error) => return error,
        };
        let resolved = match resolve_element_args(
            pid,
            None,
            args.get("element_token").and_then(Value::as_str),
            None,
            Some(window_id),
            "read_element_state",
        ) {
            Ok(value) => value,
            Err(error) => return error,
        };
        let cache = BoundElementCache::from_resolved(&resolved);
        let index = match resolved {
            ResolvedElement::Element { element_index, .. } => Some(element_index),
            _ => None,
        };
        let focused = args.bool_or("focused", false);
        let fields = args.str_array("fields");
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(args.u64_or("timeout_ms", 100).clamp(1, 400));
        let lifetime = cua_driver_core::tool::retain_dispatch_lifetime();
        match tokio::task::spawn_blocking(move || unsafe {
            let _lifetime = lifetime;
            let guard = index.and_then(|index| cache.get_element_retained(pid, window_id, index));
            let focused_element = if index.is_none() && focused {
                crate::ax::exact_target::focused_element_in_window_before(
                    pid,
                    window_id,
                    Some(deadline),
                )
            } else {
                None
            };
            let element = guard
                .as_ref()
                .map(|guard| guard.as_ptr() as AXUIElementRef)
                .or(focused_element);
            let Some(element) = element else {
                return json!({"readable":false});
            };
            if std::time::Instant::now() >= deadline {
                if let Some(element) = focused_element {
                    CFRelease(element as CFTypeRef);
                }
                return json!({"readable":false});
            }
            let _ = AXUIElementSetMessagingTimeout(
                element,
                deadline
                    .saturating_duration_since(std::time::Instant::now())
                    .as_secs_f32()
                    .clamp(0.001, 0.025),
            );
            let value = read_state(element, &fields, deadline);
            if let Some(element) = focused_element {
                CFRelease(element as CFTypeRef);
            }
            value
        })
        .await
        {
            Ok(state) => ToolResult::text("").with_structured(state),
            Err(error) => ToolResult::error(format!("element read failed: {error}")),
        }
    }
}

unsafe fn read_state(
    element: AXUIElementRef,
    fields: &[String],
    deadline: std::time::Instant,
) -> Value {
    let role = copy_string_attr(element, "AXRole");
    let subrole = copy_string_attr(element, "AXSubrole");
    let mut state = json!({"role":role, "subrole":subrole, "editable":matches!(role.as_deref(), Some("AXTextField" | "AXTextArea" | "AXComboBox"))});
    for field in fields {
        if std::time::Instant::now() >= deadline {
            break;
        }
        let _ = AXUIElementSetMessagingTimeout(
            element,
            deadline
                .saturating_duration_since(std::time::Instant::now())
                .as_secs_f32()
                .clamp(0.001, 0.025),
        );
        let value = match field.as_str() {
            "value" if subrole.as_deref() != Some("AXSecureTextField") => {
                copy_number_attr(element, "AXValue")
                    .map(|value| json!(value))
                    .or_else(|| {
                        copy_stringish_attr(element, "AXValue")
                            .map(|value| Value::String(value.state_value))
                    })
            }
            "checked"
                if matches!(
                    role.as_deref(),
                    Some("AXCheckBox" | "AXRadioButton" | "AXSwitch" | "AXToggleButton")
                ) =>
            {
                match copy_number_attr(element, "AXValue") {
                    Some(0.0) => Some(json!(false)),
                    Some(1.0) => Some(json!(true)),
                    Some(_) => None,
                    None => copy_bool_attr(element, "AXValue").map(Value::Bool),
                }
            }
            "selected" => copy_bool_attr(element, "AXSelected").map(Value::Bool),
            "expanded" => copy_bool_attr(element, "AXExpanded").map(Value::Bool),
            _ => None,
        };
        if let Some(value) = value {
            state[field] = value;
        }
    }
    state["readable"] = json!(fields.iter().any(|field| state.get(field).is_some()));
    state
}
