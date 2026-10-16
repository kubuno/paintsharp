//! The `drive` client must reach `drive` through the core's IPC relay.
//!
//! `kubuno_drive::client::FilesClient` sends every request to
//! `{base}/internal/ipc/drive/<rest>`, a route that only the **core** serves: it
//! authenticates the caller's internal secret, swaps in `drive`'s own and relays
//! to `drive`'s `/ipc/<rest>`. The module used to build the client from a
//! separate `core.files_url` setting instead of the core URL, so a deployment
//! whose files URL did not name the core sent the call to a route that does not
//! exist (404 as soon as a file was read or written).
//!
//! The test starts a stand-in core on a free port, configures the module the way
//! the core's supervisor does (`KUBUNO_CORE_URL` only - it never sets a files
//! URL) and checks that the client built from that configuration lands on the
//! relay, with the module's secret.

use std::sync::{Arc, Mutex};

use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use serde_json::{json, Value};

#[derive(Default)]
struct Seen {
    calls: Vec<(String, Value)>,
}

async fn ensure_path(
    State(seen): State<Arc<Mutex<Seen>>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    let secret = headers
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    seen.lock().expect("lock").calls.push((secret, body.clone()));
    Json(json!({ "folder": {
        "id": "4b8f5e2c-1f0e-4d8a-9a3b-0c1d2e3f4a5b",
        "name": "Folder",
        "path": body["path"],
    }}))
}

#[tokio::test]
async fn drive_requests_go_through_the_core_relay() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let app = Router::new()
        .route("/internal/ipc/drive/folders/ensure-path", post(ensure_path))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    // What the core's supervisor injects into a module process.
    std::env::set_var("KUBUNO_CORE_URL", format!("http://{addr}"));
    std::env::set_var("KUBUNO_INTERNAL_SECRET", "module-secret");
    std::env::remove_var("KUBUNO_FILES_URL");
    let settings = kubuno_paintsharp::config::Settings::load().expect("settings");

    let client = settings.core.files_client();
    let user = uuid::Uuid::new_v4();
    let folder = client
        .ensure_folder_path(user, "Folder", true, None)
        .await
        .expect("the drive call must reach the core's IPC relay");
    assert_eq!(folder.path, "Folder");

    let calls = &seen.lock().expect("lock").calls;
    assert_eq!(calls.len(), 1, "exactly one request relayed by the core");
    assert_eq!(calls[0].0, "module-secret", "the module authenticates with its own secret");
    assert_eq!(calls[0].1["user_id"], json!(user));
}
