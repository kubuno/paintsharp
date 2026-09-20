//! Runs PaintSharp's own migrations and its pool-only store services against a
//! real server of **each** engine, from a single compiled binary — the proof
//! that the engine is a run-time choice, not a build-time one.
//!
//! * SQLite always runs (a temp file, no server).
//! * PostgreSQL runs when `KUBUNO_PG_TEST_URL` points at a throwaway database.
//! * MySQL/MariaDB runs when `KUBUNO_MYSQL_TEST_URL` does.
//!
//! ```sh
//! KUBUNO_PG_TEST_URL=postgres://u:p@localhost:5433/paintsharp \
//! KUBUNO_MYSQL_TEST_URL=mysql://u:p@localhost:3307/paintsharp \
//!   cargo test --test db_portability
//! ```
//!
//! The same binary contains all three drivers; each engine's suite is one test.
//! The suite covers the create / list / update / delete paths of the drawings
//! (vector projects + pages), the layer documents and the 3D scenes.

use kubuno_paintsharp::models::layer_doc::UpdateLayerDocDto;
use kubuno_paintsharp::models::scene::UpdateSceneDto;
use kubuno_paintsharp::models::vector::UpdateVectorProjectDto;
use kubuno_paintsharp::services::store::{self, layers, scenes, vectors};
use kubuno_paintsharp::SCHEMA;
use serde_json::json;
use uuid::Uuid;

fn base_settings(engine: &str) -> kubuno_db::DbSettings {
    kubuno_db::DbSettings {
        engine: engine.to_string(),
        url: None,
        host: None,
        port: None,
        user: None,
        password: None,
        database: None,
        path: None,
        max_connections: 4,
        min_connections: 0,
        connect_timeout: std::time::Duration::from_secs(10),
        run_migrations: true,
    }
}

/// Migrations only run one at a time: the PostgreSQL and MySQL suites may share
/// a server.
static EXCLUSIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn migrated_pool(settings: kubuno_db::DbSettings) -> (kubuno_db::DbPool, impl Sized) {
    let guard = EXCLUSIVE.lock().await;
    let pool = kubuno_db::connect(&settings, SCHEMA).await.expect("connect");

    // Exactly the calls `main.rs` makes.
    kubuno_db::migrations!(
        "./migrations/postgres",
        "./migrations/mysql",
        "./migrations/sqlite",
    )
    .run(&pool, SCHEMA)
    .await
    .expect("migrations");

    kubuno_db::events::ensure_outbox(&pool, SCHEMA)
        .await
        .expect("outbox");

    (pool, guard)
}

/// Exercises the three CRUD-heavy entities the handlers lean on.
async fn full_suite(pool: &kubuno_db::DbPool) {
    let owner = Uuid::new_v4();

    // ── Scenes (Vertex / 3D) ──────────────────────────────────────────────────
    let sid = scenes::create(pool, owner, "Ma scène", Some("desc")).await.expect("create scene");
    let scene_file = kubuno_db::new_id();
    scenes::set_file_id(pool, sid, scene_file).await.expect("set file id");

    let s = scenes::get(pool, sid, owner).await.expect("get").expect("some");
    assert_eq!(s.title, "Ma scène");
    assert_eq!(s.description.as_deref(), Some("desc"));
    assert_eq!(s.file_id, Some(scene_file));

    let listed = scenes::list(pool, owner, false, false, 50, 0).await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, sid);

    let upd = UpdateSceneDto {
        title: Some("Renommée".into()),
        description: None,
        scene_json: None,
        thumbnail_url: None,
        is_starred: Some(true),
        vertex_count: Some(42),
        face_count: None,
    };
    scenes::update(pool, sid, owner, &upd).await.expect("update scene");
    let s = scenes::get(pool, sid, owner).await.expect("get").expect("some");
    assert_eq!(s.title, "Renommée");
    assert!(s.is_starred);
    assert_eq!(s.vertex_count, 42);

    assert_eq!(scenes::list(pool, owner, true, false, 50, 0).await.expect("starred").len(), 1);
    assert_eq!(scenes::file_id(pool, sid, owner).await.expect("file id"), scene_file);
    assert!(scenes::exists(pool, sid, owner).await.expect("exists"));
    assert_eq!(scenes::find_by_file(pool, scene_file, owner).await.expect("by file"), Some(sid));

    assert_eq!(scenes::trash(pool, sid, owner).await.expect("trash"), 1);
    assert_eq!(scenes::list(pool, owner, false, true, 50, 0).await.expect("trashed").len(), 1);
    let deleted = store::delete_trashed_returning_file_id(pool, "paintsharp.scenes", sid, owner)
        .await
        .expect("delete");
    assert_eq!(deleted, Some(Some(scene_file)));
    assert!(scenes::get(pool, sid, owner).await.expect("get").is_none());
    // A second delete finds nothing to remove.
    assert!(store::delete_trashed_returning_file_id(pool, "paintsharp.scenes", sid, owner)
        .await
        .expect("re-delete")
        .is_none());

    // ── Vector projects (Apex drawings) + pages ───────────────────────────────
    let (pid, first_page) = vectors::create_project(pool, owner, "Dessin").await.expect("create project");
    vectors::set_file_id(pool, pid, kubuno_db::new_id()).await.expect("set file id");
    assert!(vectors::check_project_owner(pool, pid, owner).await.expect("owner"));
    assert!(vectors::list_projects(pool, owner, false, false, 50, 0)
        .await
        .expect("list projects")
        .iter()
        .any(|p| p.id == pid));

    // The first page sits at position 0, so the next one is 1.
    let pos = vectors::next_page_position(pool, pid).await.expect("next pos");
    assert_eq!(pos, 1);
    let page2 = vectors::create_page(pool, pid, "Page 2", pos).await.expect("create page");
    assert_eq!(vectors::page_count(pool, pid).await.expect("count"), 2);
    assert_eq!(vectors::list_page_summaries(pool, pid).await.expect("summaries").len(), 2);

    vectors::rename_page(pool, page2, pid, "Renamed").await.expect("rename page");
    let page = vectors::get_page(pool, page2, pid).await.expect("get page").expect("some");
    assert_eq!(page.name, "Renamed");

    let upd = UpdateVectorProjectDto {
        title: Some("Dessin v2".into()),
        settings: Some(json!({ "showGrid": true, "gridSize": 16 })),
        thumbnail_path: None,
        is_starred: Some(true),
    };
    assert_eq!(vectors::update_project(pool, pid, owner, &upd).await.expect("update project"), 1);
    let proj = vectors::get_project(pool, pid, owner).await.expect("get project").expect("some");
    assert_eq!(proj.title, "Dessin v2");
    assert!(proj.is_starred);
    assert_eq!(proj.settings.get("showGrid").and_then(|v| v.as_bool()), Some(true));

    vectors::delete_page(pool, page2, pid).await.expect("delete page");
    assert_eq!(vectors::page_count(pool, pid).await.expect("count"), 1);
    let _ = first_page;

    assert_eq!(vectors::trash_project(pool, pid, owner).await.expect("trash project"), 1);
    assert!(store::delete_trashed_returning_file_id(pool, "paintsharp.vector_projects", pid, owner)
        .await
        .expect("delete project")
        .is_some());
    // ON DELETE CASCADE removed the remaining page with the project.
    assert_eq!(vectors::page_count(pool, pid).await.expect("count"), 0);

    // ── Layer documents (calques) ─────────────────────────────────────────────
    let did = layers::create_doc(pool, owner, "Image", 800, 600, "rgba", 8, 72).await.expect("create doc");
    layers::set_file_id(pool, did, kubuno_db::new_id()).await.expect("set file id");
    let doc = layers::get_doc(pool, did, owner).await.expect("get doc").expect("some");
    assert_eq!(doc.width, 800);
    assert_eq!(doc.height, 600);
    assert_eq!(doc.layer_count, 1);
    assert!(layers::list_docs(pool, owner, false, false, 50, 0)
        .await
        .expect("list docs")
        .iter()
        .any(|d| d.id == did));

    let upd = UpdateLayerDocDto {
        title: Some("Image 2".into()),
        layers_structure: None,
        view_settings: None,
        thumbnail_path: None,
        thumbnail_dirty: Some(false),
        is_starred: Some(true),
        width: Some(1024),
        height: None,
    };
    assert_eq!(layers::update_doc(pool, did, owner, &upd).await.expect("update doc"), 1);
    let doc = layers::get_doc(pool, did, owner).await.expect("get doc").expect("some");
    assert_eq!(doc.title, "Image 2");
    assert_eq!(doc.width, 1024);
    assert!(doc.is_starred);

    assert_eq!(layers::save_structure(pool, did, owner, 5).await.expect("save structure"), 1);
    let doc = layers::get_doc(pool, did, owner).await.expect("get doc").expect("some");
    assert_eq!(doc.layer_count, 5);

    assert_eq!(layers::trash_doc(pool, did, owner).await.expect("trash doc"), 1);
    assert!(store::delete_trashed_returning_file_id(pool, "paintsharp.layer_documents", did, owner)
        .await
        .expect("delete doc")
        .is_some());
    assert!(layers::get_doc(pool, did, owner).await.expect("get doc").is_none());
}

#[tokio::test]
async fn sqlite_from_the_one_binary() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut s = base_settings("sqlite");
    s.path = Some(dir.path().to_string_lossy().into_owned());
    let (pool, _keep) = migrated_pool(s).await;
    full_suite(&pool).await;
}

#[tokio::test]
async fn postgres_from_the_one_binary() {
    let Ok(url) = std::env::var("KUBUNO_PG_TEST_URL") else {
        eprintln!("skipping: KUBUNO_PG_TEST_URL not set");
        return;
    };
    let mut s = base_settings("postgres");
    s.url = Some(url);
    let (pool, _keep) = migrated_pool(s).await;
    full_suite(&pool).await;
}

#[tokio::test]
async fn mysql_from_the_one_binary() {
    let Ok(url) = std::env::var("KUBUNO_MYSQL_TEST_URL") else {
        eprintln!("skipping: KUBUNO_MYSQL_TEST_URL not set");
        return;
    };
    let mut s = base_settings("mysql");
    s.url = Some(url);
    let (pool, _keep) = migrated_pool(s).await;
    full_suite(&pool).await;
}
