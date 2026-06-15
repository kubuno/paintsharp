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

use crate::{middleware::PaintsharpUser, state::{AppState, PdfMessage}};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(doc_id): Path<Uuid>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state, user.id, doc_id))
}

async fn handle_socket(socket: WebSocket, state: AppState, user_id: Uuid, doc_id: Uuid) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.pdf_hub.subscribe(doc_id).await;

    state.pdf_hub.publish(doc_id, PdfMessage::PresenceChange {
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

    let hub2      = state.pdf_hub.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Close(_) => break,
                Message::Text(text) => {
                    if let Ok(pm) = serde_json::from_str::<PdfMessage>(&text) {
                        hub2.publish(doc_id, pm).await;
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

    state.pdf_hub.publish(doc_id, PdfMessage::PresenceChange {
        user_id,
        action: "leave".to_string(),
    }).await;
}
