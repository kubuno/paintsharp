use config::{Config, ConfigError, Environment, File};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Settings {
    pub server:   ServerSettings,
    pub core:     CoreSettings,
    pub database: DatabaseSettings,
    pub paintsharp:    PaintsharpSettings,
    pub logging:  LoggingSettings,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerSettings {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CoreSettings {
    pub url:             String,
    pub internal_secret: String,
    pub files_url:       String,
}

/// The `[database]` section is owned by kubuno-db: which of its fields matter
/// depends on the engine the administrator selected (`database.engine`), and the
/// pool is opened by `kubuno_db::connect`.
pub use kubuno_db::DbSettings as DatabaseSettings;

#[derive(Debug, Clone, Deserialize)]
pub struct PaintsharpSettings {
    /// Ceiling on a media file imported into a Motion project. The admin
    /// console can override it (see `config::instance`); this stays the value
    /// used until an administrator moves the setting off its factory default.
    pub max_media_bytes: u64,
    pub media_path:      String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingSettings {
    pub level:  String,
    pub format: LogFormat,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    Pretty,
    Json,
}

impl Settings {
    pub fn load() -> Result<Self, ConfigError> {
        // In production the core launches modules with CWD = /etc/kubuno/...
        // (read-only) but provides KUBUNO_DATA_DIR (= /var/lib/kubuno/modules/paintsharp,
        // writable). The relative default "./data/paintsharp-media" would fail with
        // "Permission denied", so it is based on KUBUNO_DATA_DIR when present.
        let default_media_path = std::env::var("KUBUNO_DATA_DIR")
            .map(|d| format!("{d}/media"))
            .unwrap_or_else(|_| "./data/paintsharp-media".to_string());

        let mut builder = Config::builder()
            .set_default("server.host", "127.0.0.1")?
            .set_default("server.port", 3106i64)?
            .set_default("core.url", "http://127.0.0.1:8080")?
            .set_default("core.internal_secret", "")?
            .set_default("core.files_url", "http://127.0.0.1:8080")?
            // The `[database]` section is deserialised into kubuno_db::DbSettings.
            // The discrete connection fields are supplied by the supervisor's
            // KUBUNO_DB_* variables (or a config file); only the engine-agnostic
            // knobs get defaults here.
            .set_default("database.engine", "postgres")?
            // SQLite only: the directory holding `<schema>.sqlite`.
            .set_default("database.path", "./data/db")?
            .set_default("database.max_connections", 10i64)?
            .set_default("database.min_connections", 1i64)?
            .set_default("database.connect_timeout", 10i64)?
            .set_default("database.run_migrations", true)?
            .set_default("paintsharp.max_media_bytes", 5_368_709_120i64)?
            .set_default("paintsharp.media_path", default_media_path)?
            .set_default("logging.level", "info")?
            .set_default("logging.format", "pretty")?
            .add_source(File::with_name("config").required(false))
            .add_source(File::with_name("/etc/kubuno/modules/paintsharp/config").required(false))
            .add_source(
                Environment::with_prefix("KF")
                    .separator("__")
                    .try_parsing(true),
            );

        if let Ok(v) = std::env::var("KUBUNO_CORE_URL") {
            // FilesClient reaches the drive THROUGH the core relay now, so
            // files_url must point at the core, not the drive port.
            builder = builder.set_override("core.url",       v.clone())?;
            builder = builder.set_override("core.files_url", v)?;
        }
        if let Ok(v) = std::env::var("KUBUNO_INTERNAL_SECRET") { builder = builder.set_override("core.internal_secret", v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_HOST")         { builder = builder.set_override("database.host",     v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_PORT")         { builder = builder.set_override("database.port",     v.parse::<i64>().unwrap_or(5432))?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_USER")         { builder = builder.set_override("database.user",     v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_PASSWORD")     { builder = builder.set_override("database.password", v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_NAME")         { builder = builder.set_override("database.database", v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_PATH")         { builder = builder.set_override("database.path",     v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_ENGINE")       { builder = builder.set_override("database.engine",   v)?; }

        builder.build()?.try_deserialize()
    }
}
