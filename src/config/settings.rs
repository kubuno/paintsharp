use config::{Config, ConfigError, Environment, File};
use serde::Deserialize;
use std::time::Duration;

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

#[derive(Debug, Clone, Deserialize)]
pub struct DatabaseSettings {
    pub host:            String,
    pub port:            u16,
    pub user:            String,
    pub password:        String,
    pub database:        String,
    pub max_connections: u32,
    pub min_connections: u32,
    #[serde(with = "duration_secs")]
    pub connect_timeout: Duration,
    pub run_migrations:  bool,
}

impl DatabaseSettings {
    pub fn connect_options(&self) -> anyhow::Result<sqlx::postgres::PgConnectOptions> {
        Ok(sqlx::postgres::PgConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .username(&self.user)
            .password(&self.password)
            .database(&self.database))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PaintsharpSettings {
    pub max_scene_bytes: u64,
    pub max_asset_bytes: u64,
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
        // En production le core lance les modules avec CWD = /etc/kubuno/... (lecture
        // seule) mais fournit KUBUNO_DATA_DIR (= /var/lib/kubuno/modules/paintsharp, accessible
        // en écriture). Le défaut relatif « ./data/paintsharp-media » échouait donc en
        // « Permission denied » ; on le base sur KUBUNO_DATA_DIR quand il est présent.
        let default_media_path = std::env::var("KUBUNO_DATA_DIR")
            .map(|d| format!("{d}/media"))
            .unwrap_or_else(|_| "./data/paintsharp-media".to_string());

        let mut builder = Config::builder()
            .set_default("server.host", "127.0.0.1")?
            .set_default("server.port", 3106i64)?
            .set_default("core.url", "http://127.0.0.1:8080")?
            .set_default("core.internal_secret", "")?
            .set_default("core.files_url", "http://127.0.0.1:3101")?
            .set_default("database.host", "localhost")?
            .set_default("database.port", 5432i64)?
            .set_default("database.user", "kubuno")?
            .set_default("database.password", "")?
            .set_default("database.database", "kubuno")?
            .set_default("database.max_connections", 10i64)?
            .set_default("database.min_connections", 1i64)?
            .set_default("database.connect_timeout", 10i64)?
            .set_default("database.run_migrations", true)?
            .set_default("paintsharp.max_scene_bytes", 52_428_800i64)?
            .set_default("paintsharp.max_asset_bytes", 104_857_600i64)?
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

        if let Ok(v) = std::env::var("KUBUNO_CORE_URL")        { builder = builder.set_override("core.url",             v)?; }
        if let Ok(v) = std::env::var("KUBUNO_INTERNAL_SECRET") { builder = builder.set_override("core.internal_secret", v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_HOST")         { builder = builder.set_override("database.host",     v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_PORT")         { builder = builder.set_override("database.port",     v.parse::<i64>().unwrap_or(5432))?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_USER")         { builder = builder.set_override("database.user",     v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_PASSWORD")     { builder = builder.set_override("database.password", v)?; }
        if let Ok(v) = std::env::var("KUBUNO_DB_NAME")         { builder = builder.set_override("database.database", v)?; }

        builder.build()?.try_deserialize()
    }
}

mod duration_secs {
    use serde::{Deserialize, Deserializer};
    use std::time::Duration;
    pub fn deserialize<'de, D>(d: D) -> Result<Duration, D::Error>
    where D: Deserializer<'de> {
        let secs = u64::deserialize(d)?;
        Ok(Duration::from_secs(secs))
    }
}
