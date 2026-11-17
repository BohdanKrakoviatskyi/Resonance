use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    SoundCloud,
    #[serde(alias = "ytmusic")]
    YouTube,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LyricLine {
    pub t: f64,
    pub text: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub gap: bool,
}

fn is_false(v: &bool) -> bool {
    !*v
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    #[serde(default)]
    pub src: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback: Option<String>,
    pub source: Source,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<Vec<LyricLine>>,
}

impl Track {
    pub fn is_youtube(&self) -> bool {
        self.source == Source::YouTube || self.id.starts_with("yt:")
    }

    pub fn yt_video_id(&self) -> Option<&str> {
        if let Some(id) = self.native_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
            && self.is_youtube() {
                return Some(id);
            }
        self.id.strip_prefix("yt:").map(str::trim).filter(|s| !s.is_empty())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaylistSection {
    #[default]
    Local,
    Youtube,
    Soundcloud,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub created: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<PlaylistSection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundCloudPlaylist {
    pub id: String,
    pub urn: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permalink_url: Option<String>,
    #[serde(default)]
    pub track_count: i64,
    #[serde(default)]
    pub username: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtMusicPlaylist {
    pub playlist_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    #[serde(default)]
    pub track_count: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    #[default]
    Off,
    All,
    One,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackStatus {
    #[default]
    Idle,
    Loading,
    Playing,
    Paused,
    Error,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NormalizationTarget {
    Quiet,
    #[default]
    Normal,
    Loud,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CrossfadeCurve {
    Linear,
    #[default]
    EqualPower,
    SCurve,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EqPreset {
    #[default]
    Flat,
    BassBoost,
    Vocal,
    Rock,
    Electronic,
    Custom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeModePref {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlassMode {
    Liquid,
    #[default]
    Frosted,
    Off,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BgMode {
    Dynamic,
    #[default]
    Color,
    Image,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BgStyle {
    #[default]
    Palette,
    Artwork,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccentMode {
    Dynamic,
    #[default]
    Custom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorVariant {
    Vibrant,
    Tonal,
    Expressive,
    Fidelity,
    Rainbow,
    Fruit,
    #[default]
    Neutral,
    Mono,
}

impl ColorVariant {
    pub const ALL: [Self; 8] = [
        Self::Vibrant,
        Self::Tonal,
        Self::Expressive,
        Self::Fidelity,
        Self::Rainbow,
        Self::Fruit,
        Self::Neutral,
        Self::Mono,
    ];
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MotionMode {
    #[default]
    Expressive,
    Standard,
    Reduced,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    #[default]
    Ru,
    En,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub theme: ThemeModePref,
    pub glass: GlassMode,
    pub blur: f32,
    pub opacity: f32,
    pub refraction: f32,
    pub bg_mode: BgMode,
    pub bg_style: BgStyle,
    pub bg_color: String,
    #[serde(skip)]
    pub bg_image: Option<String>,
    pub bg_dim: f32,
    pub bg_blur: f32,
    pub accent_mode: AccentMode,
    pub accent_color: String,
    pub variant: ColorVariant,
    pub metallic: bool,
    pub metallic_neon: bool,
    pub metallic_neon_intensity: f32,
    pub motion: MotionMode,
    pub lang: Lang,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: ThemeModePref::Dark,
            glass: GlassMode::Frosted,
            blur: 45.0,
            opacity: 34.0,
            refraction: 45.0,
            bg_mode: BgMode::Color,
            bg_style: BgStyle::Palette,
            bg_color: "#000000".to_string(),
            bg_image: None,
            bg_dim: 30.0,
            bg_blur: 0.0,
            accent_mode: AccentMode::Custom,
            accent_color: "#a0a8b8".to_string(),
            variant: ColorVariant::Neutral,
            metallic: false,
            metallic_neon: true,
            metallic_neon_intensity: 45.0,
            motion: MotionMode::Expressive,
            lang: Lang::Ru,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FavProvider {
    #[default]
    All,
    Soundcloud,
    Youtube,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NowPlayingTab {
    #[default]
    Lyrics,
    Queue,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Route {
    Home,
    Favorites,
    Playlist(String),
    Settings,
    Appearance,
    Providers,
    Shortcuts,
    Audio,
}

impl Route {
    pub fn key(&self) -> String {
        match self {
            Route::Home => "home".to_string(),
            Route::Favorites => "favorites".to_string(),
            Route::Playlist(id) => format!("pl:{id}"),
            Route::Settings => "settings".to_string(),
            Route::Appearance => "appearance".to_string(),
            Route::Providers => "providers".to_string(),
            Route::Shortcuts => "shortcuts".to_string(),
            Route::Audio => "audio".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CreateInitialTab {
    Scratch,
    Import,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DialogKind {
    Create {
        track_id: Option<String>,
        initial_tab: CreateInitialTab,
    },
    Rename {
        id: String,
    },
    Delete {
        id: String,
    },
    ImportReview,
    Update,
    UpdateUninstall,
    Uninstall,
    ClearCache,
}

pub fn fmt_time(mut sec: f64) -> String {
    if !sec.is_finite() || sec < 0.0 {
        sec = 0.0;
    }
    let total = sec.floor() as u64;
    let m = total / 60;
    let r = total % 60;
    format!("{m}:{r:02}")
}
