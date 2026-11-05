use serde::Serialize;
use serde_json::{json, Map, Value};

pub fn wait_condition_schema() -> Value {
    let element = json!({"type":"object","properties":{"role":{"type":"string","minLength":1},"name":{"type":"string","minLength":1}},"minProperties":1,"additionalProperties":false});
    let text = json!({"type":"string","minLength":1});
    let single = |key: &str, value: Value| json!({"type":"object","properties":{key:value},"required":[key],"additionalProperties":false});
    json!({"oneOf":[
        single("text", text.clone()), single("element", element.clone()),
        single("gone", json!({"oneOf":[single("text", text),single("element", element)]})),
        single("window", json!({"type":"string","enum":["opened","closed"]})),
        single("surface", json!({"type":"string","enum":["menu","sheet","dialog","alert"]})),
    ]})
}

fn wait_schema() -> Value {
    json!({"type":"object","properties":{"condition":wait_condition_schema(),"timeout_ms":{"type":"integer","minimum":1,"maximum":120000,"default":10000}},"required":["condition"],"additionalProperties":false})
}

#[derive(Clone, Debug, Serialize)]
pub struct ComputerUseTool {
    pub name: &'static str,
    pub method: &'static str,
    pub description: &'static str,
    pub read_only: bool,
    pub input_schema: Value,
}

fn tool(
    name: &'static str,
    method: &'static str,
    description: &'static str,
    read_only: bool,
    parameters: Value,
    required: &[&str],
) -> ComputerUseTool {
    let mut properties = Map::from_iter([
        (
            "app".into(),
            json!({"type":"string","minLength":1,"description":"Exact application name, identifier or absolute path from get_state/get_app."}),
        ),
        (
            "session".into(),
            json!({"type":"string","description":crate::MULTI_CALL_SESSION_DESCRIPTION}),
        ),
    ]);
    if name == "get_state" {
        properties.remove("app");
    }
    properties.extend(parameters.as_object().expect("object schema").clone());
    if !read_only && name != "get_app" && !matches!(name, "key_down" | "key_up") {
        properties.insert("wait_for".into(), wait_schema());
    }
    let desktop = matches!(
        name,
        "get_screenshot"
            | "click"
            | "double_click"
            | "right_click"
            | "scroll"
            | "drag"
            | "type_text"
            | "press_key"
            | "hotkey"
            | "key_down"
            | "key_up"
    );
    if desktop {
        properties.insert("scope".into(), json!({"type":"string","enum":["desktop"],"description":"Explicit foreground desktop input. Coordinates use the latest primary-display screenshot pixels. Omit app."}));
        if matches!(name, "key_down" | "key_up") {
            properties.remove("app");
        } else {
            properties.get_mut("app").unwrap()["description"] = json!(
                "Exact application name, identifier or absolute path. Supply exactly one of app or scope:desktop."
            );
        }
    }
    let schema = json!({
        "type":"object", "properties":properties,
        "required":required.iter().filter(|field| !desktop || **field != "app").collect::<Vec<_>>(), "additionalProperties":false,
    });
    ComputerUseTool {
        name,
        method,
        description,
        read_only,
        input_schema: schema,
    }
}

pub fn tools() -> Vec<ComputerUseTool> {
    let observation = json!({
        "force_full":{"type":"boolean","default":false},
        "max_text_chars":{"type":"integer","minimum":512,"maximum":1000000,"default":12000},
        "max_elements":{"type":"integer","minimum":1},
        "max_depth":{"type":"integer","minimum":1},
    });
    let initial_observation = observation.clone();
    let point = json!({
        "element":{"type":"integer","minimum":0,"description":"Short ID from the latest observation of this app window."},
        "x":{"type":"number","description":"Window screenshot pixel x. Requires a current screenshot."},
        "y":{"type":"number","description":"Window screenshot pixel y. Requires a current screenshot."},
    });
    let mut click = point.clone();
    click["key"] = json!({"type":"array","items":{"type":"string"},"description":"Modifier keys held during the click, such as [\"shift\"] or [\"ctrl\",\"shift\"]."});
    click["button"] = json!({"type":"string","enum":["left","middle","right"],"default":"left"});
    click["count"] = json!({"type":"integer","minimum":1,"maximum":3,"default":1});
    let mut scroll = point;
    scroll["direction"] = json!({"type":"string","enum":["up","down","left","right"]});
    scroll["amount"] = json!({"type":"integer","minimum":1,"maximum":50,"default":3});
    let text = json!({"text":{"type":"string"}});
    vec![
        tool("get_state", "getState", "List applications and their windows. Use an exact app selector for subsequent calls.", true, json!({}), &[]),
        tool("get_app", "getApp", "Resolve an application. The first call for a window returns its full AX state; later calls return changes since you last saw it. No screenshot is captured. A stopped, uniquely identified app may be opened; actions never relaunch it.", false, initial_observation, &["app"]),
        tool("get_ax_state", "getAXState", "Observe AX text without capturing pixels. Uses a diff after the first observation; force_full requests a complete view. Short IDs belong to this app window's current observation.", true, observation.clone(), &["app"]),
        tool("get_screenshot", "getScreenshot", "Observe the current application window screenshot without an AX walk. Coordinates in actions use this image's pixels.", true, json!({}), &["app"]),
        tool("get_ax_state_and_screenshot", "getAXStateAndScreenshot", "Observe AX text and the current window image together. Uses an AX diff unless force_full is set. If only the screenshot fails, returns AX with a note; take a new screenshot before using coordinates.", true, observation, &["app"]),
        tool("wait_for", "waitFor", "Wait for a change without displaying observations or advancing the model's AX baseline. Text and element conditions require more matches than at the start; gone requires a complete capture with no matches. Returns met and elapsed_ms; timeout is not an error.", true, wait_schema()["properties"].clone(), &["app", "condition"]),
        tool("click", "click", "Click a current short element ID or screenshot point. Optional key holds modifiers during the click. Observe the result before retrying an unconfirmed action.", false, click, &["app"]),
        tool("double_click", "doubleClick", "Double-click a current short element ID or screenshot point, then observe the result.", false, json!({"element":{"type":"integer","minimum":0},"x":{"type":"number"},"y":{"type":"number"}}), &["app"]),
        tool("right_click", "rightClick", "Right-click a current short element ID or screenshot point, then observe the result.", false, json!({"element":{"type":"integer","minimum":0},"x":{"type":"number"},"y":{"type":"number"}}), &["app"]),
        tool("scroll", "scroll", "Scroll at a current element or screenshot point. Observe the result before sending another scroll.", false, scroll, &["app","direction"]),
        tool("drag", "drag", "Drag between current window screenshot points. Unsupported background gestures refuse before sending input; use semantic value operations when available.", false, json!({"from_x":{"type":"number"},"from_y":{"type":"number"},"to_x":{"type":"number"},"to_y":{"type":"number"}}), &["app","from_x","from_y","to_x","to_y"]),
        tool("type_text", "typeText", "Insert text at the current text caret. This does not replace the whole field; use set_value for replacement.", false, text.clone(), &["app","text"]),
        tool("set_value", "setValue", "Replace the entire value of the current short element ID and read back the result. Refuses a non-settable element or a write that was not applied.", false, json!({"element":{"type":"integer","minimum":0},"value":{"type":"string"}}), &["app","element","value"]),
        tool("press_key", "pressKey", "Press a key in the selected app. Optional modifiers form a chord. Observe before retrying an unconfirmed dispatch.", false, json!({"key":{"type":"string"},"modifiers":{"type":"array","items":{"type":"string"}}}), &["app","key"]),
        tool("hotkey", "hotkey", "Press a modifier/key chord in the selected app.", false, json!({"keys":{"type":"array","minItems":1,"items":{"type":"string"}}}), &["app","keys"]),
        tool("key_down", "desktop.keyDown", "Hold a desktop key for this session. Release with key_up in finally. Session end releases owned keys. While keys are held, use key_down/key_up for chords and desktop pointer actions without explicit modifiers.", false, json!({"key":{"type":"string","minLength":1}}), &["scope","key"]),
        tool("key_up", "desktop.keyUp", "Release a desktop key held by this session. Another session cannot release it.", false, json!({"key":{"type":"string","minLength":1}}), &["scope","key"]),
        tool("paste", "paste", "Paste text at the caret using a temporary clipboard value, then restore the previous clipboard even if the operation fails.", false, text, &["app","text"]),
        tool("select_text", "selectText", "Select one unambiguous text match inside a current short element ID. Does not change the field value.", false, json!({"element":{"type":"integer","minimum":0},"text":{"type":"string"}}), &["app","element","text"]),
        tool("perform_secondary_action", "performSecondaryAction", "Perform an explicitly named secondary accessibility action on a current short element ID.", false, json!({"element":{"type":"integer","minimum":0},"action":{"type":"string"}}), &["app","element","action"]),
    ]
}

pub fn manifest() -> Value {
    json!({"version":1,"tools":tools()})
}

/// Versioned dispatch acknowledgement for the app surface; no effect is claimed.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppActionOutput {
    pub computer_use: u8,
    pub sent: bool,
    #[serde(default)]
    pub delivery: Option<DispatchDelivery>,
    #[serde(default)]
    pub retry: Option<DispatchRetry>,
    #[serde(default)]
    pub wait: Option<WaitOutput>,
    #[serde(default)]
    pub advisory: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchDelivery {
    NotDelivered,
    DeliveredVerified,
    DeliveredUnverified,
    DeliveryUncertain,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchRetry {
    Safe,
    Unsafe,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaitOutput {
    pub met: bool,
    pub elapsed_ms: u64,
    pub condition: Value,
}
impl AppActionOutput {
    pub fn validate(&self) -> Result<(), String> {
        if self.computer_use != 1 || !self.sent {
            return Err("invalid Computer Use dispatch acknowledgement".into());
        }
        match (self.delivery, self.retry) {
            (None, None) => {} // Older driver acknowledgements remain readable.
            (Some(delivery), Some(DispatchRetry::Unsafe))
                if delivery != DispatchDelivery::NotDelivered => {}
            _ => return Err("invalid Computer Use delivery/retry pair".into()),
        }
        Ok(())
    }
}

pub fn has_programmatic_controls(name: &str, args: &Value) -> bool {
    name == "cancel_wait"
        || is_app_call(name, args)
            && (args.get("deliver").is_some() || args.get("wait_id").is_some())
}

pub fn is_app_call(name: &str, args: &Value) -> bool {
    matches!(
        name,
        "get_state" | "get_app" | "get_ax_state" | "get_screenshot" | "get_ax_state_and_screenshot"
    ) || (args.get("app").is_some() || args["scope"] == "desktop")
        && tools().iter().any(|tool| tool.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wait_schema_exposes_conditions_but_not_delivery_controls() {
        let tools = tools();
        let wait = tools.iter().find(|tool| tool.name == "wait_for").unwrap();
        assert!(wait.read_only);
        assert_eq!(
            wait.input_schema["properties"]["condition"]["oneOf"][0]["required"],
            json!(["text"])
        );
        assert_eq!(
            wait.input_schema["properties"]["timeout_ms"]["maximum"],
            120000
        );
        for tool in tools {
            for internal in ["deliver", "pin", "wait_id"] {
                assert!(tool.input_schema["properties"].get(internal).is_none());
            }
        }
    }
    #[test]
    fn dispatch_acknowledgements_reject_safe_retries_after_delivery() {
        for delivery in [
            "delivered_verified",
            "delivered_unverified",
            "delivery_uncertain",
            "unknown",
        ] {
            let mut output =
                json!({"computer_use":1,"sent":true,"delivery":delivery,"retry":"unsafe"});
            assert!(serde_json::from_value::<AppActionOutput>(output.clone())
                .unwrap()
                .validate()
                .is_ok());
            output["retry"] = json!("safe");
            assert!(serde_json::from_value::<AppActionOutput>(output)
                .unwrap()
                .validate()
                .is_err());
        }
    }
}
