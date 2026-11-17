use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, IntoElement, ParentElement, Styled, Window, div, point,
    prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::{LoadingIndicator, TextField, TextFieldVariant};
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, dur_label, t, tracks_label};
use resonance_core::models::{DialogKind, FavProvider, Lang, PlaybackStatus, Source, Track};

use crate::store::AppStore;
use crate::ui::controls::{
    M3ButtonSize, M3ButtonVariant, M3IconBtnSize, M3IconBtnVariant, SegOption, m3_button,
    m3_card, m3_icon_button, m3_segmented,
};
use crate::ui::track_list::{TrackListProps, render_track_list};
use crate::ui::{
    cover_art_box, fav_cover_box, mosaic_cover_box, rgba_alpha, track_primary_cover,
};

struct CollectionHeroProps {
    lang: Lang,
    kind_label: String,
    title: String,
    subtitle: String,
    cover: gpui_kit::Div,
    playing_here: bool,
    empty: bool,
    context_id: String,
    tracks: Vec<Track>,
    edit_playlist_id: Option<String>,
    top_right_tools: gpui_kit::Div,
}

fn render_collection_hero(
    store: &Entity<AppStore>,
    props: CollectionHeroProps,
    window: &mut Window,
) -> gpui_kit::Div {
    let vw = f32::from(window.viewport_size().width);
    let stacked = vw < 860.0;
    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let lang = props.lang;

    let st_play = store.clone();
    let st_shuf = store.clone();
    let tracks_play = props.tracks.clone();
    let tracks_shuf = props.tracks.clone();
    let ctx_play = props.context_id.clone();
    let ctx_shuf = props.context_id.clone();

    let cover_wrap = props.cover.shadow(vec![BoxShadow {
        color: rgba_alpha(gpui_kit::rgb(0x000000), 0.55),
        offset: point(px(0.0), px(20.0)),
        blur_radius: px(46.0),
        spread_radius: px(-16.0),
        inset: false,
    }]);

    let meta_col = div()
        .flex_1()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .when(stacked, |d| d.items_center())
        .child(
            div()
                .text_size(px(12.0))
                .font_weight(gpui_kit::FontWeight::BOLD)
                .text_color(muted)
                .child(props.kind_label),
        )
        .child(
            div()
                .my(px(6.0))
                .text_size(px(if stacked { 38.0 } else { 56.0 }))
                .line_height(px(if stacked { 42.0 } else { 60.0 }))
                .font_weight(gpui_kit::FontWeight::EXTRA_BOLD)
                .text_color(ink)
                .child(props.title),
        )
        .child(
            div()
                .text_size(px(15.0))
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(muted)
                .child(props.subtitle),
        )
        .child({
            let mut acts = div()
                .mt(px(20.0))
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.0))
                .child(m3_button(
                    "col-play-all",
                    t(lang, if props.playing_here { Key::Pause } else { Key::Play }),
                    Some(if props.playing_here {
                        "pause"
                    } else {
                        "play_arrow"
                    }),
                    M3ButtonVariant::Filled,
                    M3ButtonSize::Lg,
                    props.empty,
                    move |_, cx| {
                        if props.playing_here {
                            st_play.update(cx, |s, cx| s.toggle_play(cx));
                        } else {
                            let tc = tracks_play.clone();
                            let ctx = ctx_play.clone();
                            st_play.update(cx, |s, cx| {
                                s.player.shuffle = false;
                                s.play_from_list_index(&tc, 0, Some(ctx), cx);
                            });
                        }
                    },
                ))
                .child(m3_button(
                    "col-shuffle-all",
                    t(lang, Key::Shuffle),
                    Some("shuffle"),
                    M3ButtonVariant::Tonal,
                    M3ButtonSize::Lg,
                    props.empty,
                    move |_, cx| {
                        let tc = tracks_shuf.clone();
                        let ctx = ctx_shuf.clone();
                        st_shuf.update(cx, |s, cx| {
                            s.player.shuffle = true;
                            s.play_from_list_index(&tc, 0, Some(ctx), cx);
                        });
                    },
                ));

            if let Some(pid) = props.edit_playlist_id {
                let st_ed = store.clone();
                let st_del = store.clone();
                let pid_ed = pid.clone();
                let pid_del = pid;
                acts = acts
                    .child(m3_icon_button(
                        "col-edit-pl",
                        "edit",
                        false,
                        M3IconBtnVariant::Standard,
                        M3IconBtnSize::Lg,
                        false,
                        false,
                        false,
                        move |w, cx| {
                            let id_c = pid_ed.clone();
                            st_ed.update(cx, |s, cx| {
                                let cur = s
                                    .library
                                    .playlists
                                    .iter()
                                    .find(|p| p.id == id_c)
                                    .map(|p| p.name.clone())
                                    .unwrap_or_default();
                                s.dialog_name_input
                                    .update(cx, |inp, cx| inp.set_value(&cur, w, cx));
                                s.dialog = Some(DialogKind::Rename { id: id_c });
                                cx.notify();
                            });
                        },
                    ))
                    .child(m3_icon_button(
                        "col-del-pl",
                        "delete",
                        false,
                        M3IconBtnVariant::Standard,
                        M3IconBtnSize::Lg,
                        false,
                        false,
                        false,
                        move |_, cx| {
                            let id_c = pid_del.clone();
                            st_del.update(cx, |s, cx| {
                                s.dialog = Some(DialogKind::Delete { id: id_c });
                                cx.notify();
                            });
                        },
                    ));
            }
            acts
        });

    let mut hero = div().relative().mb(px(32.0)).mt(px(8.0)).flex().flex_col().gap(px(16.0));
    if stacked {
        hero = hero
            .child(
                div()
                    .flex()
                    .justify_end()
                    .child(props.top_right_tools),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(20.0))
                    .child(cover_wrap)
                    .child(meta_col),
            );
    } else {
        hero = hero
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap(px(24.0))
                    .child(cover_wrap)
                    .child(meta_col),
            )
            .child(
                div()
                    .absolute()
                    .top(px(0.0))
                    .right(px(0.0))
                    .child(props.top_right_tools),
            );
    }
    hero
}

pub fn render_favorites_page(store: &Entity<AppStore>, window: &mut Window, cx: &mut App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let dark = s.resolved_theme.dark;
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let fav_filter = s.ui.fav_provider;
    let query = s.fav_filter_input.read(cx).value().trim().to_lowercase();
    let fav_inp = s.fav_filter_input.clone();

    let mut seen = std::collections::HashSet::new();
    let mut all_favs: Vec<Track> = Vec::new();
    for id in &s.library.favorites {
        if let Some(tr) = s.library.catalog.get(id)
            && seen.insert(tr.id.clone())
        {
            all_favs.push(tr.clone());
        }
    }
    for tr in s
        .library
        .soundcloud_liked
        .iter()
        .chain(s.library.ytmusic_liked.iter())
    {
        if seen.insert(tr.id.clone()) {
            all_favs.push(tr.clone());
        }
    }

    let filtered: Vec<Track> = all_favs
        .into_iter()
        .filter(|tr| {
            let src_ok = match fav_filter {
                FavProvider::All => true,
                FavProvider::Soundcloud => tr.source == Source::SoundCloud,
                FavProvider::Youtube => tr.source == Source::YouTube,
            };
            let q_ok = query.is_empty()
                || tr.title.to_lowercase().contains(&query)
                || tr.artist.to_lowercase().contains(&query);
            src_ok && q_ok
        })
        .collect();

    let total_dur: f64 = filtered.iter().map(|t| t.duration).sum();
    let playing_here = s.play_context.as_deref() == Some("favorites")
        && s.status == PlaybackStatus::Playing;

    let st_seg = store.clone();
    let st_ref = store.clone();

    let mut sub = tracks_label(lang, Some(filtered.len() as i64));
    if total_dur > 0.0 {
        sub.push_str(" · ");
        sub.push_str(&dur_label(lang, total_dur));
    }

    let tools = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(6.0))
        .child(m3_segmented(
            "fav-prov-seg",
            fav_filter,
            vec![
                SegOption::text(FavProvider::All, t(lang, Key::FavoritesAll)),
                SegOption::compact_asset(FavProvider::Soundcloud, "assets/soundcloud.svg"),
                SegOption::compact_asset(FavProvider::Youtube, "assets/youtube-music.svg"),
            ],
            true,
            move |next, cx| {
                st_seg.update(cx, |s, cx| {
                    s.ui.fav_provider = next;
                    s.mark_dirty();
                    cx.notify();
                });
            },
        ))
        .child(
            div().w(px(210.0)).child(
                TextField::new("fav-search-tf", &fav_inp)
                    .variant(TextFieldVariant::Outlined)
                    .placeholder(t(lang, Key::FavoritesSearchPlaceholder)),
            ),
        )
        .child(m3_icon_button(
            "fav-refresh",
            "refresh",
            false,
            M3IconBtnVariant::Tonal,
            M3IconBtnSize::Sm,
            false,
            false,
            false,
            move |_, cx| {
                st_ref.update(cx, |s, cx| {
                    s.refresh_soundcloud(true, cx);
                    s.refresh_ytmusic(true, cx);
                });
            },
        ));

    // Re-localize Play/Shuffle button labels cleanly via localized wrapper if needed;
    // keep crisp CollectionHeroProps title/sub.
    let hero = render_collection_hero(
        store,
        CollectionHeroProps {
            lang,
            kind_label: t(lang, Key::Collection).to_uppercase(),
            title: t(lang, Key::Favorites).to_string(),
            subtitle: sub,
            cover: fav_cover_box(220.0, 36.0),
            playing_here,
            empty: filtered.is_empty(),
            context_id: "favorites".into(),
            tracks: filtered.clone(),
            edit_playlist_id: None,
            top_right_tools: tools,
        },
        window,
    );

    let body: AnyElement = if (s.sc_loading_lib || s.yt_loading_lib) && filtered.is_empty() {
        div()
            .py(px(48.0))
            .flex()
            .justify_center()
            .child(LoadingIndicator::new("fav-loading", "Loading library"))
            .into_any_element()
    } else if filtered.is_empty() {
        m3_card(&s.appearance, dark)
            .p(px(32.0))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.0))
            .child(
                div()
                    .text_size(px(16.0))
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .text_color(color(ColorRole::ON_SURFACE))
                    .child(t(lang, Key::FavoritesEmpty)),
            )
            .child(
                div()
                    .text_size(px(14.0))
                    .text_color(muted)
                    .child(t(lang, Key::FavoritesEmptyText)),
            )
            .into_any_element()
    } else {
        render_track_list(
            store,
            TrackListProps {
                id_prefix: "fav".into(),
                tracks: filtered,
                context_id: Some("favorites".into()),
                removable_playlist_id: None,
            },
            window,
            cx,
        )
    };

    div().flex().flex_col().child(hero).child(body).into_any_element()
}

pub fn render_playlist_page(
    store: &Entity<AppStore>,
    id: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let dark = s.resolved_theme.dark;
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let query = s.playlist_filter_input.read(cx).value().trim().to_lowercase();
    let pl_inp = s.playlist_filter_input.clone();

    let mut is_local = false;
    let mut is_loading = false;
    let (title, explicit_art, tracks): (String, Option<String>, Vec<Track>) = if id == "sc:liked" {
        (
            t(lang, Key::SoundcloudLiked).to_string(),
            s.library
                .soundcloud_liked
                .first()
                .and_then(track_primary_cover)
                .map(str::to_string),
            s.library.soundcloud_liked.clone(),
        )
    } else if id == "yt:liked" {
        (
            t(lang, Key::YtmusicLiked).to_string(),
            s.library
                .ytmusic_liked
                .first()
                .and_then(track_primary_cover)
                .map(str::to_string),
            s.library.ytmusic_liked.clone(),
        )
    } else if let Some(urn) = id.strip_prefix("scpl:") {
        is_loading = s.sc_active_playlist_loading.contains(urn);
        let meta = s.library.soundcloud_playlists.iter().find(|p| p.urn == urn);
        let title = meta.map(|m| m.name.clone()).unwrap_or_else(|| "SoundCloud".into());
        let art = meta.and_then(|m| m.artwork_url.clone());
        let trs = s
            .library
            .soundcloud_playlist_tracks
            .get(urn)
            .cloned()
            .unwrap_or_default();
        (title, art, trs)
    } else if let Some(pid) = id.strip_prefix("ytpl:") {
        is_loading = s.yt_active_playlist_loading.contains(pid);
        let meta = s
            .library
            .ytmusic_playlists
            .iter()
            .find(|p| p.playlist_id == pid);
        let title = meta
            .map(|m| m.title.clone())
            .unwrap_or_else(|| "YouTube Music".into());
        let art = meta
            .and_then(|m| m.artwork_url.clone())
            .or_else(|| s.library.ytmusic_playlist_art.get(pid).cloned());
        let trs = s
            .library
            .ytmusic_playlist_tracks
            .get(pid)
            .cloned()
            .unwrap_or_default();
        (title, art, trs)
    } else if let Some(pl) = s.library.playlists.iter().find(|p| p.id == id) {
        is_local = true;
        let trs: Vec<Track> = pl
            .ids
            .iter()
            .filter_map(|tid| s.library.catalog.get(tid).cloned())
            .collect();
        (pl.name.clone(), pl.artwork_url.clone(), trs)
    } else {
        return m3_card(&s.appearance, dark)
            .p(px(28.0))
            .child(
                div()
                    .text_size(px(15.0))
                    .text_color(muted)
                    .child(t(lang, Key::PlaylistEmptyText)),
            )
            .into_any_element();
    };

    let filtered: Vec<Track> = if query.is_empty() {
        tracks.clone()
    } else {
        tracks
            .iter()
            .filter(|tr| {
                tr.title.to_lowercase().contains(&query)
                    || tr.artist.to_lowercase().contains(&query)
            })
            .cloned()
            .collect()
    };

    let total_dur: f64 = filtered.iter().map(|t| t.duration).sum();
    let playing_here = s.play_context.as_deref() == Some(id) && s.status == PlaybackStatus::Playing;

    let mut sub = tracks_label(lang, Some(filtered.len() as i64));
    if total_dur > 0.0 {
        sub.push_str(" · ");
        sub.push_str(&dur_label(lang, total_dur));
    }

    let cover_div = if let Some(ref url) = explicit_art {
        cover_art_box(Some(url.as_str()), id, 220.0, 36.0)
    } else {
        let tile_urls: Vec<Option<&str>> = tracks.iter().take(4).map(track_primary_cover).collect();
        mosaic_cover_box(&tile_urls, id, 220.0, 36.0)
    };

    let tools = div().w(px(220.0)).child(
        TextField::new("pl-search-tf", &pl_inp)
            .variant(TextFieldVariant::Outlined)
            .placeholder(t(lang, Key::PlaylistSearchPlaceholder)),
    );

    let hero = render_collection_hero(
        store,
        CollectionHeroProps {
            lang,
            kind_label: t(lang, Key::Playlist).to_uppercase(),
            title,
            subtitle: sub,
            cover: cover_div,
            playing_here,
            empty: filtered.is_empty(),
            context_id: id.to_string(),
            tracks: filtered.clone(),
            edit_playlist_id: is_local.then(|| id.to_string()),
            top_right_tools: tools,
        },
        window,
    );

    let body: AnyElement = if is_loading && filtered.is_empty() {
        div()
            .py(px(48.0))
            .flex()
            .justify_center()
            .child(LoadingIndicator::new("pl-loading", "Loading playlist"))
            .into_any_element()
    } else if tracks.is_empty() {
        m3_card(&s.appearance, dark)
            .p(px(28.0))
            .text_size(px(14.0))
            .text_color(muted)
            .child(t(lang, Key::PlaylistEmptyText))
            .into_any_element()
    } else {
        render_track_list(
            store,
            TrackListProps {
                id_prefix: format!("pl-{id}"),
                tracks: filtered,
                context_id: Some(id.to_string()),
                removable_playlist_id: is_local.then(|| id.to_string()),
            },
            window,
            cx,
        )
    };

    div().flex().flex_col().child(hero).child(body).into_any_element()
}
