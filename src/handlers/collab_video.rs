use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::Response,
    Extension,
};
use futures::{SinkExt, StreamExt};
use uuid::Uuid;

use crate::{middleware::PaintsharpUser, state::{AppState, VideoMessage}};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state, user.id, project_id))
}

async fn handle_socket(socket: WebSocket, state: AppState, user_id: Uuid, project_id: Uuid) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.video_hub.subscribe(project_id).await;

    state.video_hub.publish(project_id, VideoMessage::PresenceChange {
        user_id,
        action: "join".to_string(),
    }).await;

    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if let Ok(payload) = serde_json::to_string(&msg) {
                if sender.send(Message::Text(payload.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    let hub2      = state.video_hub.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Close(_) => break,
                Message::Text(text) => {
                    if let Ok(vm) = serde_json::from_str::<VideoMessage>(&text) {
                        hub2.publish(project_id, vm).await;
                    }
                }
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = send_task => {}
        _ = recv_task => {}
    }

    state.video_hub.publish(project_id, VideoMessage::PresenceChange {
        user_id,
        action: "leave".to_string(),
    }).await;
}
