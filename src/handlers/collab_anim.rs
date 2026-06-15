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

use crate::{middleware::PaintsharpUser, state::{AnimMessage, AppState}};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(anim_id): Path<Uuid>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state, user.id, anim_id))
}

async fn handle_socket(socket: WebSocket, state: AppState, user_id: Uuid, anim_id: Uuid) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.anim_hub.subscribe(anim_id).await;

    state.anim_hub.publish(anim_id, AnimMessage::PresenceChange {
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

    let hub2      = state.anim_hub.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Close(_) => break,
                Message::Text(text) => {
                    if let Ok(am) = serde_json::from_str::<AnimMessage>(&text) {
                        hub2.publish(anim_id, am).await;
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

    state.anim_hub.publish(anim_id, AnimMessage::PresenceChange {
        user_id,
        action: "leave".to_string(),
    }).await;
}
