use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{checked, error};
use crate::action_record::{
    ActionEffect, ActionEvidence, ActionTransport, ActualDelivery, EvidenceKind,
};
use crate::protocol::ToolResult;
use crate::tool::ToolRegistry;

pub(super) enum Expected {
    Value(String),
    Contains(String),
    Bool(&'static str, bool),
}

#[derive(Default)]
pub(super) struct Readback {
    pub confirmed: bool,
    pub contradicted: bool,
    pub timed_out: bool,
}

fn role_key(state: &Value) -> String {
    let role = state["role"].as_str().unwrap_or_default();
    role.strip_prefix("AX")
        .unwrap_or(role)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

impl Expected {
    pub fn for_action(name: &str, input: &Value, before: &Value) -> Option<Self> {
        match name {
            "set_value" => input["value"].as_str().map(|s| Self::Value(s.into())),
            "type_text" if before["editable"] == true => {
                input["text"].as_str().filter(|s| !s.is_empty()).map(|s| {
                    Self::Contains(
                        s.chars()
                            .rev()
                            .take(64)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect(),
                    )
                })
            }
            "perform_secondary_action" => match input["action"].as_str()?.to_lowercase().as_str() {
                "expand" | "axexpand" => Some(Self::Bool("expanded", true)),
                "collapse" | "axcollapse" => Some(Self::Bool("expanded", false)),
                _ => None,
            },
            "click" => match role_key(before).as_str() {
                "checkbox" | "switch" | "togglebutton" => before["checked"]
                    .as_bool()
                    .map(|checked| Self::Bool("checked", !checked)),
                "radio" | "radiobutton" | "radiomenuitem" => Some(Self::Bool("checked", true)),
                "listitem" | "tab" | "tabitem" | "menuitemradio" | "popupoption" | "option" => {
                    Some(Self::Bool("selected", true))
                }
                _ => before["checked"]
                    .as_bool()
                    .map(|checked| Self::Bool("checked", !checked)),
            },
            _ => None,
        }
    }

    fn matches(&self, state: &Value) -> Option<bool> {
        match self {
            Self::Bool(field, expected) => {
                state[*field].as_bool().map(|actual| actual == *expected)
            }
            Self::Value(expected) => match &state["value"] {
                Value::Number(actual) => actual
                    .as_f64()
                    .zip(expected.trim().parse::<f64>().ok())
                    .map(|(actual, expected)| actual == expected),
                Value::String(actual) => Some(actual.trim() == expected.trim()),
                _ => None,
            },
            Self::Contains(expected) => state["value"]
                .as_str()
                .map(|actual| actual.contains(expected)),
        }
    }
}

pub(super) fn read_input(name: &str, input: &Value) -> Option<Value> {
    let fields = match name {
        "set_value" | "type_text" => json!(["value"]),
        "click" if input.get("element_token").is_some() => json!(["checked", "selected"]),
        "perform_secondary_action" => json!(["expanded"]),
        _ => return None,
    };
    let mut read = json!({"pid":input["pid"],"window_id":input["window_id"],"fields":fields});
    for field in ["element_token", "session"] {
        if let Some(value) = input.get(field) {
            read[field] = value.clone();
        }
    }
    if name == "type_text" {
        read["focused"] = json!(true);
    }
    Some(read)
}

pub(super) async fn read(registry: &ToolRegistry, input: &Value, budget: Duration) -> Value {
    let mut input = input.clone();
    input["timeout_ms"] = json!(budget.as_millis() as u64);
    match tokio::time::timeout(
        budget,
        Box::pin(registry.invoke_computer_use_native("read_element_state", input)),
    )
    .await
    {
        Ok(result) => result.structured_content.unwrap_or_default(),
        Err(_) => json!({"readable":false,"readback_timed_out":true}),
    }
}

pub(super) async fn verify(
    registry: &ToolRegistry,
    input: &Value,
    expected: &Expected,
) -> Readback {
    let deadline = Instant::now() + Duration::from_millis(400);
    let mut result = Readback::default();
    loop {
        tokio::time::sleep(
            Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())),
        )
        .await;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return result;
        }
        let after = read(registry, input, remaining).await;
        result.timed_out |= after["readback_timed_out"] == true;
        match expected.matches(&after) {
            Some(true) => {
                result.confirmed = true;
                result.contradicted = false;
                return result;
            }
            Some(false) => result.contradicted = true,
            None => {}
        }
        if result.timed_out || Instant::now() >= deadline {
            return result;
        }
    }
}

pub(super) fn acknowledge(
    name: &str,
    target: &str,
    result: ToolResult,
    readback: Readback,
) -> Result<ToolResult, ToolResult> {
    let mut result = checked(result, true)?;
    if let Some(record) = result.action_record.as_mut() {
        if readback.confirmed {
            record.effect = ActionEffect::Confirmed;
            record.evidence.push(ActionEvidence {
                kind: EvidenceKind::AccessibilityReadback,
                detail: "State matched bounded action readback.".into(),
            });
        }
    }
    let record = result.action_record.as_ref();
    if record.is_some_and(|r| r.effect == ActionEffect::Refused) {
        return Err(error(
            "operation_refused",
            "The native actuator refused before delivery.",
            false,
        ));
    }
    let (delivery, reason) =
        if readback.confirmed || record.is_some_and(|r| r.effect == ActionEffect::Confirmed) {
            ("delivered_verified", None)
        } else if readback.contradicted {
            (
                "delivered_unverified",
                Some("state did not match the requested change"),
            )
        } else if record.is_some_and(|r| {
            matches!(
                r.effect,
                ActionEffect::SuspectedNoop | ActionEffect::Partial
            )
        }) {
            (
                "delivered_unverified",
                Some("native readback reported a partial effect or suspected no-op"),
            )
        } else if record.is_some_and(|r| semantic(r.transport)) {
            ("delivered_unverified", None)
        } else if record.is_some_and(|r| {
            matches!(
                r.transport,
                ActionTransport::MacosCgEventHid
                    | ActionTransport::WindowsSendInput
                    | ActionTransport::LinuxXTest
                    | ActionTransport::LinuxUinput
            ) && r.actual_delivery == Some(ActualDelivery::Foreground)
        }) {
            ("delivered_unverified", None)
        } else if record.is_some_and(|r| {
            matches!(
                r.transport,
                ActionTransport::MacosCgEventPid
                    | ActionTransport::WindowsPostMessage
                    | ActionTransport::WindowsTargetedInjection
                    | ActionTransport::LinuxXSendEvent
            )
        }) {
            ("delivery_uncertain", Some("delivery not confirmed"))
        } else {
            ("unknown", Some("delivery evidence unavailable"))
        };
    let advisory = reason.map(|reason| format!("{name}({target}): {reason}"));
    let mut structured = json!({"computer_use":1,"sent":true,"delivery":delivery,"retry":"unsafe"});
    if let Some(advisory) = &advisory {
        structured["advisory"] = json!(advisory);
    }
    let mut output = ToolResult::text(advisory.unwrap_or_default()).with_structured(structured);
    output.action_record = result.action_record;
    Ok(output)
}

fn semantic(transport: ActionTransport) -> bool {
    #[cfg(target_os = "macos")]
    if transport == ActionTransport::MacosAppleEvents {
        return true;
    }
    matches!(
        transport,
        ActionTransport::MacosAxAction
            | ActionTransport::MacosAxValue
            | ActionTransport::WindowsUiaInvoke
            | ActionTransport::WindowsUiaToggle
            | ActionTransport::WindowsUiaSelection
            | ActionTransport::WindowsUiaExpandCollapse
            | ActionTransport::WindowsUiaValue
            | ActionTransport::WindowsUiaRangeValue
            | ActionTransport::WindowsUiaScroll
            | ActionTransport::WindowsMsaaAction
            | ActionTransport::LinuxAtSpiAction
            | ActionTransport::LinuxAtSpiValue
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action_record::{ActionExecutionRecord, RequestedDelivery};
    fn result(transport: ActionTransport, actual: ActualDelivery) -> ToolResult {
        let mut result = ToolResult::text("");
        result.action_record = Some(
            ActionExecutionRecord::builder(
                ActionEffect::Unverifiable,
                transport,
                RequestedDelivery::Background,
            )
            .actual_delivery(actual)
            .build()
            .unwrap(),
        );
        result
    }
    #[test]
    fn dispatch_evidence_controls_advisories_without_claiming_effect() {
        for (transport, actual, delivery, advisory) in [
            (
                ActionTransport::MacosAxAction,
                ActualDelivery::Background,
                "delivered_unverified",
                false,
            ),
            (
                ActionTransport::WindowsSendInput,
                ActualDelivery::Foreground,
                "delivered_unverified",
                false,
            ),
            (
                ActionTransport::WindowsSendInput,
                ActualDelivery::Unknown,
                "unknown",
                true,
            ),
            (
                ActionTransport::WindowsTargetedInjection,
                ActualDelivery::Foreground,
                "delivery_uncertain",
                true,
            ),
            (
                ActionTransport::LinuxXSendEvent,
                ActualDelivery::Background,
                "delivery_uncertain",
                true,
            ),
        ] {
            let output = acknowledge("click", "1", result(transport, actual), Readback::default())
                .unwrap()
                .structured_content
                .unwrap();
            assert_eq!(output["delivery"], delivery);
            assert_eq!(output.get("advisory").is_some(), advisory);
            assert_eq!(output["retry"], "unsafe");
        }
    }
    #[test]
    fn contradictory_readback_is_never_silent() {
        let output = acknowledge(
            "click",
            "1",
            result(ActionTransport::MacosAxAction, ActualDelivery::Background),
            Readback {
                contradicted: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(output.structured_content.unwrap().get("advisory").is_some());
    }
    #[test]
    fn value_checks_distinguish_absent_and_false_values() {
        assert_eq!(
            Expected::Value(" 2 ".into()).matches(&json!({"value":2})),
            Some(true)
        );
        assert_eq!(Expected::Bool("checked", false).matches(&json!({})), None);
        assert_eq!(
            Expected::Bool("checked", false).matches(&json!({"checked":false})),
            Some(true)
        );
        assert!(Expected::for_action("click", &json!({}), &json!({"role":"AXButton"})).is_none());
    }
}
