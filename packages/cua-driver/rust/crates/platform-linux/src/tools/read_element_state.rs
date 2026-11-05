use async_trait::async_trait;
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
        let pid = match args.require_u32("pid") {
            Ok(value) => value,
            Err(error) => return error,
        };
        let xid = match args.require_u64("window_id") {
            Ok(value) => value,
            Err(error) => return error,
        };
        let resolved = match resolve_element_args(
            pid as i32,
            None,
            args.get("element_token").and_then(Value::as_str),
            None,
            Some(xid as u32),
            "read_element_state",
        ) {
            Ok(value) => value,
            Err(error) => return error,
        };
        let cache = crate::atspi::cache::BoundElementCache::from_resolved(&resolved);
        let index = match resolved {
            ResolvedElement::Element { element_index, .. } => Some(element_index),
            _ => None,
        };
        let identity = index.and_then(|index| cache.get_element_identity(pid, xid, index));
        if index.is_some() && identity.is_none() {
            return ToolResult::text("").with_structured(json!({"readable":false}));
        }
        let focused = args.bool_or("focused", false);
        let fields = args.str_array("fields");
        let timeout =
            std::time::Duration::from_millis(args.u64_or("timeout_ms", 100).clamp(1, 400));
        let deadline = std::time::Instant::now() + timeout;
        let lifetime = cua_driver_core::tool::retain_dispatch_lifetime();
        match tokio::task::spawn_blocking(move || {
            let _lifetime = lifetime;
            crate::atspi::native::read_element_state(
                pid, xid, index, identity, focused, &fields, deadline,
            )
        })
        .await
        {
            Ok(Ok(state)) => ToolResult::text("").with_structured(state),
            Ok(Err(_)) => ToolResult::text("").with_structured(json!({"readable":false})),
            Err(error) => ToolResult::error(format!("element read failed: {error}")),
        }
    }
}
