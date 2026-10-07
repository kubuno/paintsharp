CREATE TABLE paintsharp.video_projects (
    id              BLOB    NOT NULL PRIMARY KEY,
    owner_id        BLOB    NOT NULL,
    title           TEXT    NOT NULL DEFAULT 'Projet vidéo sans titre',
    composition     TEXT    NOT NULL DEFAULT '{"width":1920,"height":1080,"fps":25,"duration_frames":750,"sample_rate":48000,"channels":2,"color_space":"rec709"}',
    render_settings TEXT    NOT NULL DEFAULT '{"codec":"h264","preset":"medium","crf":23,"audio_codec":"aac","audio_bitrate":"192k","container":"mp4"}',
    is_trashed      BOOLEAN NOT NULL DEFAULT 0,
    trashed_at      TEXT,
    thumbnail_path  TEXT,
    thumbnail_dirty BOOLEAN NOT NULL DEFAULT 1,
    last_edited_by  BLOB,
    file_id         BLOB,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_vidp_owner   ON video_projects(owner_id);
CREATE INDEX paintsharp.idx_paintsharp_vidp_trashed ON video_projects(is_trashed);
CREATE TRIGGER paintsharp.video_projects_updated_at AFTER UPDATE ON video_projects
BEGIN
    UPDATE video_projects SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TABLE paintsharp.video_media (
    id              BLOB    NOT NULL PRIMARY KEY,
    project_id      BLOB    NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
    owner_id        BLOB    NOT NULL,
    storage_path    TEXT    NOT NULL,
    original_name   TEXT    NOT NULL,
    mime_type       TEXT    NOT NULL,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    probe_data      TEXT    NOT NULL DEFAULT '{}',
    thumbnails_path TEXT,
    waveform_path   TEXT,
    status          TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','ready','error')),
    error_message   TEXT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_vidm_project ON video_media(project_id);
CREATE INDEX paintsharp.idx_paintsharp_vidm_owner   ON video_media(owner_id);

CREATE TABLE paintsharp.render_jobs (
    id              BLOB    NOT NULL PRIMARY KEY,
    project_id      BLOB    NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
    owner_id        BLOB    NOT NULL,
    render_options  TEXT    NOT NULL DEFAULT '{}',
    output_path     TEXT,
    output_url      TEXT,
    status          TEXT    NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','done','failed','cancelled')),
    progress        INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    frame_current   INTEGER NOT NULL DEFAULT 0,
    frame_total     INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT,
    started_at      TEXT,
    finished_at     TEXT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_rj_project ON render_jobs(project_id);
CREATE INDEX paintsharp.idx_paintsharp_rj_status  ON render_jobs(status) WHERE status IN ('queued','running');

CREATE TABLE paintsharp.video_shares (
    id          BLOB    NOT NULL PRIMARY KEY,
    project_id  BLOB    NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
    owner_id    BLOB    NOT NULL,
    token       TEXT    NOT NULL UNIQUE,
    permission  TEXT    NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
    expires_at  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_vids_project ON video_shares(project_id);
CREATE INDEX paintsharp.idx_paintsharp_vids_token   ON video_shares(token);
