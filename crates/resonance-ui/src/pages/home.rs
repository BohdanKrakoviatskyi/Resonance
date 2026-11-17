use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, point,
    prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t, tracks_label};
use resonance_core::models::{
    CreateInitialTab, DialogKind, PlaybackStatus, PlaylistSection, Route, Track,
};

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{
    M3ButtonSize, M3ButtonVariant, m3_button, m3_card,
};
use crate::ui::{
    cover_art_box, mosaic_cover_box, rgba_alpha, role_alpha, track_primary_cover,
};

fn greeting_key() -> Key {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let hour = ((secs / 3600) % 24) as u32;
    match hour {
        5..=11 => Key::GoodMorning,
        12..=17 => Key::GoodAfternoon,
        18..=22 => Key::GoodEvening,
        _ => Key::GoodNight,
    }
}

/// Borderless M3 `.mcard` shelf item (`170-180px` wide) matching `Home.tsx`.
fn shelf_playlist_card(
    id: SharedString,
    title: String,
    sub: String,
    cover: gpui_kit::Div,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);

    div()
        .id(id)
        .w(px(176.0))
        .flex_shrink_0()
        .p(px(10.0))
        .rounded(px(26.0))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .cursor_pointer()
        .hover(|st| st.bg(role_alpha(ColorRole::ON_SURFACE, 0.05)))
        .active(|st| st.rounded(px(30.0)))
        .on_click(move |_, w, cx| on_click(w, cx))
        .child(
            cover.shadow(vec![BoxShadow {
                color: rgba_alpha(gpui_kit::rgb(0x000000), 0.45),
                offset: point(px(0.0), px(8.0)),
                blur_radius: px(24.0),
                spread_radius: px(-12.0),
                inset: false,
            }]),
        )
        .child(
            div()
                .mt(px(8.0))
                .text_size(px(15.0))
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(ink)
                .truncate()
                .child(title),
        )
        .child(
            div()
                .text_size(px(13.0))
                .text_color(muted)
                .truncate()
                .child(sub),
        )
}

fn shelf_section(
    title: impl Into<SharedString>,
    subtitle: Option<SharedString>,
    trailing: Option<AnyElement>,
    cards: Vec<AnyElement>,
) -> gpui_kit::Div {
    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);

    let mut head = div()
        .mb(px(12.0))
        .flex()
        .items_end()
        .justify_between()
        .gap(px(12.0))
        .child(
            div()
                .min_w(px(0.0))
                .child(
                    div()
                        .text_size(px(22.0))
                        .font_weight(gpui_kit::FontWeight::BOLD)
                        .text_color(ink)
                        .child(title.into()),
                )
                .when_some(subtitle, |d, sub| {
                    d.child(
                        div()
                            .mt(px(2.0))
                            .text_size(px(13.5))
                            .text_color(muted)
                            .child(sub),
                    )
                }),
        );
    if let Some(t_el) = trailing {
        head = head.child(t_el);
    }

    let mut row = div().flex().gap(px(6.0)).pb(px(8.0));
    for c in cards {
        row = row.child(c);
    }

    div()
        .flex()
        .flex_col()
        .child(head)
        .child(div().w_full().overflow_x_hidden().child(div().flex().flex_wrap().gap(px(6.0)).child(row)))
}

pub fn render_home_page(store: &Entity<AppStore>, _window: &mut Window, cx: &mut App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let dark = s.resolved_theme.dark;
    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let primary = color(ColorRole::PRIMARY);
    let cur_id = s.current_track_id.clone();
    let playing = s.status == PlaybackStatus::Playing;

    // 1. Top row (.home-top: Greeting Display H1 + docked Search pill)
    let st_srch = store.clone();
    let header = div()
        .my(px(8.0))
        .mb(px(24.0))
        .flex()
        .flex_wrap()
        .items_start()
        .justify_between()
        .gap(px(16.0))
        .child(
            div()
                .flex_1()
                .min_w(px(260.0))
                .child(
                    div()
                        .text_size(px(52.0))
                        .line_height(px(54.0))
                        .font_weight(gpui_kit::FontWeight::EXTRA_BOLD)
                        .text_color(ink)
                        .child(t(lang, greeting_key())),
                )
                .child(
                    div()
                        .mt(px(8.0))
                        .text_size(px(17.0))
                        .text_color(muted)
                        .child(t(lang, Key::HomeSubtitle)),
                ),
        )
        .child(
            // .search-bar-dock: 52px SECONDARY_CONTAINER capsule
            div()
                .id("home-search-dock-btn")
                .w(px(360.0))
                .min_w(px(200.0))
                .h(px(52.0))
                .pl(px(16.0))
                .pr(px(12.0))
                .rounded(px(26.0))
                .bg(color(ColorRole::SECONDARY_CONTAINER))
                .shadow(vec![BoxShadow {
                    color: rgba_alpha(gpui_kit::rgb(0x000000), 0.32),
                    offset: point(px(0.0), px(8.0)),
                    blur_radius: px(24.0),
                    spread_radius: px(-12.0),
                    inset: false,
                }])
                .flex()
                .items_center()
                .gap(px(10.0))
                .cursor_pointer()
                .hover(|st| st.bg(role_alpha(ColorRole::SECONDARY_CONTAINER, 0.85)))
                .on_click(move |_, w, cx| {
                    st_srch.update(cx, |s, cx| s.open_search(None, w, cx));
                })
                .child(ms_icon("search", false, 22.0, primary))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .text_size(px(15.0))
                        .text_color(color(ColorRole::ON_SECONDARY_CONTAINER))
                        .truncate()
                        .child(t(lang, Key::SearchPlaceholder)),
                ),
        );

    let mut page = div().flex().flex_col().gap(px(28.0)).child(header);
    let mut has_any_section = false;

    // 2. Your Playlists shelf (+ Import button)
    let local_pls: Vec<_> = s
        .library
        .playlists
        .iter()
        .filter(|p| matches!(p.section, None | Some(PlaylistSection::Local)))
        .cloned()
        .collect();

    if !local_pls.is_empty() {
        has_any_section = true;
        let st_imp = store.clone();
        let import_btn = m3_button(
            "home-import-pl",
            t(lang, Key::ImportTabImport),
            Some("download"),
            M3ButtonVariant::Tonal,
            M3ButtonSize::Default,
            false,
            move |w, cx| {
                st_imp.update(cx, |s, cx| {
                    s.dialog_url_input.update(cx, |inp, cx| inp.set_value("", w, cx));
                    s.create_initial_tab = CreateInitialTab::Import;
                    s.dialog = Some(DialogKind::Create {
                        track_id: None,
                        initial_tab: CreateInitialTab::Import,
                    });
                    cx.notify();
                });
            },
        )
        .into_any_element();

        let cards: Vec<AnyElement> = local_pls
            .iter()
            .map(|pl| {
                let st_nav = store.clone();
                let pid = pl.id.clone();
                let tile_urls: Vec<Option<&str>> = pl
                    .ids
                    .iter()
                    .take(4)
                    .filter_map(|tid| s.library.catalog.get(tid))
                    .map(track_primary_cover)
                    .collect();
                let cover = if let Some(ref u) = pl.artwork_url {
                    cover_art_box(Some(u.as_str()), &pl.id, 156.0, 18.0)
                } else {
                    mosaic_cover_box(&tile_urls, &pl.id, 156.0, 18.0)
                };
                shelf_playlist_card(
                    SharedString::from(format!("home-pl-{}", pl.id)),
                    pl.name.clone(),
                    tracks_label(lang, Some(pl.ids.len() as i64)),
                    cover,
                    move |w, cx| {
                        let target = pid.clone();
                        st_nav.update(cx, |s, cx| s.navigate(Route::Playlist(target), w, cx));
                    },
                )
                .into_any_element()
            })
            .collect();

        page = page.child(shelf_section(
            t(lang, Key::YourPlaylists),
            None,
            Some(import_btn),
            cards,
        ));
    }

    // 3. SoundCloud Library shelf
    let sc_custom: Vec<_> = s
        .library
        .playlists
        .iter()
        .filter(|p| p.section == Some(PlaylistSection::Soundcloud))
        .cloned()
        .collect();
    if !s.library.soundcloud_playlists.is_empty() || !sc_custom.is_empty() {
        has_any_section = true;
        let mut cards = Vec::new();
        for pl in &sc_custom {
            let st_nav = store.clone();
            let pid = pl.id.clone();
            cards.push(
                shelf_playlist_card(
                    SharedString::from(format!("home-sc-c-{}", pl.id)),
                    pl.name.clone(),
                    tracks_label(lang, Some(pl.ids.len() as i64)),
                    cover_art_box(pl.artwork_url.as_deref(), &pl.id, 156.0, 18.0),
                    move |w, cx| {
                        let target = pid.clone();
                        st_nav.update(cx, |s, cx| s.navigate(Route::Playlist(target), w, cx));
                    },
                )
                .into_any_element(),
            );
        }
        for pl in &s.library.soundcloud_playlists {
            let st_nav = store.clone();
            let target = format!("scpl:{}", pl.urn);
            cards.push(
                shelf_playlist_card(
                    SharedString::from(format!("home-sc-{}", pl.id)),
                    pl.name.clone(),
                    tracks_label(lang, Some(pl.track_count)),
                    cover_art_box(pl.artwork_url.as_deref(), &pl.id, 156.0, 18.0),
                    move |w, cx| {
                        let t_id = target.clone();
                        st_nav.update(cx, |s, cx| s.navigate(Route::Playlist(t_id), w, cx));
                    },
                )
                .into_any_element(),
            );
        }
        page = page.child(shelf_section(
            t(lang, Key::SoundcloudLibrary),
            Some(SharedString::from(t(lang, Key::SoundcloudLibrarySub))),
            None,
            cards,
        ));
    }

    // 4. YouTube Music Library shelf
    let yt_custom: Vec<_> = s
        .library
        .playlists
        .iter()
        .filter(|p| p.section == Some(PlaylistSection::Youtube))
        .cloned()
        .collect();
    if (s.library.ytmusic_authorized && !s.library.ytmusic_playlists.is_empty()) || !yt_custom.is_empty()
    {
        has_any_section = true;
        let mut cards = Vec::new();
        for pl in &yt_custom {
            let st_nav = store.clone();
            let pid = pl.id.clone();
            cards.push(
                shelf_playlist_card(
                    SharedString::from(format!("home-yt-c-{}", pl.id)),
                    pl.name.clone(),
                    tracks_label(lang, Some(pl.ids.len() as i64)),
                    cover_art_box(pl.artwork_url.as_deref(), &pl.id, 156.0, 18.0),
                    move |w, cx| {
                        let target = pid.clone();
                        st_nav.update(cx, |s, cx| s.navigate(Route::Playlist(target), w, cx));
                    },
                )
                .into_any_element(),
            );
        }
        if s.library.ytmusic_authorized {
            for pl in &s.library.ytmusic_playlists {
                let st_nav = store.clone();
                let target = format!("ytpl:{}", pl.playlist_id);
                let art = pl
                    .artwork_url
                    .clone()
                    .or_else(|| s.library.ytmusic_playlist_art.get(&pl.playlist_id).cloned());
                cards.push(
                    shelf_playlist_card(
                        SharedString::from(format!("home-yt-{}", pl.playlist_id)),
                        pl.title.clone(),
                        tracks_label(lang, Some(pl.track_count)),
                        cover_art_box(art.as_deref(), &pl.playlist_id, 156.0, 18.0),
                        move |w, cx| {
                            let t_id = target.clone();
                            st_nav.update(cx, |s, cx| s.navigate(Route::Playlist(t_id), w, cx));
                        },
                    )
                    .into_any_element(),
                );
            }
        }
        page = page.child(shelf_section(
            t(lang, Key::YtmusicLibrary),
            Some(SharedString::from(t(lang, Key::YtmusicLibrarySub))),
            None,
            cards,
        ));
    }

    // 5. Recent tracks (.mcard MediaCard with hover Play FAB)
    let recent_tracks: Vec<Track> = s
        .library
        .recent
        .iter()
        .filter_map(|id| s.library.catalog.get(id).cloned())
        .take(16)
        .collect();

    if !recent_tracks.is_empty() {
        has_any_section = true;
        let cards: Vec<AnyElement> = recent_tracks
            .iter()
            .enumerate()
            .map(|(i, tr)| {
                let is_cur = cur_id.as_deref() == Some(&tr.id);
                let grp = SharedString::from(format!("mcard-rec-{i}"));
                let st_p = store.clone();
                let list_c = recent_tracks.clone();

                let cover_wrap = div()
                    .relative()
                    .w(px(156.0))
                    .h(px(156.0))
                    .child(
                        cover_art_box(track_primary_cover(tr), &tr.id, 156.0, 18.0).shadow(vec![
                            BoxShadow {
                                color: rgba_alpha(gpui_kit::rgb(0x000000), 0.50),
                                offset: point(px(0.0), px(8.0)),
                                blur_radius: px(24.0),
                                spread_radius: px(-12.0),
                                inset: false,
                            },
                        ]),
                    )
                    .child(
                        // .mcard-fab (48x48 rounded(16->24) PRIMARY play button on hover or current)
                        div()
                            .absolute()
                            .right(px(8.0))
                            .bottom(px(8.0))
                            .w(px(48.0))
                            .h(px(48.0))
                            .rounded(px(if is_cur { 24.0 } else { 16.0 }))
                            .bg(primary)
                            .shadow(vec![BoxShadow {
                                color: rgba_alpha(gpui_kit::rgb(0x000000), 0.55),
                                offset: point(px(0.0), px(6.0)),
                                blur_radius: px(18.0),
                                spread_radius: px(-6.0),
                                inset: false,
                            }])
                            .flex()
                            .items_center()
                            .justify_center()
                            .when(!is_cur, |d| {
                                d.opacity(0.0).group_hover(grp.clone(), |st| st.opacity(1.0))
                            })
                            .child(ms_icon(
                                if is_cur && playing {
                                    "pause"
                                } else {
                                    "play_arrow"
                                },
                                true,
                                26.0,
                                color(ColorRole::ON_PRIMARY),
                            )),
                    );

                div()
                    .id(SharedString::from(format!("home-rec-card-{i}")))
                    .group(grp)
                    .w(px(176.0))
                    .flex_shrink_0()
                    .p(px(10.0))
                    .rounded(px(26.0))
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .cursor_pointer()
                    .hover(|st| st.bg(role_alpha(ColorRole::ON_SURFACE, 0.05)))
                    .on_click(move |_, _, cx| {
                        if is_cur {
                            st_p.update(cx, |s, cx| s.toggle_play(cx));
                        } else {
                            let tracks = list_c.clone();
                            st_p.update(cx, |s, cx| {
                                s.play_from_list_index(&tracks, i, Some("recent".into()), cx);
                            });
                        }
                    })
                    .child(cover_wrap)
                    .child(
                        div()
                            .mt(px(8.0))
                            .text_size(px(15.0))
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .text_color(if is_cur { primary } else { ink })
                            .truncate()
                            .child(tr.title.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(muted)
                            .truncate()
                            .child(tr.artist.clone()),
                    )
                    .into_any_element()
            })
            .collect();

        page = page.child(shelf_section(
            t(lang, Key::Recent),
            None,
            Some(ms_icon("history", false, 26.0, muted).into_any_element()),
            cards,
        ));
    }

    if !has_any_section {
        let st_prov = store.clone();
        let st_new = store.clone();
        page = page.child(
            m3_card(&s.appearance, dark)
                .p(px(24.0))
                .flex()
                .flex_col()
                .gap(px(14.0))
                .child(
                    div()
                        .text_size(px(20.0))
                        .font_weight(gpui_kit::FontWeight::BOLD)
                        .text_color(ink)
                        .child(t(lang, Key::YourPlaylists)),
                )
                .child(
                    div()
                        .text_size(px(14.0))
                        .text_color(muted)
                        .child(t(lang, Key::PlaylistEmptyText)),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(10.0))
                        .child(m3_button(
                            "home-empty-prov",
                            t(lang, Key::Providers),
                            Some("music_note"),
                            M3ButtonVariant::Filled,
                            M3ButtonSize::Default,
                            false,
                            move |w, cx| {
                                st_prov.update(cx, |s, cx| s.navigate(Route::Providers, w, cx));
                            },
                        ))
                        .child(m3_button(
                            "home-empty-pl",
                            t(lang, Key::NewPlaylist),
                            Some("add"),
                            M3ButtonVariant::Tonal,
                            M3ButtonSize::Default,
                            false,
                            move |w, cx| {
                                st_new.update(cx, |s, cx| {
                                    s.dialog_name_input
                                        .update(cx, |inp, cx| inp.set_value("", w, cx));
                                    s.dialog = Some(DialogKind::Create {
                                        track_id: None,
                                        initial_tab: CreateInitialTab::Scratch,
                                    });
                                    cx.notify();
                                });
                            },
                        )),
                ),
        );
    }

    page.into_any_element()
}
