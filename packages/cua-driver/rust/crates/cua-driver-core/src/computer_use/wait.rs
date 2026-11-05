use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{checked, error};
use crate::protocol::ToolResult;
use crate::tool::ToolRegistry;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Condition {
    Text(String),
    Element(Element),
    Gone(Matcher),
    Window(WindowChange),
    Surface(Surface),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Matcher {
    Text(String),
    Element(Element),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Element {
    role: Option<String>,
    name: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum WindowChange {
    Opened,
    Closed,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Surface {
    Menu,
    Sheet,
    Dialog,
    Alert,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub condition: Condition,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

fn default_timeout() -> u64 {
    10000
}

impl Request {
    pub fn parse(value: Value) -> Result<Self, ToolResult> {
        let request: Self = serde_json::from_value(value).map_err(|e| {
            error(
                "invalid_arguments",
                format!("Invalid wait condition: {e}"),
                false,
            )
        })?;
        if !(1..=120000).contains(&request.timeout_ms) || !request.condition.valid() {
            return Err(error(
                "invalid_arguments",
                "Wait requires a non-empty condition and timeout_ms between 1 and 120000.",
                false,
            ));
        }
        Ok(request)
    }
}

fn nonempty(value: &str) -> bool {
    !value.trim().is_empty()
}

impl Element {
    fn valid(&self) -> bool {
        (self.role.is_some() || self.name.is_some())
            && self.role.as_deref().is_none_or(nonempty)
            && self.name.as_deref().is_none_or(nonempty)
    }
    fn matches(&self, node: &Value) -> bool {
        self.role.as_deref().is_none_or(|role| {
            node["role"]
                .as_str()
                .is_some_and(|actual| role_key(role) == role_key(actual))
        }) && self
            .name
            .as_deref()
            .is_none_or(|name| node["name"].as_str() == Some(name))
    }
}

fn role_key(role: &str) -> String {
    role.strip_prefix("AX")
        .unwrap_or(role)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn text_matches(text: &str, node: &Value) -> bool {
    ["name", "value"].iter().any(|field| {
        node[*field]
            .as_str()
            .is_some_and(|value| value.contains(text))
    })
}

impl Condition {
    fn valid(&self) -> bool {
        match self {
            Self::Text(text) | Self::Gone(Matcher::Text(text)) => nonempty(text),
            Self::Element(element) | Self::Gone(Matcher::Element(element)) => element.valid(),
            _ => true,
        }
    }
    fn matches(&self, node: &Value) -> bool {
        match self {
            Self::Text(text) | Self::Gone(Matcher::Text(text)) => text_matches(text, node),
            Self::Element(element) | Self::Gone(Matcher::Element(element)) => element.matches(node),
            Self::Surface(surface) => {
                let role = role_key(node["role"].as_str().unwrap_or_default());
                let subrole = role_key(node["subrole"].as_str().unwrap_or_default());
                match surface {
                    Surface::Menu => matches!(role.as_str(), "menu" | "popupmenu"),
                    Surface::Sheet => role == "sheet",
                    Surface::Dialog => {
                        matches!(role.as_str(), "dialog" | "systemdialog")
                            || matches!(subrole.as_str(), "dialog" | "systemdialog")
                            || node["modal"] == true
                    }
                    Surface::Alert => matches!(role.as_str(), "alert" | "alertdialog"),
                }
            }
            Self::Window(_) => false,
        }
    }
    fn met(&self, before: &Snapshot, after: &Snapshot) -> bool {
        match self {
            Self::Window(WindowChange::Opened) => !after.windows.is_subset(&before.windows),
            Self::Window(WindowChange::Closed) => !before.windows.is_subset(&after.windows),
            Self::Gone(_) => after.count == Some(0),
            _ => before
                .count
                .zip(after.count)
                .is_some_and(|(before, after)| after > before),
        }
    }
}

pub(super) struct Snapshot {
    windows: HashSet<(u64, u64)>,
    count: Option<usize>,
}

pub(super) async fn snapshot(
    registry: &ToolRegistry,
    pid: u64,
    session: Option<&Value>,
    condition: &Condition,
) -> Result<Snapshot, ToolResult> {
    let mut input = json!({"pid":pid,"app_context":true});
    if let Some(session) = session {
        input["session"] = session.clone();
    }
    let result = checked(
        Box::pin(registry.invoke_computer_use_native("list_windows", input)).await,
        false,
    )?;
    let structured = result.structured_content.as_ref().ok_or_else(|| {
        error(
            "observation_unavailable",
            "Wait could not read the app's window inventory.",
            false,
        )
    })?;
    let windows = structured["windows"].as_array().ok_or_else(|| {
        error(
            "observation_unavailable",
            "Wait received no window inventory.",
            false,
        )
    })?;
    let mut capture = Snapshot {
        windows: HashSet::new(),
        count: Some(0),
    };
    for window in windows {
        let window_id = window["window_id"].as_u64().ok_or_else(|| {
            error(
                "observation_unavailable",
                "Wait received a window without native identity.",
                false,
            )
        })?;
        let window_pid = window["pid"].as_u64().unwrap_or(pid);
        capture.windows.insert((window_pid, window_id));
        if matches!(condition, Condition::Window(_)) {
            continue;
        }
        // Window inventories also contain hidden auxiliary surfaces without AX trees.
        if window["is_on_screen"] == false && window["is_app_target"] != true {
            continue;
        }
        let mut input = json!({"pid":window_pid,"window_id":window_id,"app_context":true,"include_screenshot":false,"include_accessibility":true});
        if let Some(session) = session {
            input["session"] = session.clone();
        }
        let result = checked(
            Box::pin(registry.invoke_computer_use_observation(input)).await,
            false,
        )?;
        let state = result.structured_content.unwrap_or_default();
        let nodes = state["observation_nodes"].as_array();
        if state["capture_complete"] == false
            || state["truncated"] == true
            || state["capture_truncated"] == true
            || state["capture_read_complete"] == false
            || state["degraded"] == true
            || nodes.is_none()
        {
            capture.count = None;
        } else if let Some(count) = capture.count.as_mut() {
            *count += nodes
                .unwrap()
                .iter()
                .filter(|node| condition.matches(node))
                .count();
        }
    }
    Ok(capture)
}

pub(super) async fn baseline(
    registry: &ToolRegistry,
    pid: u64,
    session: Option<&Value>,
    request: &Request,
) -> Result<Snapshot, ToolResult> {
    let captured = tokio::time::timeout(
        Duration::from_millis(request.timeout_ms),
        snapshot(registry, pid, session, &request.condition),
    )
    .await
    .map_err(|_| {
        error(
            "observation_unavailable",
            "Wait baseline timed out before dispatch.",
            false,
        )
    })??;
    if captured.count.is_none() {
        return Err(error(
            "observation_unavailable",
            "A complete observation is required to establish the wait baseline.",
            false,
        ));
    }
    Ok(captured)
}

pub(super) async fn run(
    registry: &ToolRegistry,
    pid: u64,
    session: Option<&Value>,
    request: &Request,
    before: Snapshot,
    condition: Value,
) -> Result<Value, ToolResult> {
    let started = Instant::now();
    let deadline = started + Duration::from_millis(request.timeout_ms);
    let mut interval = Duration::ZERO;
    loop {
        tokio::time::sleep(interval.min(deadline.saturating_duration_since(Instant::now()))).await;
        if Instant::now() >= deadline {
            break;
        }
        let walked = Instant::now();
        let after = tokio::time::timeout_at(
            tokio::time::Instant::from_std(deadline),
            snapshot(registry, pid, session, &request.condition),
        )
        .await;
        match after {
            Ok(Ok(after)) if request.condition.met(&before, &after) => {
                return Ok(
                    json!({"met":true,"elapsed_ms":started.elapsed().as_millis() as u64,"condition":condition}),
                )
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => break,
            _ => {}
        }
        interval = walked.elapsed().max(Duration::from_millis(100));
    }
    Ok(json!({"met":false,"elapsed_ms":started.elapsed().as_millis() as u64,"condition":condition}))
}

pub(super) fn status(result: &Value) -> String {
    format!(
        "{}met after {} ms",
        if result["met"] == true { "" } else { "not " },
        result["elapsed_ms"]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_ambiguous_and_empty_waits() {
        for condition in [
            json!({}),
            json!({"text":""}),
            json!({"text":"x","window":"opened"}),
            json!({"element":{}}),
            json!({"element":{"role":"button","other":1}}),
            json!({"gone":{"surface":"menu"}}),
        ] {
            assert!(Request::parse(json!({"condition":condition})).is_err());
        }
        assert!(Request::parse(json!({"condition":{"text":"done"},"timeout_ms":120001})).is_err());
    }
    #[test]
    fn conditions_compare_complete_counts_and_native_roles() {
        let condition = Condition::Text("Saved".into());
        let before = Snapshot {
            windows: HashSet::new(),
            count: Some(1),
        };
        assert!(!condition.met(
            &before,
            &Snapshot {
                windows: HashSet::new(),
                count: Some(1)
            }
        ));
        assert!(condition.met(
            &before,
            &Snapshot {
                windows: HashSet::new(),
                count: Some(2)
            }
        ));
        assert!(!Condition::Gone(Matcher::Text("Saved".into())).met(
            &before,
            &Snapshot {
                windows: HashSet::new(),
                count: None
            }
        ));
        assert!(Condition::Surface(Surface::Dialog)
            .matches(&json!({"role":"AXWindow","subrole":"AXSystemDialog"})));
        assert!(Condition::Surface(Surface::Dialog)
            .matches(&json!({"role":"AXWindow","subrole":"AXDialog"})));
        assert!(Condition::Element(Element {
            role: Some("button".into()),
            name: Some("Save".into())
        })
        .matches(&json!({"role":"AXButton","name":"Save"})));
        let before = Snapshot {
            windows: HashSet::from([(42, 7)]),
            count: Some(0),
        };
        let after = Snapshot {
            windows: HashSet::from([(42, 7), (42, 8)]),
            count: Some(1),
        };
        assert!(Condition::Window(WindowChange::Opened).met(&before, &after));
        assert!(!Condition::Window(WindowChange::Closed).met(&before, &after));
        assert!(Condition::Window(WindowChange::Closed).met(&after, &before));
        assert!(!Condition::Window(WindowChange::Opened).met(&before, &before));
        assert!(Condition::Surface(Surface::Menu).met(&before, &after));
        assert!(!Condition::Surface(Surface::Menu).met(&after, &after));
        for (surface, role) in [
            (Surface::Menu, "AXMenu"),
            (Surface::Sheet, "AXSheet"),
            (Surface::Alert, "alert"),
        ] {
            assert!(Condition::Surface(surface).matches(&json!({"role":role})));
            assert!(!Condition::Surface(surface).matches(&json!({"role":"Window"})));
        }
    }
}

#[derive(Default)]
pub(super) struct Cancellations {
    entries: std::sync::Mutex<
        std::collections::HashMap<(crate::tool::DispatchSessionIdentity, String), CancelEntry>,
    >,
}
struct CancelEntry {
    signal: tokio::sync::watch::Sender<bool>,
    created: Instant,
    active: bool,
}
pub(super) struct Cancellation<'a> {
    registry: &'a Cancellations,
    key: (crate::tool::DispatchSessionIdentity, String),
    signal: tokio::sync::watch::Receiver<bool>,
}
impl Cancellations {
    fn key(id: &Value) -> Result<(crate::tool::DispatchSessionIdentity, String), ToolResult> {
        let id = id
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or_else(|| {
                error(
                    "invalid_arguments",
                    "wait_id must be 1 to 128 bytes.",
                    false,
                )
            })?;
        let owner = crate::tool::current_dispatch_session_identity().ok_or_else(|| {
            error(
                "session_unavailable",
                "A bound session is required for wait cancellation.",
                false,
            )
        })?;
        Ok((owner, id.to_owned()))
    }
    pub fn clear_session(&self, session: &str) {
        self.entries.lock().unwrap().retain(|(owner, _), entry| {
            let retain = owner.session_id != session && owner.transport_session_id != session;
            if !retain {
                entry.signal.send_replace(true);
            }
            retain
        });
    }
    pub fn cancel(&self, id: &Value) -> Result<(), ToolResult> {
        let key = Self::key(id)?;
        let mut entries = self.entries.lock().unwrap();
        entries
            .retain(|_, entry| entry.active || entry.created.elapsed() < Duration::from_secs(600));
        if !entries.contains_key(&key) && entries.len() >= 1024 {
            return Err(error(
                "resource_exhausted",
                "Too many pending wait cancellations.",
                false,
            ));
        }
        // Cancellation may reach the registry before its action request is admitted.
        let entry = entries.entry(key).or_insert_with(|| CancelEntry {
            signal: tokio::sync::watch::channel(false).0,
            created: Instant::now(),
            active: false,
        });
        entry.signal.send_replace(true);
        Ok(())
    }
    pub fn register(&self, id: &Value) -> Result<Cancellation<'_>, ToolResult> {
        let key = Self::key(id)?;
        let mut entries = self.entries.lock().unwrap();
        entries
            .retain(|_, entry| entry.active || entry.created.elapsed() < Duration::from_secs(600));
        if !entries.contains_key(&key) && entries.len() >= 1024 {
            return Err(error(
                "resource_exhausted",
                "Too many pending waits.",
                false,
            ));
        }
        let entry = entries.entry(key.clone()).or_insert_with(|| CancelEntry {
            signal: tokio::sync::watch::channel(false).0,
            created: Instant::now(),
            active: false,
        });
        if entry.active {
            return Err(error(
                "invalid_arguments",
                "wait_id is already active.",
                false,
            ));
        }
        entry.active = true;
        Ok(Cancellation {
            registry: self,
            key,
            signal: entry.signal.subscribe(),
        })
    }
}
impl Cancellation<'_> {
    pub fn is_cancelled(&self) -> bool {
        *self.signal.borrow()
    }
    pub async fn cancelled(&self) {
        let mut signal = self.signal.clone();
        if *signal.borrow() {
            return;
        }
        let _ = signal.changed().await;
    }
}
impl Drop for Cancellation<'_> {
    fn drop(&mut self) {
        self.registry.entries.lock().unwrap().remove(&self.key);
    }
}

pub(super) async fn cancellable<T>(
    cancel: Option<&Cancellation<'_>>,
    future: impl std::future::Future<Output = Result<T, ToolResult>>,
) -> Result<T, ToolResult> {
    if let Some(cancel) = cancel {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(error("call_cancelled", "Wait was cancelled. Actions already dispatched may have taken effect; observe before retrying.", false)),
            result = future => result,
        }
    } else {
        future.await
    }
}
