use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::storage::{KvBackend, Space, StorageError};

const APP_KEY: &[u8] = b"settings/app";
const RECORD_VERSION: u8 = 1;

/// The theme the user chose, or the system's light or dark appearance.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize, TS)]
pub enum ThemePreference {
    /// Lounge in light appearance, Lounge Night in dark appearance.
    #[default]
    #[serde(rename = "system")]
    #[ts(rename = "system")]
    System,
    /// The Lounge theme.
    #[serde(rename = "lounge")]
    #[ts(rename = "lounge")]
    Lounge,
    /// The Lounge Night theme.
    #[serde(rename = "lounge-night")]
    #[ts(rename = "lounge-night")]
    LoungeNight,
    /// The pure black theme for OLED screens.
    #[serde(rename = "black")]
    #[ts(rename = "black")]
    Black,
    /// The Modern theme.
    #[serde(rename = "modern")]
    #[ts(rename = "modern")]
    Modern,
    /// The Terminal theme.
    #[serde(rename = "terminal")]
    #[ts(rename = "terminal")]
    Terminal,
    /// The Retro theme.
    #[serde(rename = "retro")]
    #[ts(rename = "retro")]
    Retro,
    /// The Monokai theme.
    #[serde(rename = "monokai")]
    #[ts(rename = "monokai")]
    Monokai,
    /// The Earthsong theme.
    #[serde(rename = "earthsong")]
    #[ts(rename = "earthsong")]
    Earthsong,
    /// The n.e. theme, after neutral.engineering.
    #[serde(rename = "ne")]
    #[ts(rename = "ne")]
    NeutralEngineering,
}

/// Spacing, text size and avatar size of a list.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Density {
    /// Tightest spacing.
    Compact,
    /// Default spacing.
    #[default]
    Cozy,
    /// Loosest spacing.
    Comfortable,
}

/// Settings that apply to the whole app on this device.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct AppSettings {
    /// Theme preference.
    pub theme: ThemePreference,
    /// Conversation message density.
    pub message_density: Density,
    /// Whether a browser tab shows unread messages in its icon and title.
    pub unread_tab_indicator: bool,
    /// Whether this device registers for push once notifications are permitted.
    pub push_on_this_device: bool,
    /// Whether the open page shows notifications where this device can't push.
    pub page_notifications: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::default(),
            message_density: Density::default(),
            unread_tab_indicator: true,
            push_on_this_device: true,
            page_notifications: true,
        }
    }
}

/// One app-wide setting and its new value.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "key", content = "value", rename_all = "snake_case")]
pub enum AppSetting {
    /// Theme preference.
    Theme(ThemePreference),
    /// Conversation message density.
    MessageDensity(Density),
    /// Whether a browser tab shows unread messages in its icon and title.
    UnreadTabIndicator(bool),
    /// Whether this device registers for push once notifications are permitted.
    PushOnThisDevice(bool),
    /// Whether the open page shows notifications where this device can't push.
    PageNotifications(bool),
}

/// One requested settings change, addressed by scope.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "scope", content = "setting", rename_all = "snake_case")]
pub enum SettingChange {
    /// An app-wide setting.
    App(AppSetting),
}

/// Every resolved setting the UI renders.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize, TS)]
pub struct Settings {
    /// App-wide settings.
    pub app: AppSettings,
}

/// Settings read from storage, with the stored fields that failed validation.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct LoadedSettings {
    pub(crate) settings: Settings,
    pub(crate) invalid_fields: Vec<String>,
}

impl AppSettings {
    fn entries(self) -> [AppSetting; 5] {
        let Self {
            theme,
            message_density,
            unread_tab_indicator,
            push_on_this_device,
            page_notifications,
        } = self;
        [
            AppSetting::Theme(theme),
            AppSetting::MessageDensity(message_density),
            AppSetting::UnreadTabIndicator(unread_tab_indicator),
            AppSetting::PushOnThisDevice(push_on_this_device),
            AppSetting::PageNotifications(page_notifications),
        ]
    }

    fn apply(&mut self, setting: AppSetting) {
        match setting {
            AppSetting::Theme(theme) => self.theme = theme,
            AppSetting::MessageDensity(density) => self.message_density = density,
            AppSetting::UnreadTabIndicator(shown) => self.unread_tab_indicator = shown,
            AppSetting::PushOnThisDevice(on) => self.push_on_this_device = on,
            AppSetting::PageNotifications(on) => self.page_notifications = on,
        }
    }
}

impl AppSetting {
    const fn key(self) -> &'static str {
        match self {
            Self::Theme(_) => "theme",
            Self::MessageDensity(_) => "message_density",
            Self::UnreadTabIndicator(_) => "unread_tab_indicator",
            Self::PushOnThisDevice(_) => "push_on_this_device",
            Self::PageNotifications(_) => "page_notifications",
        }
    }

    fn value(self) -> Result<Value, serde_json::Error> {
        match self {
            Self::Theme(theme) => serde_json::to_value(theme),
            Self::MessageDensity(density) => serde_json::to_value(density),
            Self::UnreadTabIndicator(on)
            | Self::PushOnThisDevice(on)
            | Self::PageNotifications(on) => serde_json::to_value(on),
        }
    }

    fn from_field(key: &str, value: &Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(serde_json::json!({ "key": key, "value": value }))
    }
}

#[derive(Deserialize, Serialize)]
struct Record {
    version: u8,
    fields: Map<String, Value>,
}

pub(crate) async fn load<B: KvBackend>(backend: &B) -> Result<LoadedSettings, StorageError> {
    let record = backend.get(Space::Settings, APP_KEY).await?;
    Ok(resolve(&decode(record.as_deref())?))
}

pub(crate) async fn change<B: KvBackend>(
    backend: &B,
    change: SettingChange,
) -> Result<Settings, StorageError> {
    let SettingChange::App(setting) = change;
    let value = setting.value().map_err(encoding)?;
    let mut changed = None;
    backend
        .update(Space::Settings, APP_KEY, |stored| {
            let mut record = decode(stored.as_deref())?;
            record.fields.insert(setting.key().to_owned(), value);
            changed = Some(resolve(&record).settings);
            serde_json::to_vec(&record).map(Some).map_err(encoding)
        })
        .await?;
    changed.ok_or_else(|| StorageError::Encoding("settings update did not run".into()))
}

fn decode(stored: Option<&[u8]>) -> Result<Record, StorageError> {
    let Some(stored) = stored else {
        return Ok(Record {
            version: RECORD_VERSION,
            fields: Map::new(),
        });
    };
    let record: Record = serde_json::from_slice(stored).map_err(encoding)?;
    if record.version != RECORD_VERSION {
        return Err(StorageError::Encoding(
            "unsupported app settings version".into(),
        ));
    }
    Ok(record)
}

fn resolve(record: &Record) -> LoadedSettings {
    let mut app = AppSettings::default();
    let mut invalid_fields = Vec::new();
    for key in AppSettings::default().entries().map(AppSetting::key) {
        let Some(value) = record.fields.get(key) else {
            continue;
        };
        match AppSetting::from_field(key, value) {
            Ok(setting) => app.apply(setting),
            Err(_) => invalid_fields.push(key.to_owned()),
        }
    }
    LoadedSettings {
        settings: Settings { app },
        invalid_fields,
    }
}

fn encoding(error: impl std::fmt::Display) -> StorageError {
    StorageError::Encoding(error.to_string())
}

#[cfg(test)]
mod tests {
    use crate::storage::{KvBackend, MemoryKv, Operation, Space};

    use super::{
        APP_KEY, AppSetting, AppSettings, Density, LoadedSettings, SettingChange, Settings,
        ThemePreference, change, load,
    };

    async fn seed(storage: &MemoryKv, record: &str) {
        storage
            .commit(
                Space::Settings,
                vec![Operation::Put {
                    key: APP_KEY.to_vec(),
                    value: record.as_bytes().to_vec(),
                }],
            )
            .await
            .expect("seed settings");
    }

    fn stored(settings: AppSettings) -> LoadedSettings {
        LoadedSettings {
            settings: Settings { app: settings },
            invalid_fields: Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_new_device_follows_the_system_theme_at_cozy_density() {
        let storage = MemoryKv::default();

        let loaded = load(&storage).await.expect("load defaults");

        assert_eq!(
            loaded,
            stored(AppSettings {
                theme: ThemePreference::System,
                message_density: Density::Cozy,
                unread_tab_indicator: true,
                push_on_this_device: true,
                page_notifications: true,
            })
        );
    }

    #[tokio::test]
    async fn changes_persist_in_device_settings_and_keep_other_fields() {
        let storage = MemoryKv::default();

        change(
            &storage,
            SettingChange::App(AppSetting::Theme(ThemePreference::LoungeNight)),
        )
        .await
        .expect("change theme");
        let changed = change(
            &storage,
            SettingChange::App(AppSetting::MessageDensity(Density::Compact)),
        )
        .await
        .expect("change density");

        let expected = AppSettings {
            theme: ThemePreference::LoungeNight,
            message_density: Density::Compact,
            unread_tab_indicator: true,
            push_on_this_device: true,
            page_notifications: true,
        };
        assert_eq!(changed, Settings { app: expected });
        assert_eq!(load(&storage).await.expect("reload"), stored(expected));
        assert!(
            storage
                .get(Space::Durable, APP_KEY)
                .await
                .expect("read durable")
                .is_none()
        );
    }

    type Switch = (
        fn(bool) -> AppSetting,
        fn(&AppSettings) -> bool,
        &'static str,
    );

    const SWITCHES: [Switch; 3] = [
        (
            AppSetting::UnreadTabIndicator,
            |app| app.unread_tab_indicator,
            "unread_tab_indicator",
        ),
        (
            AppSetting::PushOnThisDevice,
            |app| app.push_on_this_device,
            "push_on_this_device",
        ),
        (
            AppSetting::PageNotifications,
            |app| app.page_notifications,
            "page_notifications",
        ),
    ];

    #[tokio::test]
    async fn turning_off_a_switch_persists_and_leaves_the_others_on() {
        for (setting, read, key) in SWITCHES {
            let storage = MemoryKv::default();

            change(&storage, SettingChange::App(setting(false)))
                .await
                .expect("change switch");

            let app = load(&storage).await.expect("reload").settings.app;
            assert!(!read(&app));
            for (_, other, other_key) in SWITCHES {
                if other_key != key {
                    assert!(other(&app), "{other_key} stays on when {key} turns off");
                }
            }
            assert_eq!(app.theme, ThemePreference::System);
        }
    }

    #[tokio::test]
    async fn a_record_saved_before_the_switches_existed_loads_them_on() {
        let storage = MemoryKv::default();
        seed(
            &storage,
            r#"{"version":1,"fields":{"theme":"lounge-night","message_density":"compact"}}"#,
        )
        .await;

        let loaded = load(&storage).await.expect("load");

        assert_eq!(
            loaded,
            stored(AppSettings {
                theme: ThemePreference::LoungeNight,
                message_density: Density::Compact,
                unread_tab_indicator: true,
                push_on_this_device: true,
                page_notifications: true,
            })
        );
    }

    #[tokio::test]
    async fn a_non_boolean_switch_falls_back_to_on() {
        for (_, read, key) in SWITCHES {
            let storage = MemoryKv::default();
            seed(
                &storage,
                &format!(r#"{{"version":1,"fields":{{"{key}":"no"}}}}"#),
            )
            .await;

            let loaded = load(&storage).await.expect("load");

            assert!(read(&loaded.settings.app));
            assert_eq!(loaded.invalid_fields, vec![key.to_owned()]);
        }
    }

    #[tokio::test]
    async fn an_invalid_field_falls_back_alone_and_is_reported() {
        let storage = MemoryKv::default();
        seed(
            &storage,
            r#"{"version":1,"fields":{"theme":"neon","message_density":"comfortable"}}"#,
        )
        .await;

        let loaded = load(&storage).await.expect("load");

        assert_eq!(
            loaded.settings.app,
            AppSettings {
                theme: ThemePreference::System,
                message_density: Density::Comfortable,
                unread_tab_indicator: true,
                push_on_this_device: true,
                page_notifications: true,
            }
        );
        assert_eq!(loaded.invalid_fields, vec!["theme".to_owned()]);
    }

    #[tokio::test]
    async fn every_theme_round_trips_under_its_wire_name() {
        for (theme, wire) in [
            (ThemePreference::System, "system"),
            (ThemePreference::Lounge, "lounge"),
            (ThemePreference::LoungeNight, "lounge-night"),
            (ThemePreference::Black, "black"),
            (ThemePreference::Modern, "modern"),
            (ThemePreference::Terminal, "terminal"),
            (ThemePreference::Retro, "retro"),
            (ThemePreference::Monokai, "monokai"),
            (ThemePreference::Earthsong, "earthsong"),
            (ThemePreference::NeutralEngineering, "ne"),
        ] {
            let storage = MemoryKv::default();

            change(&storage, SettingChange::App(AppSetting::Theme(theme)))
                .await
                .expect("change theme");

            assert_eq!(
                load(&storage).await.expect("reload").settings.app.theme,
                theme
            );
            let raw = storage
                .get(Space::Settings, APP_KEY)
                .await
                .expect("read record")
                .expect("record exists");
            let record: serde_json::Value = serde_json::from_slice(&raw).expect("record json");
            assert_eq!(record["fields"]["theme"], serde_json::json!(wire));
        }
    }

    #[tokio::test]
    async fn an_unknown_theme_is_reported_and_survives_another_change() {
        let storage = MemoryKv::default();
        seed(
            &storage,
            r#"{"version":1,"fields":{"theme":"solarized","message_density":"cozy"}}"#,
        )
        .await;

        let loaded = load(&storage).await.expect("load");
        change(
            &storage,
            SettingChange::App(AppSetting::MessageDensity(Density::Compact)),
        )
        .await
        .expect("change density");

        assert_eq!(loaded.settings.app.theme, ThemePreference::System);
        assert_eq!(loaded.invalid_fields, vec!["theme".to_owned()]);
        let raw = storage
            .get(Space::Settings, APP_KEY)
            .await
            .expect("read record")
            .expect("record exists");
        let record: serde_json::Value = serde_json::from_slice(&raw).expect("record json");
        assert_eq!(record["fields"]["theme"], serde_json::json!("solarized"));
    }

    #[tokio::test]
    async fn unknown_fields_are_ignored_and_survive_a_change() {
        let storage = MemoryKv::default();
        seed(
            &storage,
            r#"{"version":1,"fields":{"avatars":false,"theme":"lounge"}}"#,
        )
        .await;

        let loaded = load(&storage).await.expect("load");
        change(
            &storage,
            SettingChange::App(AppSetting::MessageDensity(Density::Comfortable)),
        )
        .await
        .expect("change density");

        assert!(loaded.invalid_fields.is_empty());
        assert_eq!(loaded.settings.app.theme, ThemePreference::Lounge);
        let raw = storage
            .get(Space::Settings, APP_KEY)
            .await
            .expect("read record")
            .expect("record exists");
        let record: serde_json::Value = serde_json::from_slice(&raw).expect("record json");
        assert_eq!(record["fields"]["avatars"], serde_json::json!(false));
        assert_eq!(record["fields"]["theme"], serde_json::json!("lounge"));
    }

    #[tokio::test]
    async fn rejects_unknown_record_versions_without_overwriting_them() {
        let storage = MemoryKv::default();
        let newer = r#"{"version":2,"fields":{"theme":"lounge"}}"#;
        seed(&storage, newer).await;

        assert!(load(&storage).await.is_err());
        assert!(
            change(
                &storage,
                SettingChange::App(AppSetting::Theme(ThemePreference::Lounge)),
            )
            .await
            .is_err()
        );
        let raw = storage
            .get(Space::Settings, APP_KEY)
            .await
            .expect("read record")
            .expect("record exists");
        assert_eq!(raw, newer.as_bytes());
    }

    #[test]
    fn stored_keys_match_the_wire_keys() {
        for setting in AppSettings::default().entries() {
            let wire = serde_json::to_value(setting).expect("encode setting");
            assert_eq!(wire["key"], serde_json::json!(setting.key()));
            assert_eq!(wire["value"], setting.value().expect("encode value"));
        }
    }

    #[tokio::test]
    async fn an_unreadable_record_is_reported_and_never_overwritten() {
        let storage = MemoryKv::default();
        seed(&storage, "{not json").await;

        assert!(load(&storage).await.is_err());
        assert!(
            change(
                &storage,
                SettingChange::App(AppSetting::Theme(ThemePreference::Lounge)),
            )
            .await
            .is_err()
        );
        let raw = storage
            .get(Space::Settings, APP_KEY)
            .await
            .expect("read record")
            .expect("record exists");
        assert_eq!(raw, b"{not json");
    }

    #[test]
    fn changes_use_the_documented_wire_shape() {
        let change = SettingChange::App(AppSetting::Theme(ThemePreference::LoungeNight));

        assert_eq!(
            serde_json::to_value(change).expect("encode change"),
            serde_json::json!({
                "scope": "app",
                "setting": { "key": "theme", "value": "lounge-night" },
            })
        );
    }
}
