use gpui_kit::{
    AnyElement, App, AppContext, Context, Div, Entity, InteractiveElement, IntoElement,
    ParentElement, SharedString, Stateful, StatefulInteractiveElement, Styled, Window, div, img,
    prelude::FluentBuilder, px, rgb,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, tracks_label};
use resonance_core::models::{
    BgMode, BgStyle, CreateInitialTab, DialogKind, PlaybackStatus, PlaylistSection, Route,
};

use crate::assets::ms_icon;
use crate::store::{AppStore, ImportPhase};
use crate::ui::controls::{
    M3IconBtnSize, M3IconBtnVariant, m3_icon_button, m3_logo,
};
use crate::ui::{
    SurfaceKind, cover_art_box, eq_playing_bars, glass_panel_with_neon, role_alpha,
    track_primary_cover,
};

type NavClickFn = Box<dyn Fn(&mut Window, &mut App)>;

#[derive(Clone)]
struct DraggedPlaylist {
    id: String,
    section: PlaylistSection,
}

struct DragPlaylistGhost(String);

impl gpui_kit::Render for DragPlaylistGhost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(14.0))
            .py(px(8.0))
            .rounded(px(24.0))
            .bg(role_alpha(ColorRole::SURFACE_CONTAINER_HIGHEST, 0.92))
            .text_size(px(14.0))
            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
            .text_color(color(ColorRole::ON_SURFACE))
            .child(self.0.clone())
    }
}

/// Renders the M3 Expressive Navigation Drawer / Rail sidebar matching `src/components/Sidebar.tsx`.
pub fn render_sidebar(
    store: &Entity<AppStore>,
    mobile_drawer: bool,
    _window: &mut Window,
    cx: &mut Context<crate::ResonanceRoot>,
) -> AnyElement {
    let s = store.read(cx);
    let collapsed = !mobile_drawer && s.ui.sidebar_collapsed;
    let route = s.route.clone();
    let search_open = s.search_open;
    let lang = s.appearance.lang;
    let dark = s.resolved_theme.dark;
    let t = |k: Key| resonance_core::i18n::t(lang, k);

    let accent = color(ColorRole::PRIMARY);
    let active_bg = color(ColorRole::SECONDARY_CONTAINER);
    let active_fg = color(ColorRole::ON_SECONDARY_CONTAINER);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let ink = color(ColorRole::ON_SURFACE);

    let palette_style =
        s.appearance.bg_mode == BgMode::Dynamic && s.appearance.bg_style == BgStyle::Palette;

    let playing = s.status == PlaybackStatus::Playing;
    let cur_id = s.current_track_id.clone();

    let fav_count = s.library.favorites.len()
        + s.library.soundcloud_liked.len()
        + s.library.ytmusic_liked.len();

    let fold_local = s.ui.fold_local;
    let fold_yt = s.ui.fold_youtube;
    let fold_sc = s.ui.fold_soundcloud;

    let yt_authorized = s.library.ytmusic_authorized;
    let sc_authorized = s.sc_authorized;
    let yt_native_pls = s.library.ytmusic_playlists.clone();
    let sc_native_pls = s.library.soundcloud_playlists.clone();
    let custom_playlists = s.library.playlists.clone();
    let has_update = s.update_state.available;
    let latest_version = s.update_state.latest_version.clone();

    let yt_local_pls: Vec<_> = custom_playlists
        .iter()
        .filter(|p| p.section == Some(PlaylistSection::Youtube))
        .cloned()
        .collect();
    let sc_local_pls: Vec<_> = custom_playlists
        .iter()
        .filter(|p| p.section == Some(PlaylistSection::Soundcloud))
        .cloned()
        .collect();
    let local_pls: Vec<_> = custom_playlists
        .iter()
        .filter(|p| matches!(p.section, None | Some(PlaylistSection::Local)))
        .cloned()
        .collect();

    let show_yt = !yt_native_pls.is_empty() || !yt_local_pls.is_empty();
    let show_sc = !sc_native_pls.is_empty() || !sc_local_pls.is_empty();

    // 1. Header brand (.side-brand: height 76px, padding 0 24px, gap 10px)
    let st_brand = store.clone();
    let st_col = store.clone();
    let brand = if collapsed {
        div()
            .h(px(76.0))
            .px(px(24.0))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .id("sidebar-expand-toggle")
                    .group("brand-toggle")
                    .relative()
                    .w(px(40.0))
                    .h(px(40.0))
                    .cursor_pointer()
                    .on_click(move |_, _, cx| {
                        st_col.update(cx, |s, cx| {
                            s.ui.sidebar_collapsed = false;
                            s.mark_dirty();
                            cx.notify();
                        });
                    })
                    .child(
                        div()
                            .w_full()
                            .h_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .group_hover("brand-toggle", |st| st.opacity(0.0))
                            .child(m3_logo("brand-logo-sm", 40.0, s.spin_deg, palette_style)),
                    )
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .opacity(0.0)
                            .group_hover("brand-toggle", |st| {
                                st.opacity(1.0).bg(role_alpha(ColorRole::ON_SURFACE, 0.08))
                            })
                            .child(ms_icon("menu", false, 24.0, muted)),
                    ),
            )
    } else {
        let mut row = div()
            .h(px(76.0))
            .px(px(24.0))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(10.0));

        if !mobile_drawer {
            row = row.child(m3_icon_button(
                "sidebar-collapse",
                "menu_open",
                false,
                M3IconBtnVariant::Standard,
                M3IconBtnSize::Md,
                false,
                false,
                false,
                move |_, cx| {
                    st_col.update(cx, |s, cx| {
                        s.ui.sidebar_collapsed = true;
                        s.mark_dirty();
                        cx.notify();
                    });
                },
            ));
        }

        row = row.child(
            div()
                .id("brand-home")
                .flex_1()
                .min_w(px(0.0))
                .flex()
                .items_center()
                .gap(px(10.0))
                .cursor_pointer()
                .on_click(move |_, w, cx| {
                    st_brand.update(cx, |s, cx| s.navigate(Route::Home, w, cx));
                })
                .child(m3_logo("brand-logo", 40.0, s.spin_deg, palette_style))
                .child(
                    div()
                        .text_size(px(24.0))
                        .line_height(px(26.0))
                        .font_weight(gpui_kit::FontWeight::EXTRA_BOLD)
                        .text_color(ink)
                        .truncate()
                        .child("Resonance"),
                ),
        );

        if mobile_drawer {
            let st_close = store.clone();
            row = row.child(m3_icon_button(
                "drawer-close",
                "close",
                false,
                M3IconBtnVariant::Standard,
                M3IconBtnSize::Md,
                false,
                false,
                false,
                move |_, cx| {
                    st_close.update(cx, |s, cx| {
                        s.mobile_nav_open = false;
                        cx.notify();
                    });
                },
            ));
        }
        row
    };

    // Helper for 52px M3 pill nav item (.nav-item)
    let render_nav_item = |id: &'static str,
                           icon: &'static str,
                           label: SharedString,
                           sub: Option<SharedString>,
                           active: bool,
                           badge: bool,
                           trailing_count: Option<usize>,
                           on_click: NavClickFn| -> Stateful<Div> {
        let fg = if active { active_fg } else { muted };
        let title_fg = if active { active_fg } else { ink };

        let mut row = div()
            .id(id)
            .h(px(52.0))
            .mx(px(16.0))
            .my(px(2.0))
            .rounded(px(26.0))
            .flex_shrink_0()
            .flex()
            .items_center()
            .cursor_pointer()
            .when(active, |d| d.bg(active_bg))
            .when(!active, |d| {
                d.hover(|st| st.bg(role_alpha(ColorRole::ON_SURFACE, 0.08)))
            })
            .on_click(move |_, w, cx| on_click(w, cx));

        let mut ic_slot = div()
            .w(px(56.0))
            .h(px(52.0))
            .flex_shrink_0()
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .child(ms_icon(icon, active, 24.0, fg));

        if badge && collapsed {
            ic_slot = ic_slot.child(
                div()
                    .absolute()
                    .right(px(14.0))
                    .top(px(12.0))
                    .w(px(10.0))
                    .h(px(10.0))
                    .rounded_full()
                    .bg(rgb(0xff3b30)),
            );
        }
        row = row.child(ic_slot);

        if !collapsed {
            let mut label_col = div()
                .flex_1()
                .min_w(px(0.0))
                .pr(px(14.0))
                .flex()
                .flex_col()
                .justify_center()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.0))
                                .text_size(px(15.0))
                                .font_weight(if active {
                                    gpui_kit::FontWeight::BOLD
                                } else {
                                    gpui_kit::FontWeight::MEDIUM
                                })
                                .text_color(title_fg)
                                .truncate()
                                .child(label),
                        )
                        .when(badge, |d| {
                            d.child(
                                div()
                                    .w(px(9.0))
                                    .h(px(9.0))
                                    .rounded_full()
                                    .bg(rgb(0xff3b30)),
                            )
                        })
                        .when_some(trailing_count, |d, n| {
                            d.child(
                                div()
                                    .text_size(px(12.0))
                                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                                    .text_color(fg)
                                    .child(n.to_string()),
                            )
                        }),
                );

            if let Some(sub_txt) = sub {
                label_col = label_col.child(
                    div()
                        .text_size(px(12.0))
                        .text_color(if active { active_fg } else { muted })
                        .truncate()
                        .child(sub_txt),
                );
            }
            row = row.child(label_col);
        }
        row
    };

    // 2. Scrollable nav + libraries (.side-scroll)
    let mut scroll = div()
        .id("sidebar-scroll")
        .flex_1()
        .min_h(px(0.0))
        .overflow_y_scroll()
        .pt(px(2.0))
        .pb(px(14.0))
        .flex()
        .flex_col();

    let st_home = store.clone();
    let home_active = !search_open && route == Route::Home;
    scroll = scroll.child(render_nav_item(
        "nav-home",
        "home",
        t(Key::Home).into(),
        None,
        home_active,
        false,
        None,
        Box::new(move |w, cx| {
            st_home.update(cx, |s, cx| s.navigate(Route::Home, w, cx));
        }),
    ));

    let st_fav = store.clone();
    let fav_active = !search_open && route == Route::Favorites;
    scroll = scroll.child(render_nav_item(
        "nav-favorites",
        "favorite",
        t(Key::Favorites).into(),
        None,
        fav_active,
        false,
        (fav_count > 0).then_some(fav_count),
        Box::new(move |w, cx| {
            st_fav.update(cx, |s, cx| s.navigate(Route::Favorites, w, cx));
        }),
    ));

    // Playlists section header (.side-section: h 44px, mt 10px)
    let st_add = store.clone();
    let add_btn = m3_icon_button(
        "sb-new-playlist",
        "add",
        false,
        M3IconBtnVariant::Tonal,
        M3IconBtnSize::Sm,
        false,
        false,
        false,
        move |w, cx| {
            st_add.update(cx, |s, cx| {
                s.dialog_name_input.update(cx, |inp, cx| inp.set_value("", w, cx));
                s.dialog_url_input.update(cx, |inp, cx| inp.set_value("", w, cx));
                s.create_initial_tab = CreateInitialTab::Scratch;
                s.dialog = Some(DialogKind::Create {
                    track_id: None,
                    initial_tab: CreateInitialTab::Scratch,
                });
                cx.notify();
            });
        },
    );

    scroll = scroll.child(if collapsed {
        div()
            .h(px(44.0))
            .mt(px(10.0))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .child(add_btn)
    } else {
        div()
            .h(px(44.0))
            .mt(px(10.0))
            .flex_shrink_0()
            .pl(px(30.0))
            .pr(px(24.0))
            .flex()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_size(px(12.0))
                    .font_weight(gpui_kit::FontWeight::BOLD)
                    .text_color(muted)
                    .child(t(Key::Playlists).to_uppercase()),
            )
            .child(add_btn)
    });

    // Active playlist import progress row
    let import_active = s.import_job.running || !s.import_job.review_items.is_empty();
    if import_active {
        let awaiting = !s.import_job.running && !s.import_job.review_items.is_empty();
        let st_imp = store.clone();
        let sub_text = match (awaiting, s.import_job.phase) {
            (true, _) => resonance_core::i18n::tf(
                lang,
                Key::ImportNeedsReviewSub,
                &[("count", &s.import_job.review_items.len().to_string())],
            ),
            (_, Some(ImportPhase::Fetching)) => t(Key::ImportFetching).to_string(),
            (_, Some(ImportPhase::Matching)) => resonance_core::i18n::tf(
                lang,
                Key::ImportMatching,
                &[
                    ("done", &s.import_job.done.to_string()),
                    ("total", &s.import_job.total.to_string()),
                ],
            ),
            (_, Some(ImportPhase::Saving)) | (false, None) => t(Key::ImportFinalizing).to_string(),
        };
        scroll = scroll.child(render_nav_item(
            "nav-import-job",
            if awaiting {
                "playlist_add_check"
            } else {
                "download"
            },
            SharedString::from(if s.import_job.review_title.is_empty() {
                t(Key::NewPlaylist).to_string()
            } else {
                s.import_job.review_title.clone()
            }),
            Some(SharedString::from(sub_text)),
            awaiting,
            awaiting,
            None,
            Box::new(move |_, cx| {
                if awaiting {
                    st_imp.update(cx, |s, cx| {
                        s.dialog = Some(DialogKind::ImportReview);
                        cx.notify();
                    });
                }
            }),
        ));
    }

    // Provider group header (.side-group: h 40px, mx 16px, rounded 20px)
    let render_group_header =
        |sec_id: &'static str,
         title: &str,
         logo_asset: Option<&'static str>,
         fallback_icon: &'static str,
         open: bool,
         section_kind: PlaylistSection| -> Stateful<Div> {
            let st_fold = store.clone();
            let st_drop = store.clone();

            let mut ic_box = div()
                .w(px(56.0))
                .h(px(40.0))
                .flex_shrink_0()
                .relative()
                .flex()
                .items_center()
                .justify_center();
            if let Some(path) = logo_asset {
                ic_box = ic_box.child(img(path).w(px(20.0)).h(px(20.0)).rounded(px(5.0)));
            } else {
                ic_box = ic_box.child(ms_icon(fallback_icon, false, 20.0, muted));
            }
            if collapsed {
                ic_box = ic_box.child(
                    div()
                        .absolute()
                        .right(px(10.0))
                        .bottom(px(5.0))
                        .w(px(14.0))
                        .h(px(14.0))
                        .rounded_full()
                        .bg(color(ColorRole::SURFACE_CONTAINER_HIGH))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(ms_icon(
                            if open {
                                "keyboard_arrow_down"
                            } else {
                                "chevron_right"
                            },
                            false,
                            12.0,
                            ink,
                        )),
                );
            }

            div()
                .id(SharedString::from(format!("group-{sec_id}")))
                .h(px(40.0))
                .mx(px(16.0))
                .mt(px(4.0))
                .mb(px(2.0))
                .rounded(px(20.0))
                .flex_shrink_0()
                .flex()
                .items_center()
                .gap(px(2.0))
                .cursor_pointer()
                .hover(|st| st.bg(role_alpha(ColorRole::ON_SURFACE, 0.08)))
                .on_drop::<DraggedPlaylist>(move |dragged, _w, cx| {
                    if dragged.section != section_kind {
                        let pid = dragged.id.clone();
                        st_drop.update(cx, |s, cx| s.move_playlist_section(&pid, section_kind, cx));
                    }
                })
                .on_click(move |_, _, cx| {
                    st_fold.update(cx, |s, cx| {
                        match section_kind {
                            PlaylistSection::Local => s.ui.fold_local = !s.ui.fold_local,
                            PlaylistSection::Youtube => s.ui.fold_youtube = !s.ui.fold_youtube,
                            PlaylistSection::Soundcloud => s.ui.fold_soundcloud = !s.ui.fold_soundcloud,
                        }
                        s.mark_dirty();
                        cx.notify();
                    });
                })
                .child(ic_box)
                .when(!collapsed, |d| {
                    d.child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .text_size(px(12.0))
                            .font_weight(gpui_kit::FontWeight::BOLD)
                            .text_color(muted)
                            .truncate()
                            .child(title.to_uppercase()),
                    )
                    .child(
                        div().mr(px(12.0)).child(ms_icon(
                            if open {
                                "keyboard_arrow_down"
                            } else {
                                "chevron_right"
                            },
                            false,
                            20.0,
                            muted,
                        )),
                    )
                })
        };

    // Playlist nav item (.nav-item: h 52px, mx 16px, rounded 26px, 40x40 rounded(12) cover in 56px slot)
    let render_playlist_item = |pl_id: String,
                                name: String,
                                art: Option<String>,
                                sub: String,
                                prefix_asset: Option<&'static str>,
                                track_ids: Vec<String>,
                                draggable_section: Option<PlaylistSection>|
     -> Stateful<Div> {
        let active = !search_open && route == Route::Playlist(pl_id.clone());
        let is_playing_here = playing
            && active
            && cur_id
                .as_deref()
                .is_some_and(|cid| track_ids.iter().any(|tid| tid == cid));

        let fg = if active { active_fg } else { ink };
        let sub_fg = if active { active_fg } else { muted };
        let st_nav = store.clone();
        let pid_nav = pl_id.clone();

        let mut row = div()
            .id(SharedString::from(format!("sb-pl-{pl_id}")))
            .h(px(52.0))
            .mx(px(16.0))
            .my(px(2.0))
            .rounded(px(26.0))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(2.0))
            .cursor_pointer()
            .when(active, |d| d.bg(active_bg))
            .when(!active, |d| {
                d.hover(|st| st.bg(role_alpha(ColorRole::ON_SURFACE, 0.08)))
            })
            .on_click(move |_, w, cx| {
                let target = pid_nav.clone();
                st_nav.update(cx, |s, cx| s.navigate(Route::Playlist(target), w, cx));
            })
            .child(
                div()
                    .w(px(56.0))
                    .h(px(52.0))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(cover_art_box(art.as_deref(), &pl_id, 40.0, 12.0)),
            );

        if !collapsed {
            row = row.child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .pr(px(if is_playing_here { 6.0 } else { 14.0 }))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .min_w(px(0.0))
                            .when_some(prefix_asset, |d, asset| {
                                d.child(img(asset).w(px(14.0)).h(px(14.0)).rounded(px(3.0)))
                            })
                            .child(
                                div()
                                    .flex_1()
                                    .min_w(px(0.0))
                                    .text_size(px(15.0))
                                    .font_weight(if active {
                                        gpui_kit::FontWeight::BOLD
                                    } else {
                                        gpui_kit::FontWeight::MEDIUM
                                    })
                                    .text_color(fg)
                                    .truncate()
                                    .child(name.clone()),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(12.0))
                            .text_color(sub_fg)
                            .truncate()
                            .child(sub),
                    ),
            );
            if is_playing_here {
                row = row.child(div().mr(px(16.0)).child(eq_playing_bars(s.wave_phase, accent.into())));
            }
        }

        if let Some(sec) = draggable_section {
            let pid_drag = pl_id;
            row = row.on_drag(
                DraggedPlaylist {
                    id: pid_drag,
                    section: sec,
                },
                move |_, _, _, cx| {
                    let label = name.clone();
                    cx.new(move |_| DragPlaylistGhost(label))
                },
            );
        }

        row
    };

    // Order matching Sidebar.tsx: YouTube Music -> SoundCloud -> Local
    if show_yt || (yt_authorized && !yt_native_pls.is_empty()) {
        scroll = scroll.child(render_group_header(
            "yt",
            "YouTube Music",
            Some("assets/youtube-music.svg"),
            "music_note",
            !fold_yt,
            PlaylistSection::Youtube,
        ));
        if !fold_yt {
            for pl in &yt_local_pls {
                let sub = tracks_label(lang, Some(pl.ids.len() as i64));
                let art = pl.artwork_url.clone().or_else(|| {
                    pl.ids
                        .first()
                        .and_then(|tid| s.library.catalog.get(tid))
                        .and_then(|tr| track_primary_cover(tr).map(str::to_string))
                });
                scroll = scroll.child(render_playlist_item(
                    pl.id.clone(),
                    pl.name.clone(),
                    art,
                    sub,
                    None,
                    pl.ids.clone(),
                    Some(PlaylistSection::Youtube),
                ));
            }
            for pl in &yt_native_pls {
                let pid = format!("ytpl:{}", pl.playlist_id);
                let pl_tracks = s.library.ytmusic_playlist_tracks.get(&pl.playlist_id);
                let count = if pl.track_count > 0 {
                    pl.track_count
                } else {
                    pl_tracks.map(|v| v.len() as i64).unwrap_or(0)
                };
                let art = pl
                    .artwork_url
                    .clone()
                    .or_else(|| s.library.ytmusic_playlist_art.get(&pl.playlist_id).cloned());
                let tids = pl_tracks
                    .map(|v| v.iter().map(|t| t.id.clone()).collect())
                    .unwrap_or_default();
                scroll = scroll.child(render_playlist_item(
                    pid,
                    pl.title.clone(),
                    art,
                    tracks_label(lang, Some(count)),
                    Some("assets/youtube-music.svg"),
                    tids,
                    None,
                ));
            }
        }
    }

    if show_sc || (sc_authorized && !sc_native_pls.is_empty()) {
        scroll = scroll.child(render_group_header(
            "sc",
            "SoundCloud",
            Some("assets/soundcloud.svg"),
            "music_note",
            !fold_sc,
            PlaylistSection::Soundcloud,
        ));
        if !fold_sc {
            for pl in &sc_local_pls {
                let sub = tracks_label(lang, Some(pl.ids.len() as i64));
                let art = pl.artwork_url.clone().or_else(|| {
                    pl.ids
                        .first()
                        .and_then(|tid| s.library.catalog.get(tid))
                        .and_then(|tr| track_primary_cover(tr).map(str::to_string))
                });
                scroll = scroll.child(render_playlist_item(
                    pl.id.clone(),
                    pl.name.clone(),
                    art,
                    sub,
                    None,
                    pl.ids.clone(),
                    Some(PlaylistSection::Soundcloud),
                ));
            }
            for pl in &sc_native_pls {
                let pl_tracks = s.library.soundcloud_playlist_tracks.get(&pl.urn);
                let tids = pl_tracks
                    .map(|v| v.iter().map(|t| t.id.clone()).collect())
                    .unwrap_or_default();
                scroll = scroll.child(render_playlist_item(
                    format!("scpl:{}", pl.urn),
                    pl.name.clone(),
                    pl.artwork_url.clone(),
                    tracks_label(lang, Some(pl.track_count)),
                    Some("assets/soundcloud.svg"),
                    tids,
                    None,
                ));
            }
        }
    }

    if !local_pls.is_empty() {
        let multi_sec = show_yt || show_sc;
        if multi_sec {
            scroll = scroll.child(render_group_header(
                "local",
                t(Key::Playlists),
                None,
                "queue_music",
                !fold_local,
                PlaylistSection::Local,
            ));
        }
        if !fold_local || !multi_sec {
            for pl in &local_pls {
                let sub = tracks_label(lang, Some(pl.ids.len() as i64));
                let art = pl.artwork_url.clone().or_else(|| {
                    pl.ids
                        .first()
                        .and_then(|tid| s.library.catalog.get(tid))
                        .and_then(|tr| track_primary_cover(tr).map(str::to_string))
                });
                scroll = scroll.child(render_playlist_item(
                    pl.id.clone(),
                    pl.name.clone(),
                    art,
                    sub,
                    None,
                    pl.ids.clone(),
                    Some(PlaylistSection::Local),
                ));
            }
        }
    }

    // 3. Bottom pinned Updates + Settings (.side-bottom)
    let st_upd = store.clone();
    let st_set = store.clone();
    let settings_active = !search_open
        && matches!(
            route,
            Route::Settings | Route::Appearance | Route::Providers | Route::Audio | Route::Shortcuts
        );

    let footer = div()
        .pt(px(6.0))
        .pb(px(12.0))
        .border_t_1()
        .border_color(role_alpha(ColorRole::OUTLINE_VARIANT, 0.35))
        .flex()
        .flex_col()
        .child(render_nav_item(
            "nav-updates",
            "download",
            t(Key::Updates).into(),
            has_update.then(|| SharedString::from(format!("v{latest_version}"))),
            false,
            has_update,
            None,
            Box::new(move |_, cx| {
                st_upd.update(cx, |s, cx| {
                    s.dialog = Some(DialogKind::Update);
                    s.check_updates_now(cx);
                    cx.notify();
                });
            }),
        ))
        .child(render_nav_item(
            "nav-settings",
            "settings",
            t(Key::Settings).into(),
            None,
            settings_active,
            false,
            None,
            Box::new(move |w, cx| {
                st_set.update(cx, |s, cx| s.navigate(Route::Settings, w, cx));
            }),
        ));

    let width = if collapsed { 88.0 } else { 272.0 };
    let mut shell = glass_panel_with_neon(
        &s.appearance,
        dark,
        SurfaceKind::SidePanel,
        28.0,
        s.resolved_theme.neon_argb,
    )
    .w(px(width))
    .h_full()
    .flex_shrink_0()
    .overflow_hidden()
    .flex()
    .flex_col();

    if mobile_drawer {
        shell = shell.w_full();
    }

    shell
        .child(brand)
        .child(scroll)
        .child(footer)
        .into_any_element()
}
