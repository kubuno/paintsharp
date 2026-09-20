CREATE TABLE paintsharp.video_projects (
    id              BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id        BINARY(16)   NOT NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Projet vidéo sans titre',
    composition     JSON         NOT NULL DEFAULT (_utf8mb4'{"width":1920,"height":1080,"fps":25,"duration_frames":750,"sample_rate":48000,"channels":2,"color_space":"rec709"}'),
    render_settings JSON         NOT NULL DEFAULT (_utf8mb4'{"codec":"h264","preset":"medium","crf":23,"audio_codec":"aac","audio_bitrate":"192k","container":"mp4"}'),
    is_trashed      BOOLEAN      NOT NULL DEFAULT FALSE,
    trashed_at      DATETIME(6),
    thumbnail_path  TEXT,
    thumbnail_dirty BOOLEAN      NOT NULL DEFAULT TRUE,
    last_edited_by  BINARY(16),
    file_id         BINARY(16),
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_paintsharp_vidp_owner   ON paintsharp.video_projects(owner_id);
CREATE INDEX idx_paintsharp_vidp_trashed ON paintsharp.video_projects(is_trashed);

CREATE TABLE paintsharp.video_media (
    id              BINARY(16)   NOT NULL PRIMARY KEY,
    project_id      BINARY(16)   NOT NULL,
    owner_id        BINARY(16)   NOT NULL,
    storage_path    TEXT         NOT NULL,
    original_name   VARCHAR(500) NOT NULL,
    mime_type       VARCHAR(100) NOT NULL,
    size_bytes      BIGINT       NOT NULL DEFAULT 0,
    probe_data      JSON         NOT NULL DEFAULT (_utf8mb4'{}'),
    thumbnails_path TEXT,
    waveform_path   TEXT,
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','ready','error')),
    error_message   TEXT,
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    FOREIGN KEY (project_id) REFERENCES paintsharp.video_projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_paintsharp_vidm_project ON paintsharp.video_media(project_id);
CREATE INDEX idx_paintsharp_vidm_owner   ON paintsharp.video_media(owner_id);

CREATE TABLE paintsharp.render_jobs (
    id              BINARY(16)   NOT NULL PRIMARY KEY,
    project_id      BINARY(16)   NOT NULL,
    owner_id        BINARY(16)   NOT NULL,
    render_options  JSON         NOT NULL DEFAULT (_utf8mb4'{}'),
    output_path     TEXT,
    output_url      TEXT,
    status          VARCHAR(20)  NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','done','failed','cancelled')),
    progress        SMALLINT     NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    frame_current   INT          NOT NULL DEFAULT 0,
    frame_total     INT          NOT NULL DEFAULT 0,
    error_message   TEXT,
    started_at      DATETIME(6),
    finished_at     DATETIME(6),
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    FOREIGN KEY (project_id) REFERENCES paintsharp.video_projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_paintsharp_rj_project ON paintsharp.render_jobs(project_id);
CREATE INDEX idx_paintsharp_rj_status  ON paintsharp.render_jobs(status);

CREATE TABLE paintsharp.video_shares (
    id          BINARY(16)  NOT NULL PRIMARY KEY,
    project_id  BINARY(16)  NOT NULL,
    owner_id    BINARY(16)  NOT NULL,
    token       VARCHAR(64) NOT NULL UNIQUE,
    permission  VARCHAR(20) NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
    expires_at  DATETIME(6),
    created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    FOREIGN KEY (project_id) REFERENCES paintsharp.video_projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_paintsharp_vids_project ON paintsharp.video_shares(project_id);
CREATE INDEX idx_paintsharp_vids_token   ON paintsharp.video_shares(token);
