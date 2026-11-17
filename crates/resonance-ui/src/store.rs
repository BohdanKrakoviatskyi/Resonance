use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use futures::channel::oneshot;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState, hotkey::HotKey};
use gpui_kit::{
    App, AppContext, Context, Entity, Focusable, Window,
    base::{
        input::{InputEvent, InputState},
        slider::{SliderEvent, SliderState},
    },
};
use gpui_kit_material::theme;
use resonance_audio::AudioEngine;
use resonance_core::{
    auth_launcher::{launch_soundcloud_auth, launch_ytmusic_auth},
    backend::{Backend, types::{AuthStatus, Profile}},
    cleanup::purge_retired_spotify_storage,
    color_engine::{
        Palette, ResolvedTheme, extract_palette_from_image_bytes, hex_from_argb, resolve_theme,
    },
    crossfade_plan::{evaluate_auto_crossfade_trigger, plan_auto_crossfade},
    eq_curve::preset_gains,
    i18n::{self, Key, tf},
    macos_widget::{NowPlayingPayload, PAYLOAD_VERSION, widget_update_now_playing},
    matching::{
        ImportReviewReason, LyricsData, ManualLyricsChoice, SourceTrackInput, YtCandidate,
        classify_match_candidates, fetch_lrclib_lyrics, find_youtube_fallback_candidate_idx,
        lyrics_data_from_record, rank_recommendations, search_lyrics_manual,
        to_seconds, with_gaps, youtube_fallback_queries,
    },
    models::{
        AccentMode, Appearance, BgMode, CreateInitialTab, CrossfadeCurve, DialogKind, EqPreset,
        Lang, LyricLine, MotionMode, NormalizationTarget, NowPlayingTab, PlaybackStatus, Playlist,
        PlaylistSection, RepeatMode, Route, SoundCloudPlaylist, Source, ThemeModePref, Track,
        YtMusicPlaylist,
    },
    persistence::{
        AppPersistedState, LibraryPersisted, PlayerPersisted, UiPersisted, UpdaterPersisted,
        load_all_state, remove_bg_image_file, save_all_state, save_bg_image_bytes,
    },
    player_queue::{QueueStepResult, step_queue_index},
    playlist_import::{ExternalPlaylistTrackDto, fetch_external_playlist},
    shortcuts::{ShortcutBindings, ShortcutId, is_valid_shortcut, normalize_shortcut},
    updater::{UpdateState, check_for_updates, open_release_page, restart_app, uninstall_app},
    yt::{
        music_api::{search_yt_tracks, yt_radio_tracks, yt_search_suggestions},
        music_parse::{YtMusicPlaylistDto, YtMusicTrackDto, YtSearchTrackDto},
        proxy::{YtStreamProxy, resolve_yt_stream_url},
        store::{
            YtStore, yt_auth_logout, yt_auth_save, yt_auth_status, yt_clear_cache,
            yt_library_cached, yt_library_sync, yt_playlist_artwork, yt_playlist_tracks_cached,
            yt_playlist_tracks_sync,
        },
    },
};
use serde_json::Value;
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};

use crate::http_client::{fetch_image_bytes_cached, shared_reqwest, tokio_runtime};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportDialogMode {
    Link,
    ScLikes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportPhase {
    Fetching,
    Matching,
    Saving,
}

#[derive(Clone, Debug)]
pub struct ImportReviewItem {
    pub source: ExternalPlaylistTrackDto,
    pub reason: ImportReviewReason,
    pub score: i32,
    pub selected: Option<Track>,
    pub accepted: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ImportJobState {
    pub running: bool,
    pub phase: Option<ImportPhase>,
    pub done: usize,
    pub total: usize,
    pub error: Option<String>,
    pub review_title: String,
    pub review_items: Vec<ImportReviewItem>,
    pub review_alt_open_idx: Option<usize>,
    pub review_alt_results: Vec<Track>,
    pub review_alt_loading: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnackActionKind {
    UndoDislike,
    OpenPlaylist,
    OpenImportReview,
}

#[derive(Clone, Debug)]
pub struct SnackItem {
    pub id: u64,
    pub text: String,
    pub action_label: Option<String>,
    pub action_kind: Option<SnackActionKind>,
    pub payload_id: Option<String>,
    pub expires_at: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StepDirection {
    Next,
    Prev,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplashStage {
    Checking,
    Hidden,
}

pub struct AppStore {
    pub backend: Backend,
    pub yt_proxy: YtStreamProxy,
    pub yt_store: YtStore,
    pub audio: Arc<AudioEngine>,

    // Persisted domains
    pub library: LibraryPersisted,
    pub ui: UiPersisted,
    pub appearance: Appearance,
    pub player: PlayerPersisted,
    pub shortcuts: ShortcutBindings,
    pub manual_lyrics: HashMap<String, ManualLyricsChoice>,
    pub custom_bg_image_path: Option<PathBuf>,

    // Navigation & overlays
    pub route: Route,
    pub search_open: bool,
    pub search_q: String,
    pub mobile_nav_open: bool,
    pub mobile_np_open: bool,
    pub now_playing_tab: NowPlayingTab,
    pub immersive_open: bool,
    pub eq_open: bool,
    pub dialog: Option<DialogKind>,
    pub import_mode: ImportDialogMode,
    pub dialog_confirm_checked: bool,
    pub create_initial_tab: CreateInitialTab,

    // Context menus
    pub open_track_menu_id: Option<String>,

    // GPUI Input & Slider state entities
    pub search_input: Entity<InputState>,
    pub fav_filter_input: Entity<InputState>,
    pub playlist_filter_input: Entity<InputState>,
    pub dialog_name_input: Entity<InputState>,
    pub dialog_url_input: Entity<InputState>,
    pub dialog_custom_name_input: Entity<InputState>,
    pub lyrics_search_input: Entity<InputState>,
    pub import_alt_search_input: Entity<InputState>,
    pub sc_token_input: Entity<InputState>,
    pub hex_accent_input: Entity<InputState>,
    pub hex_bg_input: Entity<InputState>,

    #[allow(dead_code)]
    pub vol_slider: Entity<SliderState>,
    pub blur_slider: Entity<SliderState>,
    pub opacity_slider: Entity<SliderState>,
    pub refraction_slider: Entity<SliderState>,
    pub bg_dim_slider: Entity<SliderState>,
    pub bg_blur_slider: Entity<SliderState>,
    pub neon_slider: Entity<SliderState>,
    #[allow(dead_code)]
    pub crossfade_dur_slider: Entity<SliderState>,
    pub eq_sliders: [Entity<SliderState>; 5],

    // Live player runtime
    pub queue: Vec<String>,
    pub queue_index: isize,
    pub current_track_id: Option<String>,
    pub status: PlaybackStatus,
    pub position: f64,
    pub duration: f64,
    pub play_context: Option<String>,
    pub current_audio_gen: u64,
    pub handled_ended_gen: u64,
    pub preloaded_for_gen: u64,
    pub preparing_xfade_for_gen: u64,
    pub preloaded_next_id: Option<String>,
    pub preloaded_next_url: Option<String>,
    pub handled_xfade_gen: u64,
    pub spectrum_bars: [f32; 72],
    pub wave_phase: f32,
    pub wave_amp: f32,
    pub spin_deg: f32,
    pub mesh_phase: f32,
    pub bg_seek_dragging: bool,

    // Theme & dynamic palette
    pub resolved_theme: ResolvedTheme,
    pub system_dark: bool,
    pub theme_dirty: bool,
    pub theme_animating: bool,
    pub palette_cache: HashMap<String, Palette>,
    pub pending_palettes: HashSet<String>,

    // Search runtime
    pub search_loading: bool,
    pub search_sc_tracks: Vec<Track>,
    pub search_yt_tracks: Vec<Track>,
    pub search_suggestions: Vec<String>,
    pub search_error: Option<String>,
    pub search_seq: u64,

    // Providers runtime
    pub sc_authorized: bool,
    pub sc_profile: Option<Profile>,
    pub sc_logging_in: bool,
    pub sc_loading_lib: bool,
    pub sc_tracks_mine: Vec<Track>,
    pub yt_logging_in: bool,
    pub yt_loading_lib: bool,
    pub yt_active_playlist_loading: HashSet<String>,
    pub sc_active_playlist_loading: HashSet<String>,

    // Lyrics runtime
    pub lyrics_cache: HashMap<String, Option<LyricsData>>,
    pub lyrics_loading: HashSet<String>,
    pub lyrics_search_open: bool,
    pub lyrics_search_loading: bool,
    pub lyrics_search_results: Vec<ManualLyricsChoice>,

    // External import
    pub import_job: ImportJobState,
    pub preview_track_id: Option<String>,

    // Shortcuts runtime
    pub recording_shortcut: Option<ShortcutId>,
    pub shortcut_error: Option<String>,
    hotkey_manager: Option<GlobalHotKeyManager>,
    registered_mute_hotkey: Option<HotKey>,

    // Updates & splash
    pub update_state: UpdateState,
    pub splash_stage: SplashStage,

    // Snackbars
    pub snacks: VecDeque<SnackItem>,
    snack_seq: u64,

    // Async channel delivery for non-cx palette / progress tasks
    palette_tx: mpsc::Sender<(String, Option<Palette>)>,
    palette_rx: Mutex<mpsc::Receiver<(String, Option<Palette>)>>,
    import_prog_tx: mpsc::Sender<(ImportPhase, usize, usize)>,
    import_prog_rx: Mutex<mpsc::Receiver<(ImportPhase, usize, usize)>>,

    // OS Media controls & widget sync
    media_controls: Option<MediaControls>,
    media_event_rx: Option<Mutex<mpsc::Receiver<MediaControlEvent>>>,
    last_widget_sig: String,
    last_widget_pos: f64,
    last_widget_cover_url: String,

    // Persistence debounce
    save_dirty_at: Option<Instant>,
    pub last_tick: Instant,
}

impl AppStore {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let backend = Backend::new();
        let yt_proxy = YtStreamProxy::default();
        let yt_store = YtStore::default();
        let audio = Arc::new(AudioEngine::new(
            tokio_runtime().handle().clone(),
            shared_reqwest(),
        ));

        let system_dark = theme::system_dark(cx);
        let appearance = Appearance::default();
        let resolved_theme = resolve_theme(&appearance, true, None, None, None, None, None);

        let search_input =
            cx.new(|cx| InputState::new(window, cx).placeholder(i18n::t(Lang::Ru, Key::SearchPlaceholder)));
        let fav_filter_input = cx.new(|cx| InputState::new(window, cx));
        let playlist_filter_input = cx.new(|cx| InputState::new(window, cx));
        let dialog_name_input = cx.new(|cx| InputState::new(window, cx));
        let dialog_url_input = cx.new(|cx| InputState::new(window, cx));
        let dialog_custom_name_input = cx.new(|cx| InputState::new(window, cx));
        let lyrics_search_input = cx.new(|cx| InputState::new(window, cx));
        let import_alt_search_input = cx.new(|cx| InputState::new(window, cx));
        let sc_token_input = cx.new(|cx| InputState::new(window, cx));
        let hex_accent_input = cx.new(|cx| InputState::new(window, cx));
        let hex_bg_input = cx.new(|cx| InputState::new(window, cx));

        hex_accent_input.update(cx, |s, cx| s.set_value(&appearance.accent_color, window, cx));
        hex_bg_input.update(cx, |s, cx| s.set_value(&appearance.bg_color, window, cx));

        let player = PlayerPersisted::default();
        let vol_slider = cx.new(|_| SliderState::new().min(0.0).max(100.0).step(1.0).default_value(player.volume * 100.0));
        let blur_slider = cx.new(|_| SliderState::new().min(0.0).max(100.0).step(1.0).default_value(appearance.blur));
        let opacity_slider = cx.new(|_| SliderState::new().min(10.0).max(90.0).step(1.0).default_value(appearance.opacity));
        let refraction_slider = cx.new(|_| SliderState::new().min(0.0).max(100.0).step(1.0).default_value(appearance.refraction));
        let bg_dim_slider = cx.new(|_| SliderState::new().min(0.0).max(85.0).step(1.0).default_value(appearance.bg_dim));
        let bg_blur_slider = cx.new(|_| SliderState::new().min(0.0).max(100.0).step(1.0).default_value(appearance.bg_blur));
        let neon_slider = cx.new(|_| SliderState::new().min(0.0).max(100.0).step(1.0).default_value(appearance.metallic_neon_intensity));
        let crossfade_dur_slider = cx.new(|_| SliderState::new().min(1.0).max(12.0).step(0.5).default_value(player.crossfade_duration as f32));
        let eq_sliders = std::array::from_fn(|i| {
            cx.new(|_| {
                SliderState::new()
                    .min(-12.0)
                    .max(12.0)
                    .step(0.5)
                    .default_value(player.eq_bands[i])
            })
        });

        // Subscribe to search input changes & enter
        cx.subscribe(&search_input, |this, input, ev: &InputEvent, cx| match ev {
            InputEvent::Change => {
                let q = input.read(cx).value().to_string();
                this.set_search_query(q, cx);
            }
            InputEvent::PressEnter { .. } => {
                let q = input.read(cx).value().to_string();
                this.run_search_now(&q, cx);
            }
            _ => {}
        })
        .detach();

        for ent in [&fav_filter_input, &playlist_filter_input, &dialog_name_input, &dialog_url_input, &dialog_custom_name_input] {
            cx.subscribe(ent, |_, _, ev: &InputEvent, cx| {
                if matches!(ev, InputEvent::Change) {
                    cx.notify();
                }
            })
            .detach();
        }

        cx.subscribe(&lyrics_search_input, |this, input, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::PressEnter { .. }) {
                let q = input.read(cx).value().to_string();
                this.search_lyrics_manual(q, cx);
            }
        })
        .detach();

        cx.subscribe(&hex_accent_input, |this, input, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change | InputEvent::PressEnter { .. }) {
                let val = input.read(cx).value().to_string();
                if let Some(hex) = crate::ui::normalize_hex_input(&val) {
                    this.appearance.accent_mode = AccentMode::Custom;
                    this.appearance.accent_color = hex;
                    this.mark_appearance_changed();
                    cx.notify();
                }
            }
        })
        .detach();

        cx.subscribe(&hex_bg_input, |this, input, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change | InputEvent::PressEnter { .. }) {
                let val = input.read(cx).value().to_string();
                if let Some(hex) = crate::ui::normalize_hex_input(&val) {
                    this.appearance.bg_mode = BgMode::Color;
                    this.appearance.bg_color = hex;
                    this.mark_appearance_changed();
                    cx.notify();
                }
            }
        })
        .detach();

        // Slider subscriptions
        cx.subscribe(&vol_slider, |this, _, ev: &SliderEvent, cx| {
            let SliderEvent::Change(val) = ev else { return; };
            this.set_volume((val.start() / 100.0).clamp(0.0, 1.0), cx);
        })
        .detach();

        cx.subscribe(&blur_slider, |this, _, ev: &SliderEvent, cx| {
            let SliderEvent::Change(val) = ev else { return; };
            this.appearance.blur = val.start().clamp(0.0, 100.0);
            this.mark_dirty();
            cx.notify();
        })
        .detach();

        cx.subscribe(&opacity_slider, |this, _, ev: &SliderEvent, cx| {
            let SliderEvent::Change(val) = ev else { return; };
            this.appearance.opacity = val.start().clamp(10.0, 90.0);
            this.mark_dirty();
            cx.notify();
        })
        .detach();

        cx.subscribe(&refraction_slider, |this, _, ev: &SliderEvent, cx| {
            let SliderEvent::Change(val) = ev else { return; };
            this.appearance.refraction = val.start().clamp(0.0, 100.0);
            this.mark_dirty();
            cx.notify();
        })
        .detach();

        cx.subscribe(&bg_dim_slider, |this, _, ev: &SliderEvent, cx| {
            let SliderEvent::Change(val) = ev else { return; };
            this.appearance.bg_dim = val.start().clamp(0.0, 85.0);
            this.mark_appearance_changed();
            cx.notify();
        })
        .detach();

        cx.subscribe(&bg_blur_slider, |this, _, ev: &SliderEvent, cx| {
            let SliderEvent::Change(val) = ev else { return; };
            this.appearance.bg_blur = val.start().clamp(0.0, 100.0);
            this.mark_appearance_changed();
            cx.notify();
        })
        .detach();

        cx.subscribe(&neon_slider, |this, _, ev: &SliderEvent, cx| {
            let SliderEvent::Change(val) = ev else { return; };
            this.appearance.metallic_neon_intensity = val.start().clamp(0.0, 100.0);
            this.mark_appearance_changed();
            cx.notify();
        })
        .detach();

        cx.subscribe(&crossfade_dur_slider, |this, _, ev: &SliderEvent, cx| {
            let SliderEvent::Change(val) = ev else { return; };
            this.player.crossfade_duration = f64::from(val.start()).clamp(1.0, 12.0);
            this.mark_dirty();
            cx.notify();
        })
        .detach();

        for (band_idx, s) in eq_sliders.iter().enumerate() {
            cx.subscribe(s, move |this, _, ev: &SliderEvent, cx| {
                let SliderEvent::Change(val) = ev else { return; };
                let mut bands = this.player.eq_bands;
                bands[band_idx] = val.start().clamp(-12.0, 12.0);
                this.set_eq(true, EqPreset::Custom, bands, cx);
            })
            .detach();
        }

        // OS MediaControls (NowPlayingInfoCenter on macOS)
        let (media_controls, media_event_rx) = {
            let (tx, rx) = mpsc::channel();
            match MediaControls::new(PlatformConfig {
                display_name: "Resonance",
                dbus_name: "com.resonance.player",
                hwnd: None,
            }) {
                Ok(mut mc) => {
                    if mc.attach(move |ev| {
                        let _ = tx.send(ev);
                    }).is_ok() {
                        (Some(mc), Some(Mutex::new(rx)))
                    } else {
                        (None, None)
                    }
                }
                Err(_) => (None, None),
            }
        };

        let hotkey_manager = GlobalHotKeyManager::new().ok();

        let (palette_tx, palette_rx) = mpsc::channel();
        let (import_prog_tx, import_prog_rx) = mpsc::channel();

        let mut store = Self {
            backend,
            yt_proxy,
            yt_store,
            audio,
            library: LibraryPersisted::default(),
            ui: UiPersisted::default(),
            appearance,
            player,
            shortcuts: ShortcutBindings::default(),
            manual_lyrics: HashMap::new(),
            custom_bg_image_path: None,
            route: Route::Home,
            search_open: false,
            search_q: String::new(),
            mobile_nav_open: false,
            mobile_np_open: false,
            now_playing_tab: NowPlayingTab::Lyrics,
            immersive_open: false,
            eq_open: false,
            dialog: None,
            import_mode: ImportDialogMode::Link,
            dialog_confirm_checked: false,
            create_initial_tab: CreateInitialTab::Scratch,
            open_track_menu_id: None,
            search_input,
            fav_filter_input,
            playlist_filter_input,
            dialog_name_input,
            dialog_url_input,
            dialog_custom_name_input,
            lyrics_search_input,
            import_alt_search_input,
            sc_token_input,
            hex_accent_input,
            hex_bg_input,
            vol_slider,
            blur_slider,
            opacity_slider,
            refraction_slider,
            bg_dim_slider,
            bg_blur_slider,
            neon_slider,
            crossfade_dur_slider,
            eq_sliders,
            queue: Vec::new(),
            queue_index: -1,
            current_track_id: None,
            status: PlaybackStatus::Idle,
            position: 0.0,
            duration: 0.0,
            play_context: None,
            current_audio_gen: 0,
            handled_ended_gen: 0,
            preloaded_for_gen: 0,
            preparing_xfade_for_gen: 0,
            preloaded_next_id: None,
            preloaded_next_url: None,
            handled_xfade_gen: 0,
            spectrum_bars: [0.0; 72],
            wave_phase: 0.0,
            wave_amp: 0.0,
            spin_deg: 0.0,
            mesh_phase: 0.0,
            bg_seek_dragging: false,
            resolved_theme,
            system_dark,
            theme_dirty: true,
            theme_animating: false,
            palette_cache: HashMap::new(),
            pending_palettes: HashSet::new(),
            search_loading: false,
            search_sc_tracks: Vec::new(),
            search_yt_tracks: Vec::new(),
            search_suggestions: Vec::new(),
            search_error: None,
            search_seq: 0,
            sc_authorized: false,
            sc_profile: None,
            sc_logging_in: false,
            sc_loading_lib: false,
            sc_tracks_mine: Vec::new(),
            yt_logging_in: false,
            yt_loading_lib: false,
            yt_active_playlist_loading: HashSet::new(),
            sc_active_playlist_loading: HashSet::new(),
            lyrics_cache: HashMap::new(),
            lyrics_loading: HashSet::new(),
            lyrics_search_open: false,
            lyrics_search_loading: false,
            lyrics_search_results: Vec::new(),
            import_job: ImportJobState::default(),
            preview_track_id: None,
            recording_shortcut: None,
            shortcut_error: None,
            hotkey_manager,
            registered_mute_hotkey: None,
            update_state: UpdateState::default(),
            splash_stage: SplashStage::Checking,
            snacks: VecDeque::new(),
            snack_seq: 0,
            palette_tx,
            palette_rx: Mutex::new(palette_rx),
            import_prog_tx,
            import_prog_rx: Mutex::new(import_prog_rx),
            media_controls,
            media_event_rx,
            last_widget_sig: String::new(),
            last_widget_pos: -1.0,
            last_widget_cover_url: String::new(),
            save_dirty_at: None,
            last_tick: Instant::now(),
        };

        store.register_global_mute_hotkey();
        store.boot_async(cx);
        store.start_tick_loop(cx);
        store
    }

    pub fn lang(&self) -> Lang {
        self.appearance.lang
    }

    pub fn t(&self, k: Key) -> &'static str {
        i18n::t(self.lang(), k)
    }

    pub fn tf(&self, k: Key, vars: &[(&str, &str)]) -> String {
        tf(self.lang(), k, vars)
    }

    pub fn current_track(&self) -> Option<&Track> {
        self.current_track_id
            .as_deref()
            .and_then(|id| self.library.catalog.get(id))
    }

    pub fn is_liked(&self, id: &str) -> bool {
        self.library.favorites.iter().any(|x| x == id)
    }

    pub fn is_disliked(&self, id: &str) -> bool {
        self.library.disliked.iter().any(|x| x == id)
    }

    pub fn mark_dirty(&mut self) {
        self.save_dirty_at = Some(Instant::now() + Duration::from_millis(450));
    }

    pub fn mark_appearance_changed(&mut self) {
        self.recompute_theme_sync();
        self.mark_dirty();
    }

    pub fn toast(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.toast_with_action(text, None, None, None, cx);
    }

    pub fn toast_with_action(
        &mut self,
        text: impl Into<String>,
        action_label: Option<String>,
        action_kind: Option<SnackActionKind>,
        payload_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.snack_seq += 1;
        let id = self.snack_seq;
        self.snacks.push_back(SnackItem {
            id,
            text: text.into(),
            action_label,
            action_kind,
            payload_id,
            expires_at: Instant::now() + Duration::from_secs(4),
        });
        while self.snacks.len() > 3 {
            self.snacks.pop_front();
        }
        cx.notify();
    }

    pub fn trigger_snack_action(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pos) = self.snacks.iter().position(|s| s.id == id) else {
            return;
        };
        let item = self.snacks.remove(pos).unwrap();
        match item.action_kind {
            Some(SnackActionKind::UndoDislike) => {
                if let Some(tid) = item.payload_id {
                    self.library.disliked.retain(|d| d != &tid);
                    self.mark_dirty();
                }
            }
            Some(SnackActionKind::OpenPlaylist) => {
                if let Some(pid) = item.payload_id {
                    self.navigate(Route::Playlist(pid), window, cx);
                }
            }
            Some(SnackActionKind::OpenImportReview) => {
                self.dialog = Some(DialogKind::ImportReview);
            }
            None => {}
        }
        cx.notify();
    }

    fn spawn_tokio<T, F, A>(&self, cx: &mut Context<Self>, fut: F, apply: A)
    where
        T: Send + 'static,
        F: std::future::Future<Output = T> + Send + 'static,
        A: FnOnce(&mut Self, T, &mut Context<Self>) + 'static,
    {
        let (tx, rx) = oneshot::channel();
        tokio_runtime().spawn(async move {
            let val = fut.await;
            let _ = tx.send(val);
        });
        cx.spawn(async move |this, cx| {
            if let Ok(val) = rx.await {
                let _ = this.update(cx, |s, cx| apply(s, val, cx));
            }
        })
        .detach();
    }

    fn boot_async(&mut self, cx: &mut Context<Self>) {
        let backend = self.backend.clone();
        let yt_proxy = self.yt_proxy.clone();
        let yt_store = self.yt_store.clone();
        let http = shared_reqwest();

        self.spawn_tokio(
            cx,
            async move {
                purge_retired_spotify_storage();
                let _ = yt_proxy.ensure_server_port().await;
                let persisted = load_all_state(&backend).await;
                let sc_auth = backend
                    .call("auth.status", Value::Null)
                    .await
                    .ok()
                    .and_then(|v| serde_json::from_value::<AuthStatus>(v).ok())
                    .unwrap_or_default();
                let yt_auth = yt_auth_status().await.ok();
                let yt_cached = yt_library_cached(&yt_store).await.ok().flatten();
                let upd = check_for_updates(&http).await;
                (persisted, sc_auth, yt_auth, yt_cached, upd)
            },
            |this, (persisted, sc_auth, yt_auth, yt_cached, upd), cx| {
                this.library = persisted.library;
                this.ui = persisted.ui;
                this.appearance = persisted.appearance;
                this.player = persisted.player;
                this.shortcuts = persisted.shortcuts;
                this.manual_lyrics = persisted.manual_lyrics;
                this.custom_bg_image_path = persisted.custom_bg_image_path;

                this.audio.set_volume(this.player.volume, this.player.muted);
                this.audio
                    .set_normalization(this.player.normalization_enabled, this.player.normalization_target);
                this.audio
                    .set_eq(this.player.eq_enabled, this.player.eq_preset, this.player.eq_bands);

                this.sc_authorized = sc_auth.authorized;
                this.sc_profile = sc_auth.profile;
                if let Some(yt) = yt_auth {
                    this.library.ytmusic_authorized = yt.authorized;
                    if let Some(p) = yt.profile {
                        this.library.ytmusic_account_name = p.name;
                        this.library.ytmusic_account_handle = p.handle;
                    }
                }
                if let Some(lib) = yt_cached {
                    this.apply_yt_library_dto(lib);
                }

                this.update_state = upd;
                this.splash_stage = SplashStage::Hidden;
                this.register_global_mute_hotkey();
                this.recompute_theme_sync();
                if this.sc_authorized {
                    this.refresh_soundcloud(false, cx);
                }
                if this.library.ytmusic_authorized {
                    this.refresh_ytmusic(false, cx);
                }
                cx.notify();
            },
        );
    }

    fn start_tick_loop(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(16)).await;
                let keep_going = this.update(cx, |s, cx| s.on_frame_tick(cx)).is_ok();
                if !keep_going {
                    break;
                }
            }
        })
        .detach();
    }

    fn on_frame_tick(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        let dt = now.duration_since(self.last_tick).as_secs_f32().clamp(0.001, 0.1);
        self.last_tick = now;

        let mut changed = false;

        // 1. Poll audio engine snapshot
        let snap = self.audio.snapshot();
        if snap.status != self.status
            || (snap.position - self.position).abs() > 0.02
            || (snap.duration - self.duration).abs() > 0.05
        {
            self.status = snap.status;
            if !self.bg_seek_dragging {
                self.position = snap.position;
            }
            if snap.duration > 0.0 {
                self.duration = snap.duration;
            }
            changed = true;
        }

        if let Some(ref err) = snap.error
            && snap.track_generation == self.current_audio_gen && self.status == PlaybackStatus::Error {
                self.status = PlaybackStatus::Idle;
                let msg = format!("{}: {err}", self.t(Key::CantPlay));
                self.toast(msg, cx);
                changed = true;
            }

        // 2. End-of-track handling
        if snap.ended_generation != 0
            && snap.ended_generation == self.current_audio_gen
            && snap.ended_generation != self.handled_ended_gen
        {
            self.handled_ended_gen = snap.ended_generation;
            self.handle_track_ended(cx);
            changed = true;
        }

        // 3. Auto-crossfade evaluation
        if self.player.crossfade_enabled && self.current_audio_gen != 0 && self.handled_xfade_gen != self.current_audio_gen {
            let eff_dur = self.duration.max(self.current_track().map(|t| t.duration).unwrap_or(0.0));
            let dec = evaluate_auto_crossfade_trigger(
                eff_dur,
                self.position,
                self.player.crossfade_duration,
                self.status != PlaybackStatus::Playing,
                false,
                self.preloaded_for_gen == self.current_audio_gen,
                self.preparing_xfade_for_gen == self.current_audio_gen,
                5.0,
            );
            if dec.should_preload {
                self.prepare_next_crossfade_url(self.current_audio_gen, cx);
            }
            if dec.should_start && self.preloaded_next_url.is_some() {
                self.execute_crossfade(cx);
                changed = true;
            }
        }

        // 4. Spectrum + waves + cover spin + ambient mesh animation
        let reduced = self.appearance.motion == MotionMode::Reduced;
        let PlayingState { is_playing } = PlayingState {
            is_playing: self.status == PlaybackStatus::Playing,
        };
        if self.eq_open {
            if is_playing {
                self.audio.read_spectrum_bars(&mut self.spectrum_bars);
            } else {
                for b in &mut self.spectrum_bars {
                    *b *= 0.82;
                }
            }
            changed = true;
        }
        if is_playing && !reduced {
            let mult = if self.appearance.motion == MotionMode::Expressive { 1.0 } else { 0.65 };
            self.wave_phase += dt * 4.4 * mult;
            self.wave_amp += (3.2 * mult - self.wave_amp) * (dt * 9.0).min(1.0);
            self.spin_deg = (self.spin_deg + dt * 20.0 * mult) % 360.0;
            self.mesh_phase += dt * 0.65 * mult;
            changed = true;
        } else if self.wave_amp > 0.02 {
            self.wave_amp *= 0.85;
            changed = true;
        } else if !reduced {
            self.mesh_phase += dt * 0.18;
        }

        // 5. Poll Global Hotkey (Shift+M mute)
        while let Ok(ev) = GlobalHotKeyEvent::receiver().try_recv() {
            if ev.state == HotKeyState::Pressed
                && self.registered_mute_hotkey.is_some_and(|h| h.id() == ev.id())
            {
                self.toggle_mute(cx);
                changed = true;
            }
        }

        // 6. Poll OS MediaControls events
        let mut media_events = Vec::new();
        if let Some(ref rx_mux) = self.media_event_rx
            && let Ok(rx) = rx_mux.try_lock() {
                while let Ok(ev) = rx.try_recv() {
                    media_events.push(ev);
                }
            }
        for ev in media_events {
            match ev {
                MediaControlEvent::Play => {
                    if self.status != PlaybackStatus::Playing {
                        self.toggle_play(cx);
                    }
                }
                MediaControlEvent::Pause => {
                    if self.status == PlaybackStatus::Playing {
                        self.toggle_play(cx);
                    }
                }
                MediaControlEvent::Toggle => self.toggle_play(cx),
                MediaControlEvent::Next => self.next_track(cx),
                MediaControlEvent::Previous => self.prev_track(cx),
                MediaControlEvent::Stop => self.audio.stop(),
                MediaControlEvent::SetPosition(MediaPosition(pos)) => {
                    self.seek_to(pos.as_secs_f64(), cx);
                }
                _ => {}
            }
            changed = true;
        }

        // 6b. Drain background palette fetches
        let mut pal_updates = Vec::new();
        if let Ok(rx) = self.palette_rx.try_lock() {
            while let Ok(item) = rx.try_recv() {
                pal_updates.push(item);
            }
        }
        if !pal_updates.is_empty() {
            let mut any_pal = false;
            for (key, pal) in pal_updates {
                self.pending_palettes.remove(&key);
                if let Some(p) = pal {
                    self.palette_cache.insert(key, p);
                    any_pal = true;
                }
            }
            if any_pal {
                self.recompute_theme_sync();
                changed = true;
            }
        }

        // 6c. Drain import job progress updates
        let mut prog_updates = Vec::new();
        if let Ok(rx) = self.import_prog_rx.try_lock() {
            while let Ok(p) = rx.try_recv() {
                prog_updates.push(p);
            }
        }
        if let Some((phase, done, total)) = prog_updates.into_iter().last() {
            self.import_job.phase = Some(phase);
            self.import_job.done = done;
            self.import_job.total = total;
            changed = true;
        }

        // 7. Sync macOS Widget + MediaControls metadata
        self.sync_os_integrations();

        // 8. Expire snackbars
        if !self.snacks.is_empty() {
            let before = self.snacks.len();
            self.snacks.retain(|s| s.expires_at > now);
            if self.snacks.len() != before {
                changed = true;
            }
        }

        // 9. Debounced persistence
        if let Some(deadline) = self.save_dirty_at
            && now >= deadline {
                self.save_dirty_at = None;
                self.flush_save();
            }

        if changed {
            cx.notify();
        }
    }

    fn flush_save(&self) {
        let backend = self.backend.clone();
        let snapshot = AppPersistedState {
            library: self.library.clone(),
            ui: self.ui.clone(),
            appearance: self.appearance.clone(),
            player: self.player.clone(),
            shortcuts: self.shortcuts.clone(),
            manual_lyrics: self.manual_lyrics.clone(),
            updater: UpdaterPersisted {
                available: self.update_state.available,
                latest_version: self.update_state.latest_version.clone(),
                release_url: self.update_state.release_url.clone(),
                download_url: self.update_state.download_url.clone(),
                notes: self.update_state.notes.clone(),
            },
            custom_bg_image_path: self.custom_bg_image_path.clone(),
        };
        tokio_runtime().spawn(async move {
            let _ = save_all_state(&backend, &snapshot).await;
        });
    }

    fn sync_os_integrations(&mut self) {
        let playing = self.status == PlaybackStatus::Playing;
        let track = self.current_track().cloned();
        let accent_hex = hex_from_argb(self.resolved_theme.accent_argb);
        let sig = format!(
            "{}|{playing}|{accent_hex}",
            track.as_ref().map(|t| t.id.as_str()).unwrap_or("")
        );
        let pos_drifted = (self.position - self.last_widget_pos).abs() > 1.5;
        if sig == self.last_widget_sig && !pos_drifted {
            return;
        }
        self.last_widget_sig = sig;
        self.last_widget_pos = self.position;

        if let Some(ref tr) = track {
            let updated_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let mut payload = NowPlayingPayload {
                version: PAYLOAD_VERSION,
                title: tr.title.clone(),
                artist: tr.artist.clone(),
                is_playing: playing,
                duration_sec: self.duration.max(tr.duration).max(0.0),
                position_sec: self.position.max(0.0),
                updated_at,
                artwork_base64: None,
                accent_color: accent_hex,
            };
            let cover_url = tr
                .cover
                .clone()
                .or_else(|| tr.thumb.clone())
                .unwrap_or_default();
            let cover_changed = !cover_url.is_empty() && cover_url != self.last_widget_cover_url;
            if cover_changed {
                self.last_widget_cover_url = cover_url.clone();
            }
            tokio_runtime().spawn(async move {
                if cover_changed
                    && let Ok(raw) = crate::http_client::fetch_image_bytes_cached(&cover_url).await
                        && let Ok(img) = image::load_from_memory(&raw) {
                            let thumb = img.thumbnail(512, 512).to_rgb8();
                            let mut jpeg = Vec::new();
                            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85);
                            if enc.encode_image(&thumb).is_ok() {
                                payload.artwork_base64 = Some(
                                    base64::engine::general_purpose::STANDARD.encode(&jpeg),
                                );
                            }
                        }
                let _ = widget_update_now_playing(payload).await;
            });
        } else {
            self.last_widget_cover_url.clear();
            let updated_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let idle_payload = NowPlayingPayload {
                version: PAYLOAD_VERSION,
                title: String::new(),
                artist: String::new(),
                is_playing: false,
                duration_sec: 0.0,
                position_sec: 0.0,
                updated_at,
                artwork_base64: None,
                accent_color: accent_hex,
            };
            tokio_runtime().spawn(async move {
                let _ = widget_update_now_playing(idle_payload).await;
            });
        }

        if let Some(ref mut mc) = self.media_controls {
            if let Some(ref tr) = track {
                let dur = Duration::from_secs_f64(self.duration.max(tr.duration).max(0.0));
                let _ = mc.set_metadata(MediaMetadata {
                    title: Some(&tr.title),
                    album: tr.album.as_deref(),
                    artist: Some(&tr.artist),
                    cover_url: tr.cover.as_deref().or(tr.thumb.as_deref()),
                    duration: if dur.as_secs() > 0 { Some(dur) } else { None },
                });
                let pb = if playing {
                    MediaPlayback::Playing {
                        progress: Some(MediaPosition(Duration::from_secs_f64(self.position.max(0.0)))),
                    }
                } else {
                    MediaPlayback::Paused {
                        progress: Some(MediaPosition(Duration::from_secs_f64(self.position.max(0.0)))),
                    }
                };
                let _ = mc.set_playback(pb);
            } else {
                let _ = mc.set_playback(MediaPlayback::Stopped);
            }
        }
    }

    // ---- Theme & Appearance ---------------------------------------------------------------------

    pub fn recompute_theme_sync(&mut self) {
        let dark = match self.appearance.theme {
            ThemeModePref::Dark => true,
            ThemeModePref::Light => false,
            ThemeModePref::System => self.system_dark,
        };
        let tr = self.current_track().cloned();
        let tr_id = tr.as_ref().map(|t| t.id.as_str());
        let tr_cover = tr.as_ref().and_then(|t| t.cover.as_deref().or(t.thumb.as_deref()));
        let tr_pal = tr_id.and_then(|id| self.palette_cache.get(id)).cloned();
        let bg_img_str = self
            .custom_bg_image_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let bg_pal = bg_img_str
            .as_ref()
            .and_then(|p| self.palette_cache.get(&format!("bg:{p}")))
            .cloned();

        self.resolved_theme = resolve_theme(
            &self.appearance,
            dark,
            tr_id,
            tr_cover,
            tr_pal.as_ref(),
            bg_img_str.as_deref(),
            bg_pal.as_ref(),
        );
        self.theme_dirty = true;

        // Fetch missing cover palette asynchronously if dynamic mode needs it
        if let Some(ref t) = tr
            && (self.appearance.accent_mode == AccentMode::Dynamic
                || self.appearance.bg_mode == BgMode::Dynamic)
                && !self.palette_cache.contains_key(&t.id)
                && !self.pending_palettes.contains(&t.id)
                && let Some(url) = t.thumb.clone().or_else(|| t.cover.clone()) {
                    let key = t.id.clone();
                    self.pending_palettes.insert(key.clone());
                    self.fetch_palette_async(key, url);
                }
        if self.appearance.bg_mode == BgMode::Image
            && let Some(path) = bg_img_str {
                let key = format!("bg:{path}");
                if !self.palette_cache.contains_key(&key) && !self.pending_palettes.contains(&key) {
                    self.pending_palettes.insert(key.clone());
                    self.fetch_palette_async(key, path);
                }
            }
    }

    fn fetch_palette_async(&mut self, cache_key: String, url_or_path: String) {
        let tx = self.palette_tx.clone();
        tokio_runtime().spawn(async move {
            let pal = match fetch_image_bytes_cached(&url_or_path).await {
                Ok(bytes) => extract_palette_from_image_bytes(&bytes),
                Err(_) => None,
            };
            let _ = tx.send((cache_key, pal));
        });
    }

    pub fn request_track_palette(&mut self, track_id: String, url: String, cx: &mut Context<Self>) {
        if self.palette_cache.contains_key(&track_id) || self.pending_palettes.contains(&track_id) {
            return;
        }
        self.pending_palettes.insert(track_id.clone());
        self.spawn_tokio(
            cx,
            async move {
                let pal = match fetch_image_bytes_cached(&url).await {
                    Ok(bytes) => extract_palette_from_image_bytes(&bytes),
                    Err(_) => None,
                };
                (track_id, pal)
            },
            |this, (key, pal), cx| {
                this.pending_palettes.remove(&key);
                if let Some(p) = pal {
                    this.palette_cache.insert(key, p);
                    this.recompute_theme_sync();
                    cx.notify();
                }
            },
        );
    }

    pub fn advance_theme_if_needed(&mut self, window: &mut Window, cx: &mut App) -> bool {
        if !self.theme_dirty && !self.theme_animating {
            return false;
        }
        self.theme_dirty = false;
        let running = theme::advance_component_theme(self.resolved_theme.scheme, 1.0, window, cx);
        self.theme_animating = running;
        running
    }

    pub fn pick_custom_bg_photo(&mut self, cx: &mut Context<Self>) {
        self.spawn_tokio(
            cx,
            async move {
                let handle = rfd::AsyncFileDialog::new()
                    .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif"])
                    .pick_file()
                    .await?;
                let bytes = handle.read().await;
                if bytes.len() > 8 * 1024 * 1024 {
                    return Some(Err("too_large"));
                }
                Some(save_bg_image_bytes(&bytes).map_err(|_| "save_err"))
            },
            |this, res, cx| match res {
                Some(Ok(path)) => {
                    this.custom_bg_image_path = Some(path.clone());
                    this.appearance.bg_mode = BgMode::Image;
                    this.recompute_theme_sync();
                    let p_str = path.to_string_lossy().to_string();
                    this.request_track_palette(format!("bg:{p_str}"), p_str, cx);
                    this.mark_dirty();
                    cx.notify();
                }
                Some(Err("too_large")) => {
                    let msg = this.t(Key::PhotoTooLarge);
                    this.toast(msg, cx);
                }
                Some(Err(_)) => {
                    let msg = this.t(Key::PhotoError);
                    this.toast(msg, cx);
                }
                None => {}
            },
        );
    }

    pub fn remove_custom_bg_photo(&mut self, cx: &mut Context<Self>) {
        remove_bg_image_file();
        self.custom_bg_image_path = None;
        self.appearance.bg_mode = BgMode::Color;
        self.mark_appearance_changed();
        cx.notify();
    }

    pub fn reset_appearance(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        remove_bg_image_file();
        self.custom_bg_image_path = None;
        let lang = self.appearance.lang;
        self.appearance = Appearance {
            lang,
            ..Appearance::default()
        };
        let a = self.appearance.clone();
        self.blur_slider.update(cx, |s, cx| s.set_value(a.blur, window, cx));
        self.opacity_slider.update(cx, |s, cx| s.set_value(a.opacity, window, cx));
        self.refraction_slider.update(cx, |s, cx| s.set_value(a.refraction, window, cx));
        self.bg_dim_slider.update(cx, |s, cx| s.set_value(a.bg_dim, window, cx));
        self.bg_blur_slider.update(cx, |s, cx| s.set_value(a.bg_blur, window, cx));
        self.neon_slider.update(cx, |s, cx| s.set_value(a.metallic_neon_intensity, window, cx));
        self.hex_accent_input.update(cx, |s, cx| s.set_value(&a.accent_color, window, cx));
        self.hex_bg_input.update(cx, |s, cx| s.set_value(&a.bg_color, window, cx));
        self.mark_appearance_changed();
        cx.notify();
    }

    // ---- Navigation -----------------------------------------------------------------------------

    pub fn navigate(&mut self, route: Route, window: &mut Window, cx: &mut Context<Self>) {
        let changed = self.route != route || self.search_open;
        self.route = route.clone();
        self.search_open = false;
        self.mobile_nav_open = false;
        if let Route::Playlist(ref id) = route {
            self.playlist_filter_input.update(cx, |s, cx| s.set_value("", window, cx));
            if let Some(urn) = id.strip_prefix("scpl:") {
                self.load_soundcloud_playlist_tracks(urn.to_string(), cx);
            } else if let Some(yt_id) = id.strip_prefix("ytpl:") {
                self.load_yt_playlist_tracks(yt_id.to_string(), cx);
            }
        }
        if matches!(route, Route::Favorites) {
            self.fav_filter_input.update(cx, |s, cx| s.set_value("", window, cx));
        }
        if changed {
            cx.notify();
        }
    }

    pub fn open_search(&mut self, initial_query: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        self.search_open = true;
        self.mobile_nav_open = false;
        if let Some(q) = initial_query {
            self.search_q = q.to_string();
            let q_own = self.search_q.clone();
            self.search_input.update(cx, |s, cx| s.set_value(&q_own, window, cx));
            if !q_own.trim().is_empty() {
                self.run_search_now(&q_own, cx);
            }
        }
        let ph = self.t(Key::SearchPlaceholder);
        self.search_input.update(cx, |s, cx| s.set_placeholder(ph, window, cx));
        let fh = self.search_input.read(cx).focus_handle(cx);
        window.focus(&fh, cx);
        cx.notify();
    }

    pub fn close_search(&mut self, cx: &mut Context<Self>) {
        self.search_open = false;
        cx.notify();
    }

    // ---- Playback & Queue -----------------------------------------------------------------------

    pub fn add_tracks_to_catalog(&mut self, tracks: &[Track]) {
        for t in tracks {
            self.library.catalog.insert(t.id.clone(), t.clone());
        }
    }

    pub fn play_track(
        &mut self,
        track: Track,
        list: Option<Vec<Track>>,
        context_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.audio.stop_preview();
        self.preview_track_id = None;
        self.add_tracks_to_catalog(std::slice::from_ref(&track));
        if let Some(ref items) = list {
            self.add_tracks_to_catalog(items);
            self.queue = items.iter().map(|t| t.id.clone()).collect();
            self.queue_index = self
                .queue
                .iter()
                .position(|id| id == &track.id)
                .map(|i| i as isize)
                .unwrap_or(0);
        } else if let Some(pos) = self.queue.iter().position(|id| id == &track.id) {
            self.queue_index = pos as isize;
        } else {
            self.queue = vec![track.id.clone()];
            self.queue_index = 0;
        }

        self.play_context = context_id;
        self.start_playback_for_track(track, None, false, cx);
    }

    pub fn play_from_list_index(
        &mut self,
        tracks: &[Track],
        idx: usize,
        context_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if let Some(tr) = tracks.get(idx).cloned() {
            self.play_track(tr, Some(tracks.to_vec()), context_id, cx);
        }
    }

    fn start_playback_for_track(
        &mut self,
        track: Track,
        crossfade_from_gen: Option<u64>,
        already_resolved_url: bool,
        cx: &mut Context<Self>,
    ) {
        self.current_track_id = Some(track.id.clone());
        self.status = PlaybackStatus::Loading;
        self.position = 0.0;
        self.duration = track.duration;
        self.preloaded_for_gen = 0;
        self.preparing_xfade_for_gen = 0;
        self.preloaded_next_id = None;
        self.preloaded_next_url = None;

        // Record in recent history + backend
        self.library.recent.retain(|id| id != &track.id);
        self.library.recent.insert(0, track.id.clone());
        self.library.recent.truncate(30);
        self.mark_dirty();

        if let Some(url) = track.thumb.clone().or_else(|| track.cover.clone()) {
            self.request_track_palette(track.id.clone(), url, cx);
        }
        self.recompute_theme_sync();
        self.ensure_lyrics_for_track(&track, false, cx);

        if already_resolved_url && !track.src.is_empty() {
            let new_gen = if crossfade_from_gen.is_some() && self.player.crossfade_enabled {
                self.audio.crossfade_to(
                    track.src.clone(),
                    self.player.crossfade_duration,
                    self.player.crossfade_curve,
                )
            } else {
                self.audio.play(track.src.clone(), None)
            };
            self.current_audio_gen = new_gen;
            cx.notify();
            return;
        }

        let track_id = track.id.clone();
        let backend = self.backend.clone();
        let yt_proxy = self.yt_proxy.clone();
        let track_clone = track.clone();

        self.spawn_tokio(
            cx,
            async move { resolve_playable_stream(&backend, &yt_proxy, &track_clone).await },
            move |this, res, cx| {
                if this.current_track_id.as_deref() != Some(&track_id) {
                    return;
                }
                match res {
                    Ok(ResolvedPlayback::Ready { url, updated_track }) => {
                        this.library.catalog.insert(updated_track.id.clone(), *updated_track);
                        let new_gen = if crossfade_from_gen.is_some() && this.player.crossfade_enabled {
                            this.audio.crossfade_to(
                                url,
                                this.player.crossfade_duration,
                                this.player.crossfade_curve,
                            )
                        } else {
                            this.audio.play(url, None)
                        };
                        this.current_audio_gen = new_gen;
                        cx.notify();
                    }
                    Ok(ResolvedPlayback::FallbackNotFound) => {
                        this.status = PlaybackStatus::Idle;
                        let msg = this.t(Key::SoundcloudFallbackNoMatch);
                        this.toast(msg, cx);
                        cx.notify();
                    }
                    Err(e) => {
                        this.status = PlaybackStatus::Error;
                        let msg = this.tf(Key::StreamFallbackFailed, &[("reason", &e)]);
                        this.toast(msg, cx);
                        cx.notify();
                    }
                }
            },
        );
        cx.notify();
    }

    pub fn toggle_play(&mut self, cx: &mut Context<Self>) {
        if self.current_track_id.is_none() {
            if let Some(first) = self.library.recent.first().and_then(|id| self.library.catalog.get(id)).cloned() {
                self.play_track(first, None, None, cx);
            }
            return;
        }
        if self.status == PlaybackStatus::Playing {
            self.audio.pause();
            self.status = PlaybackStatus::Paused;
        } else if self.status == PlaybackStatus::Paused {
            self.audio.resume();
            self.status = PlaybackStatus::Playing;
        } else if let Some(tr) = self.current_track().cloned() {
            self.start_playback_for_track(tr, None, false, cx);
        }
        cx.notify();
    }

    pub fn seek_to(&mut self, sec: f64, cx: &mut Context<Self>) {
        let clamped = sec.clamp(0.0, self.duration.max(0.0));
        self.position = clamped;
        self.audio.seek(clamped);
        cx.notify();
    }

    pub fn next_track(&mut self, cx: &mut Context<Self>) {
        self.advance_queue(StepDirection::Next, false, cx);
    }

    pub fn prev_track(&mut self, cx: &mut Context<Self>) {
        if self.position > 3.0 {
            self.seek_to(0.0, cx);
            return;
        }
        self.advance_queue(StepDirection::Prev, false, cx);
    }

    fn handle_track_ended(&mut self, cx: &mut Context<Self>) {
        if self.player.repeat == RepeatMode::One
            && let Some(tr) = self.current_track().cloned() {
                self.start_playback_for_track(tr, None, false, cx);
                return;
            }
        self.advance_queue(StepDirection::Next, true, cx);
    }

    fn advance_queue(&mut self, dir: StepDirection, from_end: bool, cx: &mut Context<Self>) {
        if self.queue.is_empty() {
            if dir == StepDirection::Next {
                self.try_autoplay_related(cx);
            }
            return;
        }
        let disliked: HashSet<String> = self.library.disliked.iter().cloned().collect();
        let dir_num = match dir {
            StepDirection::Next => 1,
            StepDirection::Prev => -1,
        };
        let step = step_queue_index(
            &self.queue,
            self.queue_index,
            dir_num,
            from_end,
            self.player.repeat,
            self.player.shuffle,
            |id| disliked.contains(id),
            true,
        );
        match step {
            Some(QueueStepResult::RepeatOne) => {
                if let Some(tr) = self.current_track().cloned() {
                    self.start_playback_for_track(tr, None, false, cx);
                    return;
                }
            }
            Some(QueueStepResult::Index(idx)) => {
                self.queue_index = idx as isize;
                if let Some(tr) = self.queue.get(idx).and_then(|id| self.library.catalog.get(id)).cloned() {
                    let xfade_from = if !from_end && self.player.crossfade_enabled && self.current_audio_gen != 0 {
                        Some(self.current_audio_gen)
                    } else {
                        None
                    };
                    self.start_playback_for_track(tr, xfade_from, false, cx);
                    return;
                }
            }
            Some(QueueStepResult::EndShuffle) | None => {}
        }
        if dir == StepDirection::Next {
            self.try_autoplay_related(cx);
        }
    }

    fn prepare_next_crossfade_url(&mut self, cur_gen: u64, cx: &mut Context<Self>) {
        let disliked: HashSet<String> = self.library.disliked.iter().cloned().collect();
        let step = step_queue_index(
            &self.queue,
            self.queue_index,
            1,
            true,
            self.player.repeat,
            self.player.shuffle,
            |id| disliked.contains(id),
            false,
        );
        let Some(QueueStepResult::Index(idx)) = step else { return };
        let Some(next_tr) = self.queue.get(idx).and_then(|id| self.library.catalog.get(id)).cloned() else {
            return;
        };
        self.preparing_xfade_for_gen = cur_gen;
        let backend = self.backend.clone();
        let yt_proxy = self.yt_proxy.clone();
        self.spawn_tokio(
            cx,
            async move { resolve_playable_stream(&backend, &yt_proxy, &next_tr).await },
            move |this, res, _| {
                if this.current_audio_gen != cur_gen {
                    return;
                }
                this.preparing_xfade_for_gen = 0;
                if let Ok(ResolvedPlayback::Ready { url, updated_track }) = res {
                    this.preloaded_next_id = Some(updated_track.id.clone());
                    this.preloaded_next_url = Some(url);
                    this.preloaded_for_gen = cur_gen;
                    this.library.catalog.insert(updated_track.id.clone(), *updated_track);
                }
            },
        );
    }

    fn execute_crossfade(&mut self, cx: &mut Context<Self>) {
        let Some(next_id) = self.preloaded_next_id.take() else { return };
        let Some(next_url) = self.preloaded_next_url.take() else { return };
        let Some(mut next_tr) = self.library.catalog.get(&next_id).cloned() else { return };
        let Some(idx) = self.queue.iter().position(|id| id == &next_id) else { return };

        let plan = plan_auto_crossfade(
            self.player.crossfade_duration,
            self.duration,
            next_tr.duration,
            self.position,
        );
        self.handled_xfade_gen = self.current_audio_gen;
        self.queue_index = idx as isize;
        next_tr.src = next_url;
        let fade_s = plan.fade_sec;
        let old_dur = self.player.crossfade_duration;
        self.player.crossfade_duration = fade_s;
        self.start_playback_for_track(next_tr, Some(self.current_audio_gen), true, cx);
        self.player.crossfade_duration = old_dur;
    }

    fn try_autoplay_related(&mut self, cx: &mut Context<Self>) {
        let Some(seed) = self.current_track().cloned() else {
            self.status = PlaybackStatus::Idle;
            return;
        };
        let backend = self.backend.clone();
        let yt_proxy = self.yt_proxy.clone();
        let queued: HashSet<String> = self.queue.iter().cloned().collect();
        let disliked: HashSet<String> = self.library.disliked.iter().cloned().collect();
        let seed_clone = seed.clone();

        self.spawn_tokio(
            cx,
            async move {
                let mut candidates = Vec::new();
                if let Some(vid) = seed_clone.yt_video_id() {
                    if let Ok(list) = yt_radio_tracks(&yt_proxy, vid).await {
                        candidates.extend(list.into_iter().map(yt_search_to_track));
                    }
                } else if let Some(sc_id) = seed_clone.id.strip_prefix("sc:").and_then(|s| s.parse::<i64>().ok())
                    && let Ok(v) = backend.call("track.related", serde_json::json!({ "trackId": sc_id })).await {
                        candidates.extend(parse_sc_tracks_from_value(&v));
                    }
                let ranked = rank_recommendations(&[&seed_clone], &candidates, &queued, &disliked, &HashSet::new());
                ranked.into_iter().next()
            },
            |this, maybe_next, cx| {
                if let Some(tr) = maybe_next {
                    this.library.catalog.insert(tr.id.clone(), tr.clone());
                    this.queue.push(tr.id.clone());
                    this.queue_index = (this.queue.len() - 1) as isize;
                    this.start_playback_for_track(tr, None, false, cx);
                } else {
                    this.status = PlaybackStatus::Idle;
                }
                cx.notify();
            },
        );
    }

    pub fn play_next_in_queue(&mut self, track: Track, cx: &mut Context<Self>) {
        self.add_tracks_to_catalog(std::slice::from_ref(&track));
        if self.queue.is_empty() {
            self.play_track(track, None, None, cx);
            return;
        }
        let insert_at = ((self.queue_index + 1) as usize).min(self.queue.len());
        self.queue.insert(insert_at, track.id);
        let msg = self.t(Key::PlayingNext);
        self.toast(msg, cx);
        cx.notify();
    }

    pub fn add_to_queue(&mut self, track: Track, cx: &mut Context<Self>) {
        self.add_tracks_to_catalog(std::slice::from_ref(&track));
        if self.queue.is_empty() {
            self.play_track(track, None, None, cx);
            return;
        }
        self.queue.push(track.id);
        let msg = self.t(Key::AddedToQueue);
        self.toast(msg, cx);
        cx.notify();
    }

    pub fn set_volume(&mut self, pos: f32, cx: &mut Context<Self>) {
        self.player.volume = pos.clamp(0.0, 1.0);
        if self.player.volume > 0.0 && self.player.muted {
            self.player.muted = false;
        }
        self.audio.set_volume(self.player.volume, self.player.muted);
        self.mark_dirty();
        cx.notify();
    }

    pub fn toggle_mute(&mut self, cx: &mut Context<Self>) {
        self.player.muted = !self.player.muted;
        self.audio.set_volume(self.player.volume, self.player.muted);
        self.mark_dirty();
        cx.notify();
    }

    pub fn toggle_shuffle(&mut self, cx: &mut Context<Self>) {
        self.player.shuffle = !self.player.shuffle;
        if self.player.shuffle && self.queue.len() > 2 {
            let cur = usize::try_from(self.queue_index).ok().filter(|&i| i < self.queue.len());
            if let Some(i) = cur {
                self.queue.swap(0, i);
                self.queue_index = 0;
            }
            for i in (2..self.queue.len()).rev() {
                let j = 1 + next_pseudo_rand(i);
                self.queue.swap(i, j);
            }
        }
        self.mark_dirty();
        cx.notify();
    }

    pub fn cycle_repeat(&mut self, cx: &mut Context<Self>) {
        self.player.repeat = match self.player.repeat {
            RepeatMode::Off => RepeatMode::All,
            RepeatMode::All => RepeatMode::One,
            RepeatMode::One => RepeatMode::Off,
        };
        self.mark_dirty();
        cx.notify();
    }

    pub fn set_normalization(&mut self, enabled: bool, target: NormalizationTarget, cx: &mut Context<Self>) {
        self.player.normalization_enabled = enabled;
        self.player.normalization_target = target;
        self.audio.set_normalization(enabled, target);
        self.mark_dirty();
        cx.notify();
    }

    pub fn set_crossfade(&mut self, enabled: bool, dur: f64, curve: CrossfadeCurve, cx: &mut Context<Self>) {
        self.player.crossfade_enabled = enabled;
        self.player.crossfade_duration = dur.clamp(1.0, 12.0);
        self.player.crossfade_curve = curve;
        self.mark_dirty();
        cx.notify();
    }

    pub fn set_eq(&mut self, enabled: bool, preset: EqPreset, bands: [f32; 5], cx: &mut Context<Self>) {
        self.player.eq_enabled = enabled;
        self.player.eq_preset = preset;
        self.player.eq_bands = bands;
        self.audio.set_eq(enabled, preset, bands);
        self.mark_dirty();
        cx.notify();
    }

    pub fn apply_eq_preset(&mut self, preset: EqPreset, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(bands) = preset_gains(preset) {
            for (i, s) in self.eq_sliders.iter().enumerate() {
                let v = bands[i];
                s.update(cx, |st, cx| st.set_value(v, window, cx));
            }
            self.set_eq(self.player.eq_enabled, preset, bands, cx);
        }
    }

    pub fn reset_eq(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.apply_eq_preset(EqPreset::Flat, window, cx);
    }

    // ---- Likes & Library ------------------------------------------------------------------------

    pub fn toggle_like(&mut self, track_id: &str, cx: &mut Context<Self>) {
        if let Some(pos) = self.library.favorites.iter().position(|x| x == track_id) {
            self.library.favorites.remove(pos);
            let msg = self.t(Key::RemovedFav);
            self.toast(msg, cx);
        } else {
            self.library.favorites.insert(0, track_id.to_string());
            self.library.disliked.retain(|x| x != track_id);
            let msg = self.t(Key::AddedFav);
            self.toast(msg, cx);
        }
        self.mark_dirty();
        cx.notify();
    }

    pub fn toggle_dislike(&mut self, track_id: &str, cx: &mut Context<Self>) {
        if let Some(pos) = self.library.disliked.iter().position(|x| x == track_id) {
            self.library.disliked.remove(pos);
        } else {
            self.library.disliked.push(track_id.to_string());
            self.library.favorites.retain(|x| x != track_id);
            let msg = self.t(Key::DislikedMsg).to_string();
            let undo = self.t(Key::Undo).to_string();
            self.toast_with_action(
                msg,
                Some(undo),
                Some(SnackActionKind::UndoDislike),
                Some(track_id.to_string()),
                cx,
            );
            if self.current_track_id.as_deref() == Some(track_id) {
                self.next_track(cx);
            }
        }
        self.mark_dirty();
        cx.notify();
    }

    pub fn create_playlist(
        &mut self,
        name: String,
        initial_track_id: Option<String>,
        section: PlaylistSection,
        artwork_url: Option<String>,
        track_ids: Option<Vec<String>>,
        cx: &mut Context<Self>,
    ) -> String {
        let trimmed = name.trim();
        let final_name = if trimmed.is_empty() {
            self.t(Key::NewPlaylist).to_string()
        } else {
            trimmed.to_string()
        };
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let id = format!("pl-{now_ms:x}-{:08x}", next_pseudo_rand(u32::MAX as usize));
        let mut ids = track_ids.unwrap_or_default();
        if let Some(tid) = initial_track_id
            && !ids.contains(&tid) {
                ids.push(tid);
            }
        let created = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.library.playlists.insert(
            0,
            Playlist {
                id: id.clone(),
                name: final_name.clone(),
                ids,
                created,
                artwork_url,
                section: Some(section),
            },
        );
        self.mark_dirty();
        let msg = self.tf(Key::PlaylistCreated, &[("name", &final_name)]);
        self.toast(msg, cx);
        cx.notify();
        id
    }

    pub fn rename_playlist(&mut self, id: &str, name: String, cx: &mut Context<Self>) {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        if let Some(pl) = self.library.playlists.iter_mut().find(|p| p.id == id) {
            pl.name = trimmed;
            self.mark_dirty();
            cx.notify();
        }
    }

    pub fn delete_playlist(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.library.playlists.retain(|p| p.id != id);
        if self.route == Route::Playlist(id.to_string()) {
            self.navigate(Route::Home, window, cx);
        }
        self.mark_dirty();
        cx.notify();
    }

    pub fn move_playlist_section(&mut self, id: &str, section: PlaylistSection, cx: &mut Context<Self>) {
        if let Some(pl) = self.library.playlists.iter_mut().find(|p| p.id == id) {
            pl.section = Some(section);
            self.mark_dirty();
            cx.notify();
        }
    }

    pub fn add_track_to_playlist(&mut self, playlist_id: &str, track: Track, cx: &mut Context<Self>) {
        self.library.catalog.insert(track.id.clone(), track.clone());
        let pl_name = if let Some(pl) = self.library.playlists.iter_mut().find(|p| p.id == playlist_id) {
            if !pl.ids.contains(&track.id) {
                pl.ids.push(track.id.clone());
            }
            if pl.artwork_url.is_none() {
                pl.artwork_url = track.cover.clone().or(track.thumb.clone());
            }
            Some(pl.name.clone())
        } else {
            None
        };
        if let Some(name) = pl_name {
            self.mark_dirty();
            let msg = self.tf(Key::AddedTo, &[("name", &name)]);
            self.toast(msg, cx);
            cx.notify();
        }
    }

    pub fn remove_track_from_playlist(&mut self, playlist_id: &str, track_id: &str, cx: &mut Context<Self>) {
        let pl_name = if let Some(pl) = self.library.playlists.iter_mut().find(|p| p.id == playlist_id) {
            pl.ids.retain(|id| id != track_id);
            Some(pl.name.clone())
        } else {
            None
        };
        if let Some(name) = pl_name {
            self.mark_dirty();
            let msg = self.tf(Key::RemovedFrom, &[("name", &name)]);
            self.toast(msg, cx);
            cx.notify();
        }
    }

    // ---- Search ---------------------------------------------------------------------------------

    pub fn set_search_query(&mut self, q: String, cx: &mut Context<Self>) {
        self.search_q = q.clone();
        if q.trim().is_empty() {
            self.search_sc_tracks.clear();
            self.search_yt_tracks.clear();
            self.search_suggestions.clear();
            self.search_error = None;
            self.search_loading = false;
            cx.notify();
            return;
        }
        self.search_seq += 1;
        let seq = self.search_seq;
        let q_clone = q.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(260)).await;
            let _ = this.update(cx, |s, cx| {
                if s.search_seq == seq {
                    s.run_search_now(&q_clone, cx);
                }
            });
        })
        .detach();
        cx.notify();
    }

    pub fn run_search_now(&mut self, raw_q: &str, cx: &mut Context<Self>) {
        let q = raw_q.trim().to_string();
        if q.is_empty() {
            return;
        }
        self.search_q = q.clone();
        self.search_loading = true;
        self.search_error = None;
        self.search_seq += 1;
        let seq = self.search_seq;
        let backend = self.backend.clone();
        let yt_proxy = self.yt_proxy.clone();

        self.spawn_tokio(
            cx,
            async move {
                let (sc_res, yt_res, sug_res) = tokio::join!(
                    backend.call("search.tracks", serde_json::json!({ "query": q })),
                    search_yt_tracks(&yt_proxy, &q),
                    yt_search_suggestions(&yt_proxy, &q),
                );
                let sc_tracks = sc_res.as_ref().ok().map(parse_sc_tracks_from_value).unwrap_or_default();
                let yt_tracks = yt_res
                    .as_ref()
                    .ok()
                    .map(|v| v.iter().cloned().map(yt_search_to_track).collect::<Vec<_>>())
                    .unwrap_or_default();
                let suggestions = sug_res.map(|s| s.queries).unwrap_or_default();
                let both_failed = sc_res.is_err() && yt_res.is_err();
                (sc_tracks, yt_tracks, suggestions, both_failed)
            },
            move |this, (sc_tracks, yt_tracks, suggestions, both_failed), cx| {
                if this.search_seq != seq {
                    return;
                }
                this.search_loading = false;
                this.add_tracks_to_catalog(&sc_tracks);
                this.add_tracks_to_catalog(&yt_tracks);
                this.search_sc_tracks = sc_tracks;
                this.search_yt_tracks = yt_tracks;
                this.search_suggestions = suggestions;
                this.search_error = both_failed.then(|| this.t(Key::LoadError).to_string());
                cx.notify();
            },
        );
        cx.notify();
    }

    // ---- Providers ------------------------------------------------------------------------------

    pub fn login_soundcloud(&mut self, cx: &mut Context<Self>) {
        if self.sc_logging_in {
            return;
        }
        self.sc_logging_in = true;
        let backend = self.backend.clone();
        self.spawn_tokio(
            cx,
            async move {
                let cap = launch_soundcloud_auth().await?;
                let Some(cap) = cap else {
                    return Ok(None);
                };
                backend
                    .call(
                        "settings.update",
                        serde_json::json!({ "clientId": cap.client_id }),
                    )
                    .await?;
                let v = backend
                    .call("auth.login", serde_json::json!({ "token": cap.token }))
                    .await?;
                let status: AuthStatus = serde_json::from_value(v).map_err(|e| e.to_string())?;
                Ok::<_, String>(Some(status))
            },
            |this, res, cx| {
                this.sc_logging_in = false;
                match res {
                    Ok(Some(st)) => {
                        this.sc_authorized = st.authorized;
                        this.sc_profile = st.profile;
                        let msg = this.t(Key::ScConnectedMsg);
                        this.toast(msg, cx);
                        this.refresh_soundcloud(false, cx);
                    }
                    Ok(None) => {}
                    Err(e) => this.toast(e, cx),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn login_soundcloud_with_token(&mut self, token: String, cx: &mut Context<Self>) {
        let trimmed = token.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        self.sc_logging_in = true;
        let backend = self.backend.clone();
        self.spawn_tokio(
            cx,
            async move {
                let v = backend
                    .call("auth.login", serde_json::json!({ "token": trimmed }))
                    .await?;
                serde_json::from_value::<AuthStatus>(v).map_err(|e| e.to_string())
            },
            |this, res, cx| {
                this.sc_logging_in = false;
                match res {
                    Ok(st) => {
                        this.sc_authorized = st.authorized;
                        this.sc_profile = st.profile;
                        let msg = this.t(Key::ScConnectedMsg);
                        this.toast(msg, cx);
                        this.refresh_soundcloud(false, cx);
                    }
                    Err(e) => this.toast(e, cx),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn logout_soundcloud(&mut self, cx: &mut Context<Self>) {
        let backend = self.backend.clone();
        self.sc_authorized = false;
        self.sc_profile = None;
        self.library.soundcloud_liked.clear();
        self.library.soundcloud_playlists.clear();
        self.library.soundcloud_playlist_tracks.clear();
        self.mark_dirty();
        self.spawn_tokio(
            cx,
            async move { backend.call("auth.logout", Value::Null).await },
            |this, _, cx| {
                let msg = this.t(Key::ProviderDisconnectedMsg);
                this.toast(msg, cx);
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn refresh_soundcloud(&mut self, show_toast: bool, cx: &mut Context<Self>) {
        if !self.sc_authorized || self.sc_loading_lib {
            return;
        }
        self.sc_loading_lib = true;
        let backend = self.backend.clone();
        self.spawn_tokio(
            cx,
            async move {
                let uid_val = backend
                    .call("auth.refresh", Value::Null)
                    .await
                    .ok()
                    .and_then(|v| serde_json::from_value::<AuthStatus>(v).ok());
                let uid = uid_val.as_ref().and_then(|a| a.profile.as_ref()).map(|p| p.id).unwrap_or(0);
                let (likes_v, pls_v, mine_v) = tokio::join!(
                    backend.call("user.likes", serde_json::json!({ "userId": uid })),
                    backend.call("playlists.mine", Value::Null),
                    backend.call("tracks.mine", Value::Null),
                );
                let likes = likes_v.ok().map(|v| parse_sc_tracks_from_value(&v)).unwrap_or_default();
                let playlists = pls_v.ok().map(|v| parse_sc_playlists_from_value(&v)).unwrap_or_default();
                let mine = mine_v.ok().map(|v| parse_sc_tracks_from_value(&v)).unwrap_or_default();
                (uid_val, likes, playlists, mine)
            },
            move |this, (status, likes, playlists, mine), cx| {
                this.sc_loading_lib = false;
                if let Some(st) = status {
                    this.sc_authorized = st.authorized;
                    this.sc_profile = st.profile;
                }
                this.add_tracks_to_catalog(&likes);
                this.add_tracks_to_catalog(&mine);
                this.library.soundcloud_liked = likes;
                this.library.soundcloud_playlists = playlists;
                this.sc_tracks_mine = mine;
                this.mark_dirty();
                if show_toast {
                    let msg = this.t(Key::ScRefreshedMsg);
                    this.toast(msg, cx);
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn load_soundcloud_playlist_tracks(&mut self, urn: String, cx: &mut Context<Self>) {
        if self.sc_active_playlist_loading.contains(&urn) {
            return;
        }
        self.sc_active_playlist_loading.insert(urn.clone());
        let backend = self.backend.clone();
        let urn_clone = urn.clone();
        self.spawn_tokio(
            cx,
            async move {
                let v = backend
                    .call("playlist.tracks", serde_json::json!({ "playlistUrn": urn_clone }))
                    .await
                    .ok();
                v.map(|v| parse_sc_tracks_from_value(&v)).unwrap_or_default()
            },
            move |this, tracks, cx| {
                this.sc_active_playlist_loading.remove(&urn);
                this.add_tracks_to_catalog(&tracks);
                this.library.soundcloud_playlist_tracks.insert(urn, tracks);
                this.mark_dirty();
                cx.notify();
            },
        );
    }

    pub fn login_ytmusic(&mut self, cx: &mut Context<Self>) {
        if self.yt_logging_in {
            return;
        }
        self.yt_logging_in = true;
        let yt_proxy = self.yt_proxy.clone();
        let yt_store = self.yt_store.clone();
        self.spawn_tokio(
            cx,
            async move {
                let Some(headers) = launch_ytmusic_auth().await? else {
                    return Ok(None);
                };
                let auth = yt_auth_save(&yt_proxy, headers).await?;
                let lib = yt_library_sync(&yt_proxy, &yt_store).await.ok();
                Ok::<_, String>(Some((auth, lib)))
            },
            |this, res, cx| {
                this.yt_logging_in = false;
                match res {
                    Ok(Some((auth, lib))) => {
                        this.library.ytmusic_authorized = auth.authorized;
                        if let Some(p) = auth.profile {
                            this.library.ytmusic_account_name = p.name;
                            this.library.ytmusic_account_handle = p.handle;
                        }
                        if let Some(lib) = lib {
                            this.apply_yt_library_dto(lib);
                        } else {
                            this.mark_dirty();
                        }
                        let msg = this.t(Key::YtConnectedMsg);
                        this.toast(msg, cx);
                    }
                    Ok(None) => {}
                    Err(e) => this.toast(e, cx),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn refresh_ytmusic(&mut self, show_toast: bool, cx: &mut Context<Self>) {
        if !self.library.ytmusic_authorized || self.yt_loading_lib {
            return;
        }
        self.yt_loading_lib = true;
        let yt_proxy = self.yt_proxy.clone();
        let yt_store = self.yt_store.clone();
        self.spawn_tokio(
            cx,
            async move { yt_library_sync(&yt_proxy, &yt_store).await },
            move |this, res, cx| {
                this.yt_loading_lib = false;
                if let Ok(lib) = res {
                    this.apply_yt_library_dto(lib);
                    if show_toast {
                        let msg = this.t(Key::YtRefreshedMsg);
                        this.toast(msg, cx);
                    }
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn logout_ytmusic(&mut self, cx: &mut Context<Self>) {
        let yt_store = self.yt_store.clone();
        self.library.ytmusic_authorized = false;
        self.library.ytmusic_account_name.clear();
        self.library.ytmusic_account_handle.clear();
        self.library.ytmusic_liked.clear();
        self.library.ytmusic_playlists.clear();
        self.library.ytmusic_playlist_tracks.clear();
        self.mark_dirty();
        self.spawn_tokio(
            cx,
            async move { yt_auth_logout(&yt_store).await },
            |this, _, cx| {
                let msg = this.t(Key::ProviderDisconnectedMsg);
                this.toast(msg, cx);
                cx.notify();
            },
        );
        cx.notify();
    }

    fn apply_yt_library_dto(&mut self, lib: resonance_core::yt::music_api::YtMusicLibraryDto) {
        self.library.ytmusic_account_name = lib.profile.name;
        self.library.ytmusic_account_handle = lib.profile.handle;
        let liked: Vec<Track> = lib.liked_songs.into_iter().map(yt_music_track_to_track).collect();
        self.add_tracks_to_catalog(&liked);
        self.library.ytmusic_liked = liked;
        self.library.ytmusic_playlists = lib
            .playlists
            .into_iter()
            .map(|p| {
                if let Some(ref art) = p.artwork_url {
                    self.library.ytmusic_playlist_art.insert(p.playlist_id.clone(), art.clone());
                }
                YtMusicPlaylist {
                    playlist_id: p.playlist_id,
                    title: p.title,
                    artwork_url: p.artwork_url,
                    track_count: p.track_count as i64,
                }
            })
            .collect();
        self.mark_dirty();
    }

    pub fn load_yt_playlist_tracks(&mut self, pid: String, cx: &mut Context<Self>) {
        if self.yt_active_playlist_loading.contains(&pid) {
            return;
        }
        self.yt_active_playlist_loading.insert(pid.clone());
        let yt_proxy = self.yt_proxy.clone();
        let yt_store = self.yt_store.clone();
        let pid_clone = pid.clone();
        self.spawn_tokio(
            cx,
            async move {
                let cached = yt_playlist_tracks_cached(&yt_store, pid_clone.clone()).await.ok().flatten();
                let synced = yt_playlist_tracks_sync(&yt_proxy, &yt_store, pid_clone.clone()).await.ok();
                let dto = synced.or(cached);
                let art = yt_playlist_artwork(&yt_proxy, &yt_store, pid_clone).await.ok().flatten();
                (dto, art)
            },
            move |this, (dto, art), cx| {
                this.yt_active_playlist_loading.remove(&pid);
                if let Some(a) = art {
                    this.library.ytmusic_playlist_art.insert(pid.clone(), a);
                }
                if let Some(pl) = dto
                    && let Some(tracks_dto) = pl.tracks {
                        let tracks: Vec<Track> = tracks_dto.into_iter().map(yt_music_track_to_track).collect();
                        this.add_tracks_to_catalog(&tracks);
                        this.library.ytmusic_playlist_tracks.insert(pid, tracks);
                    }
                this.mark_dirty();
                cx.notify();
            },
        );
    }

    // ---- Lyrics ---------------------------------------------------------------------------------

    pub fn ensure_lyrics_for_track(&mut self, track: &Track, force: bool, cx: &mut Context<Self>) {
        if let Some(over) = self.manual_lyrics.get(&track.id)
            && let Some(mut data) = lyrics_data_from_record(over) {
                data.preview = track.preview.unwrap_or(false);
                self.lyrics_cache.insert(track.id.clone(), Some(data));
                return;
            }
        if let Some(ref pre_lines) = track.lyrics {
            self.lyrics_cache.insert(
                track.id.clone(),
                Some(LyricsData {
                    synced: Some(pre_lines.clone()),
                    preview: track.preview.unwrap_or(false),
                    ..Default::default()
                }),
            );
            return;
        }
        if !force && self.lyrics_cache.contains_key(&track.id) {
            return;
        }
        if self.lyrics_loading.contains(&track.id) {
            return;
        }
        self.lyrics_loading.insert(track.id.clone());
        let tid = track.id.clone();
        let track_clone = track.clone();
        let backend = self.backend.clone();
        let http = shared_reqwest();

        self.spawn_tokio(
            cx,
            async move {
                if track_clone.source == Source::SoundCloud
                    && let Some(sc_num) = track_clone
                        .native_id
                        .as_deref()
                        .and_then(|s| s.rsplit(':').next())
                        .and_then(|n| n.parse::<i64>().ok())
                    {
                        let dur_ms = (to_seconds(track_clone.full_duration.unwrap_or(track_clone.duration)) * 1000.0).round() as i64;
                        if let Ok(v) = backend
                            .call(
                                "track.lyrics",
                                serde_json::json!({
                                    "trackId": sc_num,
                                    "title": track_clone.title,
                                    "artist": track_clone.artist,
                                    "durationMs": dur_ms
                                }),
                            )
                            .await
                        {
                            let is_synced = v.get("isSynced").and_then(|x| x.as_bool()).unwrap_or(false);
                            let lines_v = v.get("lines").and_then(|x| x.as_array()).cloned().unwrap_or_default();
                            if !lines_v.is_empty() {
                                if is_synced {
                                    let lines: Vec<LyricLine> = lines_v
                                        .iter()
                                        .map(|l| LyricLine {
                                            t: l.get("startMs").and_then(|x| x.as_f64()).unwrap_or(0.0) / 1000.0,
                                            text: l.get("text").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
                                            gap: false,
                                        })
                                        .collect();
                                    let gapped = with_gaps(lines);
                                    if !gapped.is_empty() {
                                        return Some(LyricsData {
                                            synced: Some(gapped),
                                            preview: track_clone.preview.unwrap_or(false),
                                            ..Default::default()
                                        });
                                    }
                                } else {
                                    let plain: Vec<String> = lines_v
                                        .iter()
                                        .filter_map(|l| l.get("text").and_then(|x| x.as_str()))
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                        .map(str::to_string)
                                        .collect();
                                    if !plain.is_empty() {
                                        return Some(LyricsData {
                                            plain: Some(plain),
                                            preview: track_clone.preview.unwrap_or(false),
                                            ..Default::default()
                                        });
                                    }
                                }
                            }
                        }
                    }
                let mut data = fetch_lrclib_lyrics(&http, &track_clone).await;
                if let Some(ref mut d) = data {
                    d.preview = track_clone.preview.unwrap_or(false);
                }
                data
            },
            move |this, data, cx| {
                this.lyrics_loading.remove(&tid);
                this.lyrics_cache.insert(tid, data);
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn open_lyrics_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(tr) = self.current_track().cloned() {
            let init_q = format!("{} — {}", tr.artist, tr.title);
            self.lyrics_search_input.update(cx, |s, cx| s.set_value(&init_q, window, cx));
            self.lyrics_search_open = true;
            self.search_lyrics_manual(init_q, cx);
        }
    }

    pub fn search_lyrics_manual(&mut self, q: String, cx: &mut Context<Self>) {
        let trimmed = q.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        self.lyrics_search_loading = true;
        let http = shared_reqwest();
        self.spawn_tokio(
            cx,
            async move { search_lyrics_manual(&http, &trimmed).await },
            |this, items, cx| {
                this.lyrics_search_loading = false;
                this.lyrics_search_results = items;
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn apply_manual_lyrics(&mut self, choice: ManualLyricsChoice, cx: &mut Context<Self>) {
        let Some(tr) = self.current_track().cloned() else { return };
        self.manual_lyrics.insert(tr.id.clone(), choice.clone());
        if let Some(mut data) = lyrics_data_from_record(&choice) {
            data.preview = tr.preview.unwrap_or(false);
            self.lyrics_cache.insert(tr.id.clone(), Some(data));
        }
        self.lyrics_search_open = false;
        self.mark_dirty();
        cx.notify();
    }

    pub fn reset_manual_lyrics(&mut self, cx: &mut Context<Self>) {
        let Some(tr) = self.current_track().cloned() else { return };
        self.manual_lyrics.remove(&tr.id);
        self.lyrics_cache.remove(&tr.id);
        self.mark_dirty();
        self.ensure_lyrics_for_track(&tr, true, cx);
        cx.notify();
    }

    // ---- External Playlist Import & Review ------------------------------------------------------

    pub fn start_import(
        &mut self,
        mode: ImportDialogMode,
        input: String,
        custom_name: String,
        cx: &mut Context<Self>,
    ) {
        if self.import_job.running {
            let msg = self.t(Key::ImportAlreadyRunning);
            self.toast(msg, cx);
            return;
        }
        let trimmed = input.trim().to_string();
        if trimmed.is_empty() {
            let msg = self.t(if mode == ImportDialogMode::Link {
                Key::ImportPasteLinkFirst
            } else {
                Key::ImportEnterUserFirst
            });
            self.toast(msg, cx);
            return;
        }

        self.import_job = ImportJobState {
            running: true,
            phase: Some(ImportPhase::Fetching),
            ..Default::default()
        };
        let backend = self.backend.clone();
        let yt_proxy = self.yt_proxy.clone();
        let prog_tx = self.import_prog_tx.clone();

        self.spawn_tokio(
            cx,
            async move {
                let (title, raw_tracks): (String, Vec<ExternalPlaylistTrackDto>) = match mode {
                    ImportDialogMode::Link => {
                        let dto = fetch_external_playlist(trimmed.clone()).await?;
                        (dto.title, dto.tracks)
                    }
                    ImportDialogMode::ScLikes => {
                        let v = backend
                            .call("user.likes.by.input", serde_json::json!({ "input": trimmed }))
                            .await?;
                        let tracks = v
                            .get("tracks")
                            .and_then(|x| x.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|t| {
                                        Some(ExternalPlaylistTrackDto {
                                            title: t.get("title")?.as_str()?.to_string(),
                                            artist: t.pointer("/user/username").and_then(|u| u.as_str()).unwrap_or("SoundCloud").to_string(),
                                            album: None,
                                            duration_ms: t.get("duration").and_then(|d| d.as_i64()).unwrap_or(0),
                                            artwork_url: t.get("artworkUrl").and_then(|a| a.as_str()).map(str::to_string),
                                            native_id: None,
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let label = v
                            .get("username")
                            .and_then(|u| u.as_str())
                            .map(|u| format!("{u} — Likes"))
                            .unwrap_or_else(|| "SoundCloud Likes".to_string());
                        (label, tracks)
                    }
                };

                let final_title = if !custom_name.trim().is_empty() {
                    custom_name.trim().to_string()
                } else {
                    title
                };

                let total = raw_tracks.len();
                let mut items = Vec::with_capacity(total);
                for (idx, src) in raw_tracks.into_iter().enumerate() {
                    let _ = prog_tx.send((ImportPhase::Matching, idx + 1, total));
                    if let Some(vid) = src.native_id.as_deref().filter(|s| !s.is_empty()) {
                        let direct = Track {
                            id: format!("yt:{vid}"),
                            title: src.title.clone(),
                            artist: src.artist.clone(),
                            album: src.album.clone(),
                            cover: src.artwork_url.clone(),
                            thumb: src.artwork_url.clone(),
                            src: String::new(),
                            duration: src.duration_ms as f64 / 1000.0,
                            full_duration: None,
                            native_id: Some(vid.to_string()),
                            preview: None,
                            playback: Some("direct".into()),
                            source: Source::YouTube,
                            lyrics: None,
                        };
                        items.push(ImportReviewItem {
                            source: src,
                            reason: ImportReviewReason::AutoMatched,
                            score: 100,
                            selected: Some(direct),
                            accepted: true,
                        });
                        continue;
                    }

                    let src_input = SourceTrackInput {
                        title: src.title.clone(),
                        artist: src.artist.clone(),
                        album: src.album.clone(),
                        duration_ms: src.duration_ms as f64,
                        artwork_url: src.artwork_url.clone(),
                    };
                    let queries = youtube_fallback_queries(&src.title, &src.artist);
                    let q0 = queries.into_iter().next().unwrap_or_else(|| src.title.clone());
                    let (yt_r, sc_r) = tokio::join!(
                        search_yt_tracks(&yt_proxy, &q0),
                        backend.call("search.tracks", serde_json::json!({ "query": q0 })),
                    );
                    let mut cands: Vec<Track> = yt_r
                        .as_ref()
                        .ok()
                        .map(|v| v.iter().cloned().map(yt_search_to_track).collect())
                        .unwrap_or_default();
                    if let Ok(scv) = sc_r.as_ref() {
                        cands.extend(parse_sc_tracks_from_value(scv));
                    }
                    let outcome = classify_match_candidates(&src_input, &cands, yt_r.is_err() && sc_r.is_err());
                    let accepted = outcome.reason == ImportReviewReason::AutoMatched;
                    items.push(ImportReviewItem {
                        source: src,
                        reason: outcome.reason,
                        score: outcome.score,
                        selected: outcome.best,
                        accepted,
                    });
                }

                let _ = prog_tx.send((ImportPhase::Saving, total, total));
                Ok::<_, String>((final_title, items))
            },
            |this, res, cx| {
                this.import_job.running = false;
                this.import_job.phase = None;
                match res {
                    Ok((title, items)) => {
                        let needs_review = items.iter().any(|i| i.reason != ImportReviewReason::AutoMatched);
                        if !needs_review {
                            let tracks: Vec<Track> = items.into_iter().filter_map(|i| i.selected).collect();
                            this.add_tracks_to_catalog(&tracks);
                            let ids: Vec<String> = tracks.iter().map(|t| t.id.clone()).collect();
                            let count_s = ids.len().to_string();
                            let art = tracks.first().and_then(|t| t.cover.clone().or_else(|| t.thumb.clone()));
                            let pid = this.create_playlist(
                                title.clone(),
                                None,
                                PlaylistSection::Local,
                                art,
                                Some(ids),
                                cx,
                            );
                            this.dialog = None;
                            let msg = this.tf(Key::ImportDoneToast, &[("name", &title), ("count", &count_s)]);
                            let btn = this.t(Key::ImportOpenPlaylist).to_string();
                            this.toast_with_action(
                                msg,
                                Some(btn),
                                Some(SnackActionKind::OpenPlaylist),
                                Some(pid),
                                cx,
                            );
                        } else {
                            let need_cnt = items
                                .iter()
                                .filter(|i| i.reason != ImportReviewReason::AutoMatched)
                                .count()
                                .to_string();
                            let bg = this.dialog.is_none();
                            this.import_job.review_title = title;
                            this.import_job.review_items = items;
                            if bg {
                                let msg = this.tf(Key::ImportNeedsReview, &[("count", &need_cnt)]);
                                let btn = this.t(Key::ImportReviewBtn).to_string();
                                this.toast_with_action(
                                    msg,
                                    Some(btn),
                                    Some(SnackActionKind::OpenImportReview),
                                    None,
                                    cx,
                                );
                            } else {
                                this.dialog = Some(DialogKind::ImportReview);
                            }
                        }
                    }
                    Err(e) => {
                        this.import_job.error = Some(e.clone());
                        this.toast(e, cx);
                    }
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn apply_import_review(&mut self, cx: &mut Context<Self>) {
        self.audio.stop_preview();
        self.preview_track_id = None;
        let selected: Vec<Track> = self
            .import_job
            .review_items
            .iter()
            .filter(|i| i.accepted)
            .filter_map(|i| i.selected.clone())
            .collect();
        if selected.is_empty() {
            let msg = self.t(Key::ImportNoTracksSelected);
            self.toast(msg, cx);
            return;
        }
        let title = self.import_job.review_title.clone();
        self.add_tracks_to_catalog(&selected);
        let ids: Vec<String> = selected.iter().map(|t| t.id.clone()).collect();
        let art = selected.first().and_then(|t| t.cover.clone().or_else(|| t.thumb.clone()));
        let count_s = ids.len().to_string();
        let pid = self.create_playlist(title.clone(), None, PlaylistSection::Local, art, Some(ids), cx);
        self.import_job.review_items.clear();
        self.dialog = None;
        let msg = self.tf(Key::ImportDoneToast, &[("name", &title), ("count", &count_s)]);
        let btn = self.t(Key::ImportOpenPlaylist).to_string();
        self.toast_with_action(msg, Some(btn), Some(SnackActionKind::OpenPlaylist), Some(pid), cx);
        cx.notify();
    }

    pub fn review_search_alternative(&mut self, idx: usize, q: String, cx: &mut Context<Self>) {
        let trimmed = q.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        self.import_job.review_alt_open_idx = Some(idx);
        self.import_job.review_alt_loading = true;
        let backend = self.backend.clone();
        let yt_proxy = self.yt_proxy.clone();
        self.spawn_tokio(
            cx,
            async move {
                let (yt_r, sc_r) = tokio::join!(
                    search_yt_tracks(&yt_proxy, &trimmed),
                    backend.call("search.tracks", serde_json::json!({ "query": trimmed })),
                );
                let mut out: Vec<Track> = yt_r
                    .ok()
                    .map(|v| v.into_iter().map(yt_search_to_track).collect())
                    .unwrap_or_default();
                if let Ok(scv) = sc_r {
                    out.extend(parse_sc_tracks_from_value(&scv));
                }
                out
            },
            |this, tracks, cx| {
                this.import_job.review_alt_loading = false;
                this.import_job.review_alt_results = tracks;
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn toggle_preview_track(&mut self, track: Track, cx: &mut Context<Self>) {
        if self.preview_track_id.as_deref() == Some(&track.id) {
            self.audio.stop_preview();
            self.preview_track_id = None;
            cx.notify();
            return;
        }
        let pid = track.id.clone();
        self.preview_track_id = Some(pid.clone());
        let backend = self.backend.clone();
        let yt_proxy = self.yt_proxy.clone();
        self.spawn_tokio(
            cx,
            async move { resolve_playable_stream(&backend, &yt_proxy, &track).await },
            move |this, res, cx| {
                if this.preview_track_id.as_deref() != Some(&pid) {
                    return;
                }
                if let Ok(ResolvedPlayback::Ready { url, .. }) = res {
                    this.audio.start_preview(url);
                } else {
                    this.preview_track_id = None;
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    // ---- Shortcuts & Global Hotkey --------------------------------------------------------------

    pub fn register_global_mute_hotkey(&mut self) {
        let Some(ref mgr) = self.hotkey_manager else { return };
        if let Some(prev) = self.registered_mute_hotkey.take() {
            let _ = mgr.unregister(prev);
        }
        let raw = self.shortcuts.get(ShortcutId::Mute);
        if let Ok(hk) = HotKey::from_str(&raw.to_ascii_lowercase().replace("meta+", "super+"))
            && mgr.register(hk).is_ok() {
                self.registered_mute_hotkey = Some(hk);
            }
    }

    pub fn update_shortcut(&mut self, id: ShortcutId, binding: String, cx: &mut Context<Self>) {
        let norm = normalize_shortcut(&binding);
        if !is_valid_shortcut(&norm) {
            return;
        }
        if self.shortcuts.has_duplicate(id, &norm) {
            self.shortcut_error = Some(self.t(Key::ShortcutDuplicate).to_string());
            cx.notify();
            return;
        }
        self.shortcut_error = None;
        self.shortcuts.set(id, norm);
        self.recording_shortcut = None;
        if id == ShortcutId::Mute {
            self.register_global_mute_hotkey();
        }
        self.mark_dirty();
        cx.notify();
    }

    // ---- Updates & Cache ------------------------------------------------------------------------

    pub fn check_updates_now(&mut self, cx: &mut Context<Self>) {
        self.update_state.checking = true;
        let http = shared_reqwest();
        self.spawn_tokio(
            cx,
            async move { check_for_updates(&http).await },
            |this, st, cx| {
                this.update_state = st;
                this.mark_dirty();
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn open_update_release(&mut self) {
        open_release_page(&self.update_state.download_url);
        let _ = restart_app;
    }

    pub fn run_clear_cache(&mut self, cx: &mut Context<Self>) {
        let yt_proxy = self.yt_proxy.clone();
        let yt_store = self.yt_store.clone();
        let backend = self.backend.clone();
        self.spawn_tokio(
            cx,
            async move {
                let r1 = yt_clear_cache(&yt_proxy, &yt_store).await;
                let r2 = backend.call("cache.clear", Value::Null).await;
                r1.and(r2)
            },
            |this, res, cx| {
                this.dialog = None;
                this.palette_cache.clear();
                this.lyrics_cache.clear();
                match res {
                    Ok(_) => {
                        let msg = this.t(Key::ClearCacheDone);
                        this.toast(msg, cx);
                    }
                    Err(e) => {
                        let msg = this.tf(Key::ClearCacheError, &[("reason", &e)]);
                        this.toast(msg, cx);
                    }
                }
                cx.notify();
            },
        );
    }

    pub fn run_uninstall(&mut self, cx: &mut Context<Self>) {
        self.flush_save();
        if let Err(e) = uninstall_app() {
            self.dialog = None;
            self.toast(e, cx);
        }
    }
}

struct PlayingState {
    is_playing: bool,
}

// ---- Stream resolution + DTO conversion helpers -------------------------------------------------

enum ResolvedPlayback {
    Ready { url: String, updated_track: Box<Track> },
    FallbackNotFound,
}

async fn resolve_playable_stream(
    backend: &Backend,
    yt_proxy: &YtStreamProxy,
    track: &Track,
) -> Result<ResolvedPlayback, String> {
    if let Some(vid) = track.yt_video_id() {
        let res = resolve_yt_stream_url(yt_proxy, vid.to_string(), None, None, Some(true)).await?;
        let mut updated = track.clone();
        updated.src = res.url.clone();
        return Ok(ResolvedPlayback::Ready {
            url: res.url,
            updated_track: Box::new(updated),
        });
    }

    let urn = track
        .native_id
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| track.id.strip_prefix("sc:").map(|s| format!("soundcloud:tracks:{s}")))
        .unwrap_or_else(|| track.id.clone());

    let v = backend
        .call("track.stream", serde_json::json!({ "trackUrn": urn }))
        .await?;
    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let preview = v.get("preview").and_then(|x| x.as_bool()).unwrap_or(false);
    let need_fallback = url.is_empty()
        || (preview && track.duration > 75.0);

    if !need_fallback {
        let mut updated = track.clone();
        updated.src = url.clone();
        updated.preview = Some(preview);
        return Ok(ResolvedPlayback::Ready {
            url,
            updated_track: Box::new(updated),
        });
    }

    // Automatic YouTube fallback when SoundCloud returns 30s go+ preview
    let queries = youtube_fallback_queries(&track.title, &track.artist);
    for q in queries {
        if let Ok(cands) = search_yt_tracks(yt_proxy, &q).await {
            let view: Vec<YtCandidate<'_>> = cands
                .iter()
                .map(|c| YtCandidate {
                    title: &c.title,
                    artist: &c.artist,
                    duration_ms: c.duration_ms as f64,
                })
                .collect();
            if let Some(idx) = find_youtube_fallback_candidate_idx(&track.title, &track.artist, track.duration, &view) {
                let chosen = &cands[idx];
                let res = resolve_yt_stream_url(yt_proxy, chosen.native_id.clone(), None, None, Some(true)).await?;
                let mut updated = track.clone();
                updated.native_id = Some(chosen.native_id.clone());
                updated.source = Source::YouTube;
                updated.playback = Some("direct".into());
                updated.preview = Some(false);
                updated.src = res.url.clone();
                if chosen.duration_ms > 0 {
                    updated.duration = chosen.duration_ms as f64 / 1000.0;
                }
                return Ok(ResolvedPlayback::Ready {
                    url: res.url,
                    updated_track: Box::new(updated),
                });
            }
        }
    }

    if !url.is_empty() {
        let mut updated = track.clone();
        updated.src = url.clone();
        updated.preview = Some(true);
        return Ok(ResolvedPlayback::Ready {
            url,
            updated_track: Box::new(updated),
        });
    }
    Ok(ResolvedPlayback::FallbackNotFound)
}

fn upscale_sc_art(url: &str) -> Option<String> {
    if url.trim().is_empty() {
        return None;
    }
    if url.contains("-large.") {
        Some(url.replacen("-large.", "-t500x500.", 1))
    } else {
        Some(url.to_string())
    }
}

pub fn parse_sc_tracks_from_value(v: &Value) -> Vec<Track> {
    let arr = v
        .as_array()
        .or_else(|| v.get("tracks").and_then(|t| t.as_array()))
        .or_else(|| v.get("collection").and_then(|c| c.as_array()));
    let Some(items) = arr else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let num_id = item.get("id").and_then(|x| x.as_i64())?;
            let title = item.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            if title.is_empty() {
                return None;
            }
            let artist = item
                .pointer("/user/username")
                .and_then(|x| x.as_str())
                .unwrap_or("SoundCloud")
                .to_string();
            let raw_dur = item.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let duration = to_seconds(raw_dur);
            let raw_art = item.get("artworkUrl").and_then(|x| x.as_str()).unwrap_or("");
            let cover = upscale_sc_art(raw_art);
            let urn = item
                .get("trackUrn")
                .or_else(|| item.get("urn"))
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("soundcloud:tracks:{num_id}"));
            let src = item.get("permalinkUrl").and_then(|x| x.as_str()).unwrap_or("").to_string();
            Some(Track {
                id: format!("sc:{num_id}"),
                title,
                artist,
                album: None,
                cover: cover.clone(),
                thumb: cover,
                src,
                duration,
                full_duration: Some(duration),
                native_id: Some(urn),
                preview: None,
                playback: None,
                source: Source::SoundCloud,
                lyrics: None,
            })
        })
        .collect()
}

pub fn parse_sc_playlists_from_value(v: &Value) -> Vec<SoundCloudPlaylist> {
    let Some(items) = v.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .and_then(|x| x.as_str().map(str::to_string).or_else(|| x.as_i64().map(|n| n.to_string())))?;
            let name = item.get("title").and_then(|x| x.as_str())?.to_string();
            let urn = item.get("urn").and_then(|x| x.as_str()).unwrap_or(&id).to_string();
            let art = item.get("artworkUrl").and_then(|x| x.as_str()).and_then(upscale_sc_art);
            let permalink = item.get("permalinkUrl").and_then(|x| x.as_str()).map(str::to_string);
            let track_count = item.get("trackCount").and_then(|x| x.as_i64()).unwrap_or(0);
            let username = item
                .pointer("/user/username")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            Some(SoundCloudPlaylist {
                id,
                urn,
                name,
                artwork_url: art,
                permalink_url: permalink,
                track_count,
                username,
            })
        })
        .collect()
}

pub fn yt_search_to_track(dto: YtSearchTrackDto) -> Track {
    let cover = if dto.artwork_url.is_empty() {
        Some(format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", dto.native_id))
    } else {
        Some(dto.artwork_url)
    };
    Track {
        id: format!("yt:{}", dto.native_id),
        title: dto.title,
        artist: dto.artist,
        album: None,
        cover: cover.clone(),
        thumb: cover,
        src: dto.permalink,
        duration: (dto.duration_ms as f64) / 1000.0,
        full_duration: None,
        native_id: Some(dto.native_id),
        preview: None,
        playback: Some("direct".into()),
        source: Source::YouTube,
        lyrics: None,
    }
}

pub fn yt_music_track_to_track(dto: YtMusicTrackDto) -> Track {
    let cover = dto
        .artwork_url
        .filter(|s| !s.is_empty())
        .or_else(|| Some(format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", dto.video_id)));
    Track {
        id: format!("yt:{}", dto.video_id),
        title: dto.title,
        artist: if dto.artist.is_empty() {
            dto.artists.join(", ")
        } else {
            dto.artist
        },
        album: None,
        cover: cover.clone(),
        thumb: cover,
        src: format!("https://music.youtube.com/watch?v={}", dto.video_id),
        duration: dto.duration_seconds.unwrap_or(0.0),
        full_duration: None,
        native_id: Some(dto.video_id),
        preview: None,
        playback: Some("direct".into()),
        source: Source::YouTube,
        lyrics: None,
    }
}

fn next_pseudo_rand(max: usize) -> usize {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEED: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(17);
    let mut x = SEED.load(Ordering::Relaxed) ^ nanos;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    SEED.store(x, Ordering::Relaxed);
    if max == 0 {
        0
    } else {
        (x.wrapping_mul(0x2545_f491_4f6c_dd1d) as usize) % max
    }
}

#[allow(dead_code)]
fn _unused_guard(_p: &YtMusicPlaylistDto) {}
