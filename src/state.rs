use crate::{config::Settings, files_client::FilesClient};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

/// Message broadcast aux clients WebSocket d'une scène 3D.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SceneMessage {
    SceneUpdated {
        user_id:    Uuid,
        scene_json: serde_json::Value,
    },
    PresenceChange {
        user_id: Uuid,
        action:  String,
    },
    ObjectTransformed {
        user_id:   Uuid,
        object_id: String,
        matrix:    Vec<f64>,
    },
}

/// Hub de collaboration temps-réel (broadcast par scène).
pub struct CollabHub {
    channels: RwLock<HashMap<Uuid, broadcast::Sender<SceneMessage>>>,
}

impl CollabHub {
    pub fn new() -> Self {
        CollabHub { channels: RwLock::new(HashMap::new()) }
    }

    pub async fn subscribe(&self, scene_id: Uuid) -> broadcast::Receiver<SceneMessage> {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&scene_id) {
            return tx.subscribe();
        }
        drop(channels);

        let mut channels = self.channels.write().await;
        let (tx, rx) = broadcast::channel(64);
        channels.insert(scene_id, tx);
        rx
    }

    pub async fn publish(&self, scene_id: Uuid, msg: SceneMessage) {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&scene_id) {
            let _ = tx.send(msg);
        }
    }
}

/// Message broadcast aux clients WebSocket d'une page vectorielle (Apex).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VectorMessage {
    PageUpdated {
        user_id:   Uuid,
        page_data: serde_json::Value,
    },
    PresenceChange {
        user_id: Uuid,
        action:  String,
    },
    ElementTransformed {
        user_id:    Uuid,
        element_id: String,
        x: f64, y: f64, w: f64, h: f64,
    },
}

/// Hub de collaboration pour les pages vectorielles (Apex).
pub struct VectorHub {
    channels: RwLock<HashMap<Uuid, broadcast::Sender<VectorMessage>>>,
}

impl VectorHub {
    pub fn new() -> Self {
        VectorHub { channels: RwLock::new(HashMap::new()) }
    }

    pub async fn subscribe(&self, page_id: Uuid) -> broadcast::Receiver<VectorMessage> {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&page_id) {
            return tx.subscribe();
        }
        drop(channels);
        let mut channels = self.channels.write().await;
        let (tx, rx) = broadcast::channel(64);
        channels.insert(page_id, tx);
        rx
    }

    pub async fn publish(&self, page_id: Uuid, msg: VectorMessage) {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&page_id) {
            let _ = tx.send(msg);
        }
    }
}

/// Message broadcast aux clients WebSocket d'une animation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AnimMessage {
    AnimUpdated {
        user_id:   Uuid,
        anim_data: serde_json::Value,
    },
    PresenceChange {
        user_id: Uuid,
        action:  String,
    },
    KeyframeMoved {
        user_id:      Uuid,
        layer_id:     String,
        property_key: String,
        keyframe_id:  String,
        frame:        i64,
        value:        serde_json::Value,
    },
}

/// Hub de collaboration pour les animations (Keyframe).
pub struct AnimHub {
    channels: RwLock<HashMap<Uuid, broadcast::Sender<AnimMessage>>>,
}

impl AnimHub {
    pub fn new() -> Self {
        AnimHub { channels: RwLock::new(HashMap::new()) }
    }

    pub async fn subscribe(&self, anim_id: Uuid) -> broadcast::Receiver<AnimMessage> {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&anim_id) {
            return tx.subscribe();
        }
        drop(channels);
        let mut channels = self.channels.write().await;
        let (tx, rx) = broadcast::channel(64);
        channels.insert(anim_id, tx);
        rx
    }

    pub async fn publish(&self, anim_id: Uuid, msg: AnimMessage) {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&anim_id) {
            let _ = tx.send(msg);
        }
    }
}

/// Message broadcast aux clients WebSocket d'un projet vidéo (Motion).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VideoMessage {
    TimelineUpdated {
        user_id:       Uuid,
        timeline_data: serde_json::Value,
    },
    PresenceChange {
        user_id: Uuid,
        action:  String,
    },
    PlayheadMoved {
        user_id: Uuid,
        frame:   i64,
    },
}

/// Message broadcast aux clients WebSocket d'un document PDF (PdfWriter).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PdfMessage {
    AnnotationsUpdated {
        user_id:     uuid::Uuid,
        page_number: i32,
        annotations: serde_json::Value,
    },
    PresenceChange {
        user_id: uuid::Uuid,
        action:  String,
    },
    PageAdded {
        user_id:     uuid::Uuid,
        page_number: i32,
    },
    PageDeleted {
        user_id:     uuid::Uuid,
        page_number: i32,
    },
    PageRotated {
        user_id:     uuid::Uuid,
        page_number: i32,
        rotation:    i32,
    },
}

/// Hub de collaboration pour les documents PDF (PdfWriter).
pub struct PdfHub {
    channels: tokio::sync::RwLock<std::collections::HashMap<uuid::Uuid, tokio::sync::broadcast::Sender<PdfMessage>>>,
}

impl PdfHub {
    pub fn new() -> Self {
        PdfHub { channels: tokio::sync::RwLock::new(std::collections::HashMap::new()) }
    }

    pub async fn subscribe(&self, doc_id: uuid::Uuid) -> tokio::sync::broadcast::Receiver<PdfMessage> {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&doc_id) {
            return tx.subscribe();
        }
        drop(channels);
        let mut channels = self.channels.write().await;
        let (tx, rx) = tokio::sync::broadcast::channel(64);
        channels.insert(doc_id, tx);
        rx
    }

    pub async fn publish(&self, doc_id: uuid::Uuid, msg: PdfMessage) {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&doc_id) {
            let _ = tx.send(msg);
        }
    }
}

/// Hub de collaboration pour les projets vidéo (Motion).
pub struct VideoHub {
    channels: RwLock<HashMap<Uuid, broadcast::Sender<VideoMessage>>>,
}

impl VideoHub {
    pub fn new() -> Self {
        VideoHub { channels: RwLock::new(HashMap::new()) }
    }

    pub async fn subscribe(&self, project_id: Uuid) -> broadcast::Receiver<VideoMessage> {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&project_id) {
            return tx.subscribe();
        }
        drop(channels);
        let mut channels = self.channels.write().await;
        let (tx, rx) = broadcast::channel(64);
        channels.insert(project_id, tx);
        rx
    }

    pub async fn publish(&self, project_id: Uuid, msg: VideoMessage) {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(&project_id) {
            let _ = tx.send(msg);
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db:            PgPool,
    pub settings:      Arc<Settings>,
    pub files_client:  Arc<FilesClient>,
    pub hub:           Arc<CollabHub>,
    pub vector_hub:    Arc<VectorHub>,
    pub anim_hub:      Arc<AnimHub>,
    pub video_hub:     Arc<VideoHub>,
    pub pdf_hub:       Arc<PdfHub>,
}
