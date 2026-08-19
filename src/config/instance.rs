//! Instance-wide settings of the paintsharp module, as the administrator left
//! them in the console.
//!
//! Declared by `module.toml`'s `[[settings]]` blocks, stored in `core.settings`,
//! and read back here through `/internal/modules/paintsharp/settings` — a module
//! owns its own schema and cannot read the core's tables, and a background
//! refresher has no user token for the public config route. The module is named
//! in the URL (not derived from the secret) so the read works whether the
//! instance shares one master secret between modules or issues a derived one per
//! module.
//!
//! Every field here is read by code that acts on it — a knob that changes
//! nothing is worse than an absent one:
//!   * `max_document_bytes`   → `services::content_files` (single write path of
//!                              every editor: Vertex, Apex, Layer, Motion,
//!                              Keyframe, PdfWriter, FontEditor);
//!   * `enable_collaboration` → the six `handlers::collab_*` WebSocket handlers;
//!   * `max_media_bytes`      → `handlers::video` (both media import paths).
//!
//! `max_media_bytes` was already applied from `config.toml`; promoting it to the
//! console follows the same resolution rule as maps: the instance value wins
//! only when the admin moved it off the compiled default, otherwise
//! `config.toml` keeps deciding, so an install configured the old way keeps
//! working unchanged until an admin edits it.
//!
//! Sizes are exposed and stored in BYTES (not MiB): the enforcement points
//! compare a byte count directly, so keeping the unit identical avoids a hidden
//! conversion.

use serde_json::Value;

/// Compiled default ceiling on a saved document, in bytes (50 MiB).
const DEFAULT_MAX_DOCUMENT_BYTES: u64 = 52_428_800;
/// Compiled default ceiling on an imported media file, in bytes (5 GiB).
/// Kept identical to `config/settings.rs` so an untouched setting resolves back
/// to exactly what the module shipped with.
const DEFAULT_MAX_MEDIA_BYTES: u64 = 5_368_709_120;

#[derive(Debug, Clone)]
pub struct InstanceConfig {
    /// Ceiling, in BYTES, on the gzipped content of a single saved document.
    pub max_document_bytes: u64,
    /// Whether real-time collaborative editing is served at all.
    pub enable_collaboration: bool,
    /// Ceiling, in BYTES, on a media file imported into a Motion project.
    pub max_media_bytes: u64,
}

impl Default for InstanceConfig {
    fn default() -> Self {
        Self {
            max_document_bytes:   DEFAULT_MAX_DOCUMENT_BYTES,
            enable_collaboration: true,
            max_media_bytes:      DEFAULT_MAX_MEDIA_BYTES,
        }
    }
}

impl InstanceConfig {
    /// Maps the core's `{key: value}` object onto the struct. Every read falls
    /// back to the compiled default rather than to a permissive value: a payload
    /// missing a key (an older core, a cleared field) must not silently change a
    /// default, and an out-of-range number is treated as a mistake the same way.
    pub fn from_settings(settings: &Value) -> Self {
        let d = Self::default();

        // An integer in a range. The console stores an `int` as a JSON number,
        // but a value echoed from a text field can arrive as a string — accept
        // both, then range-check.
        let uint_in = |key: &str, min: u64, max: u64, fallback: u64| -> u64 {
            let v = settings.get(key);
            v.and_then(Value::as_u64)
                .or_else(|| v.and_then(Value::as_str).and_then(|s| s.trim().parse::<u64>().ok()))
                .filter(|n| (min..=max).contains(n))
                .unwrap_or(fallback)
        };
        let flag = |key: &str, fallback: bool| -> bool {
            let v = settings.get(key);
            v.and_then(Value::as_bool)
                .or_else(|| match v.and_then(Value::as_str).map(str::trim) {
                    Some("true")  => Some(true),
                    Some("false") => Some(false),
                    _             => None,
                })
                .unwrap_or(fallback)
        };

        Self {
            // Bounds mirror the `min`/`max` declared in module.toml.
            max_document_bytes:   uint_in("max_document_bytes", 1_048_576, 2_147_483_648, d.max_document_bytes),
            enable_collaboration: flag("enable_collaboration", d.enable_collaboration),
            max_media_bytes:      uint_in("max_media_bytes", 1_048_576, 107_374_182_400, d.max_media_bytes),
        }
    }

    /// Media ceiling to enforce, given the value `config.toml` carries.
    ///
    /// The instance value wins only when the admin moved it off the compiled
    /// default; left untouched, the static configuration keeps deciding.
    pub fn max_media_bytes_or(&self, from_config: u64) -> u64 {
        if self.max_media_bytes == DEFAULT_MAX_MEDIA_BYTES {
            from_config
        } else {
            self.max_media_bytes
        }
    }
}

/// Reads the instance settings from the core. Any failure yields `None`, so the
/// caller keeps the values it already had rather than reverting to defaults
/// because the core was briefly unreachable.
pub async fn fetch(http: &reqwest::Client, core_url: &str, secret: &str) -> Option<InstanceConfig> {
    let url = format!("{core_url}/internal/modules/paintsharp/settings");
    let resp = http
        .get(&url)
        .header("X-Internal-Secret", secret)
        .send()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Lecture des réglages d'instance paintsharp"))
        .ok()?;

    if !resp.status().is_success() {
        tracing::warn!(status = %resp.status(), "Réglages d'instance paintsharp refusés par le core");
        return None;
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| tracing::warn!(error = %e, "Réglages d'instance paintsharp : réponse illisible"))
        .ok()?;

    Some(InstanceConfig::from_settings(body.get("settings")?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_keys_keep_the_compiled_defaults() {
        let c = InstanceConfig::from_settings(&json!({}));
        assert_eq!(c.max_document_bytes, DEFAULT_MAX_DOCUMENT_BYTES);
        assert!(c.enable_collaboration);
        assert_eq!(c.max_media_bytes, DEFAULT_MAX_MEDIA_BYTES);
    }

    #[test]
    fn values_are_read() {
        let c = InstanceConfig::from_settings(&json!({
            "max_document_bytes":   104_857_600,
            "enable_collaboration": false,
            "max_media_bytes":      1_073_741_824,
        }));
        assert_eq!(c.max_document_bytes, 104_857_600);
        assert!(!c.enable_collaboration);
        assert_eq!(c.max_media_bytes, 1_073_741_824);
    }

    #[test]
    fn text_encoded_values_are_accepted() {
        let c = InstanceConfig::from_settings(&json!({
            "max_document_bytes":   "104857600",
            "enable_collaboration": "false",
        }));
        assert_eq!(c.max_document_bytes, 104_857_600);
        assert!(!c.enable_collaboration);
    }

    #[test]
    fn out_of_range_sizes_fall_back() {
        for bad in [json!(0), json!(-5), json!(9_999_999_999_999i64)] {
            let c = InstanceConfig::from_settings(&json!({ "max_document_bytes": bad }));
            assert_eq!(c.max_document_bytes, DEFAULT_MAX_DOCUMENT_BYTES);
        }
    }

    #[test]
    fn media_ceiling_defers_to_config_until_the_admin_moves_it() {
        // Untouched → the config.toml value decides.
        let untouched = InstanceConfig::from_settings(&json!({}));
        assert_eq!(untouched.max_media_bytes_or(2_147_483_648), 2_147_483_648);
        // Moved off the default → the console decides.
        let edited = InstanceConfig::from_settings(&json!({ "max_media_bytes": 1_073_741_824 }));
        assert_eq!(edited.max_media_bytes_or(2_147_483_648), 1_073_741_824);
    }
}
