-- ── Video projects (Motion sub-module) ───────────────────────────────────────

CREATE TABLE paintsharp.video_projects (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id        UUID NOT NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Projet vidéo sans titre',
    composition     JSONB NOT NULL DEFAULT '{"width":1920,"height":1080,"fps":25,"duration_frames":750,"sample_rate":48000,"channels":2,"color_space":"rec709"}',
    timeline_data   JSONB NOT NULL DEFAULT '{"tracks":[],"markers":[]}',
    render_settings JSONB NOT NULL DEFAULT '{"codec":"h264","preset":"medium","crf":23,"audio_codec":"aac","audio_bitrate":"192k","container":"mp4"}',
    is_trashed      BOOLEAN NOT NULL DEFAULT FALSE,
    trashed_at      TIMESTAMPTZ,
    thumbnail_path  TEXT,
    thumbnail_dirty BOOLEAN NOT NULL DEFAULT TRUE,
    last_edited_by  UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_vidp_owner   ON paintsharp.video_projects(owner_id);
CREATE INDEX idx_paintsharp_vidp_trashed ON paintsharp.video_projects(is_trashed);

CREATE TRIGGER video_projects_updated_at
    BEFORE UPDATE ON paintsharp.video_projects
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();

-- ── Media assets attached to a video project ─────────────────────────────────

CREATE TABLE paintsharp.video_media (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES paintsharp.video_projects(id) ON DELETE CASCADE,
    owner_id        UUID NOT NULL,
    storage_path    TEXT NOT NULL,
    original_name   VARCHAR(500) NOT NULL,
    mime_type       VARCHAR(100) NOT NULL,
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    probe_data      JSONB NOT NULL DEFAULT '{}',
    thumbnails_path TEXT,
    waveform_path   TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'ready', 'error')),
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_vidm_project ON paintsharp.video_media(project_id);
CREATE INDEX idx_paintsharp_vidm_owner   ON paintsharp.video_media(owner_id);

-- ── Render jobs ───────────────────────────────────────────────────────────────

CREATE TABLE paintsharp.render_jobs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES paintsharp.video_projects(id) ON DELETE CASCADE,
    owner_id        UUID NOT NULL,
    render_options  JSONB NOT NULL DEFAULT '{}',
    output_path     TEXT,
    output_url      TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    progress        SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    frame_current   INTEGER NOT NULL DEFAULT 0,
    frame_total     INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_rj_project ON paintsharp.render_jobs(project_id);
CREATE INDEX idx_paintsharp_rj_status  ON paintsharp.render_jobs(status) WHERE status IN ('queued', 'running');

-- ── Collaboration shares ──────────────────────────────────────────────────────

CREATE TABLE paintsharp.video_shares (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES paintsharp.video_projects(id) ON DELETE CASCADE,
    owner_id    UUID NOT NULL,
    token       VARCHAR(64) UNIQUE NOT NULL
                    DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
    permission  VARCHAR(20) NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'edit')),
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_vids_project ON paintsharp.video_shares(project_id);
CREATE INDEX idx_paintsharp_vids_token   ON paintsharp.video_shares(token);
