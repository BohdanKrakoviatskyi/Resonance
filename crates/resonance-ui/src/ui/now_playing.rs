use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, point,
    prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::{MaterialMenu, MaterialMenuItem, MenuPopup};
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};
use resonance_core::matching::LyricsData;
use resonance_core::models::{
    CreateInitialTab, DialogKind, NowPlayingTab, PlaybackStatus, fmt_time,
};

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{
    M3IconBtnSize, M3IconBtnVariant, SegOption, m3_icon_button, m3_segmented,
};
use crate::ui::lyrics::render_lyrics_body;
use crate::ui::{
    SurfaceKind, cover_art_box, eq_playing_bars, glass_panel_with_neon, provider_badge, rgba_alpha,
    role_alpha, track_primary_cover,
};

/// Right-hand Now Playing side panel matching `src/components/NowPlaying.tsx` and `.np` in `src/index.css`.
pub fn render_now_playing_panel(
    store: &Entity<AppStore>,
    mobile_drawer: bool,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let s = store.read(cx);
    let tr = s.current_track().cloned();
    let dark = s.resolved_theme.dark;
    let lang = s.lang();
    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let active_tab = s.now_playing_tab;

    let body = if let Some(ref track) = tr {
        let liked = s.is_liked(&track.id);
        let disliked = s.is_disliked(&track.id);
        let in_playlist = s.library.playlists.iter().any(|p| p.ids.contains(&track.id));
        let menu_open = s.open_track_menu_id.as_deref() == Some("np-playlist-picker");

        let st_full = store.clone();
        let st_art = store.clone();
        let st_like = store.clone();
        let st_dislike = store.clone();
        let st_tab = store.clone();
        let tid_like = track.id.clone();
        let tid_dis = track.id.clone();
        let artist = track.artist.clone();

        // Cover (.np-cover: aspect 1, rounded 28px, shadow 0 18 44 -18 black@0.6)
        let cover_box = div()
            .id("np-cover-open")
            .w_full()
            .flex()
            .justify_center()
            .cursor_pointer()
            .on_click(move |_, _, cx| {
                st_full.update(cx, |s, cx| {
                    s.immersive_open = true;
                    cx.notify();
                });
            })
            .child(
                cover_art_box(track_primary_cover(track), &track.id, 300.0, 28.0).shadow(vec![
                    BoxShadow {
                        color: rgba_alpha(gpui_kit::rgb(0x000000), 0.60),
                        offset: point(px(0.0), px(18.0)),
                        blur_radius: px(44.0),
                        spread_radius: px(-18.0),
                        inset: false,
                    },
                ]),
            );

        let meta_block = div()
            .flex()
            .flex_col()
            .child(
                div()
                    .mt(px(16.0))
                    .mb(px(4.0))
                    .text_size(px(24.0))
                    .line_height(px(28.0))
                    .font_weight(gpui_kit::FontWeight::EXTRA_BOLD)
                    .text_color(ink)
                    .truncate()
                    .child(track.title.clone()),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .min_w(px(0.0))
                    .child(provider_badge(track.source, 16.0))
                    .child(
                        div()
                            .id("np-artist-btn")
                            .min_w(px(0.0))
                            .text_size(px(15.0))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(muted)
                            .truncate()
                            .cursor_pointer()
                            .hover(|st| st.text_color(color(ColorRole::PRIMARY)))
                            .on_click(move |_, w, cx| {
                                let q = artist.clone();
                                st_art.update(cx, |s, cx| s.open_search(Some(&q), w, cx));
                            })
                            .child(track.artist.clone()),
                    ),
            );

        // Playlist picker MenuPopup for NowPlaying add-to-playlist tonal button
        let mut picker_menu = MaterialMenu::new("np-pl-picker-menu");
        for pl in &s.library.playlists {
            let st_tog = store.clone();
            let pid = pl.id.clone();
            let tr_c = track.clone();
            let has = pl.ids.contains(&track.id);
            let tid_rem = track.id.clone();
            picker_menu = picker_menu.item(
                MaterialMenuItem::new(pl.name.clone())
                    .leading(ms_icon(
                        if has { "check" } else { "playlist_add" },
                        has,
                        18.0,
                        if has {
                            color(ColorRole::PRIMARY)
                        } else {
                            muted
                        },
                    ))
                    .on_click(move |_, _, cx| {
                        let p = pid.clone();
                        let t_clone = tr_c.clone();
                        let rem_id = tid_rem.clone();
                        st_tog.update(cx, |s, cx| {
                            s.open_track_menu_id = None;
                            if has {
                                s.remove_track_from_playlist(&p, &rem_id, cx);
                            } else {
                                s.add_track_to_playlist(&p, t_clone, cx);
                            }
                        });
                    }),
            );
        }
        let st_new_pl = store.clone();
        let tid_new_pl = track.id.clone();
        picker_menu = picker_menu.item(
            MaterialMenuItem::new(t(lang, Key::NewPlaylist))
                .leading(ms_icon("add", false, 18.0, muted))
                .on_click(move |_, w, cx| {
                    let tid = tid_new_pl.clone();
                    st_new_pl.update(cx, |s, cx| {
                        s.open_track_menu_id = None;
                        s.dialog_name_input
                            .update(cx, |inp, cx| inp.set_value("", w, cx));
                        s.create_initial_tab = CreateInitialTab::Scratch;
                        s.dialog = Some(DialogKind::Create {
                            track_id: Some(tid),
                            initial_tab: CreateInitialTab::Scratch,
                        });
                        cx.notify();
                    });
                }),
        );

        let st_menu_tgl = store.clone();
        let st_menu_chg = store.clone();
        let add_trigger = m3_icon_button(
            "np-add-pl-btn",
            if in_playlist {
                "playlist_add_check"
            } else {
                "playlist_add"
            },
            in_playlist,
            M3IconBtnVariant::Tonal,
            M3IconBtnSize::Md,
            false,
            menu_open,
            false,
            move |_, cx| {
                st_menu_tgl.update(cx, |s, cx| {
                    s.open_track_menu_id =
                        if s.open_track_menu_id.as_deref() == Some("np-playlist-picker") {
                            None
                        } else {
                            Some("np-playlist-picker".into())
                        };
                    cx.notify();
                });
            },
        );
        let add_popup = MenuPopup::new("np-add-pl-pop", add_trigger, picker_menu)
            .open(menu_open)
            .on_open_change(move |open: &bool, _, cx| {
                let is_open = *open;
                st_menu_chg.update(cx, |s, cx| {
                    if is_open {
                        s.open_track_menu_id = Some("np-playlist-picker".into());
                    } else if s.open_track_menu_id.as_deref() == Some("np-playlist-picker") {
                        s.open_track_menu_id = None;
                    }
                    cx.notify();
                });
            });

        let actions_row = div()
            .mt(px(16.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(m3_icon_button(
                "np-like-btn",
                if liked { "favorite" } else { "favorite_border" },
                liked,
                M3IconBtnVariant::Tonal,
                M3IconBtnSize::Md,
                false,
                liked,
                false,
                move |_, cx| {
                    let id = tid_like.clone();
                    st_like.update(cx, |s, cx| s.toggle_like(&id, cx));
                },
            ))
            .child(m3_icon_button(
                "np-dislike-btn",
                "thumb_down",
                disliked,
                M3IconBtnVariant::Tonal,
                M3IconBtnSize::Md,
                false,
                disliked,
                false,
                move |_, cx| {
                    let id = tid_dis.clone();
                    st_dislike.update(cx, |s, cx| s.toggle_dislike(&id, cx));
                },
            ))
            .child(add_popup);

        let tabs = div().mt(px(16.0)).child(m3_segmented(
            "np-tabs",
            active_tab,
            vec![
                SegOption::icon_text(NowPlayingTab::Lyrics, "lyrics", t(lang, Key::Lyrics)),
                SegOption::icon_text(NowPlayingTab::Queue, "queue_music", t(lang, Key::UpNext)),
            ],
            true,
            move |next_tab, cx| {
                st_tab.update(cx, |s, cx| {
                    s.now_playing_tab = next_tab;
                    cx.notify();
                });
            },
        ));

        let tab_content: AnyElement = match active_tab {
            NowPlayingTab::Lyrics => {
                let lyr_data: Option<LyricsData> = s.lyrics_cache.get(&track.id).cloned().flatten();
                let lyr_loading = s.lyrics_loading.contains(&track.id);
                let has_manual = s.manual_lyrics.contains_key(&track.id);
                render_lyrics_body(
                    store,
                    track,
                    lyr_data.as_ref(),
                    lyr_loading,
                    has_manual,
                    false,
                    cx,
                )
            }
            NowPlayingTab::Queue => render_up_next_queue(store, cx),
        };

        let body_bg = if s.appearance.glass == resonance_core::models::GlassMode::Off {
            role_alpha(ColorRole::SURFACE_CONTAINER, 1.0)
        } else {
            role_alpha(ColorRole::SURFACE_CONTAINER_HIGHEST, 0.34)
        };

        div()
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .flex_col()
            .child(cover_box)
            .child(meta_block)
            .child(actions_row)
            .child(tabs)
            .child(
                div()
                    .flex_1()
                    .min_h(px(160.0))
                    .mt(px(12.0))
                    .rounded(px(24.0))
                    .overflow_hidden()
                    .bg(body_bg)
                    .p(px(10.0))
                    .child(tab_content),
            )
            .into_any_element()
    } else {
        div()
            .flex_1()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(10.0))
            .px(px(20.0))
            .child(ms_icon("music_note", false, 44.0, muted))
            .child(
                div()
                    .text_size(px(16.0))
                    .font_weight(gpui_kit::FontWeight::BOLD)
                    .text_color(ink)
                    .child(t(lang, Key::NothingPlaying)),
            )
            .child(
                div()
                    .text_size(px(13.0))
                    .text_color(muted)
                    .text_center()
                    .child(t(lang, Key::PickSomething)),
            )
            .into_any_element()
    };

    let st_close = store.clone();
    let mut shell = glass_panel_with_neon(
        &s.appearance,
        dark,
        SurfaceKind::SidePanel,
        28.0,
        s.resolved_theme.neon_argb,
    )
    .w(px(360.0))
    .h_full()
    .flex_shrink_0()
    .pt(px(20.0))
    .px(px(20.0))
    .pb(px(18.0))
    .flex()
    .flex_col();

    if mobile_drawer {
        shell = shell.w_full().child(
            div().mb(px(8.0)).flex().justify_end().child(m3_icon_button(
                "np-drawer-close",
                "close",
                false,
                M3IconBtnVariant::Standard,
                M3IconBtnSize::Sm,
                false,
                false,
                false,
                move |_, cx| {
                    st_close.update(cx, |s, cx| {
                        s.mobile_np_open = false;
                        cx.notify();
                    });
                },
            )),
        );
    }

    shell.child(body).into_any_element()
}

fn render_up_next_queue(store: &Entity<AppStore>, cx: &App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let accent = color(ColorRole::PRIMARY);
    let playing = s.status == PlaybackStatus::Playing;
    let cur_idx = s.queue_index.max(0) as usize;

    let upcoming: Vec<(usize, _)> = s
        .queue
        .iter()
        .enumerate()
        .skip(cur_idx)
        .take(60)
        .filter_map(|(i, id)| s.library.catalog.get(id).cloned().map(|tr| (i, tr)))
        .collect();

    if upcoming.len() <= 1 && s.current_track_id.is_none() || upcoming.is_empty() {
        return div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .p(px(16.0))
            .text_size(px(13.5))
            .text_color(muted)
            .text_center()
            .child(t(lang, Key::QueueEmpty))
            .into_any_element();
    }

    let mut list = div()
        .id("np-queue-scroll")
        .size_full()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(2.0));

    for (idx, tr) in upcoming {
        let is_cur = idx == cur_idx;
        let st_click = store.clone();
        let tr_click = tr.clone();
        list = list.child(
            div()
                .id(SharedString::from(format!("np-q-{idx}-{}", tr.id)))
                .h(px(56.0))
                .px(px(6.0))
                .rounded(px(16.0))
                .flex_shrink_0()
                .flex()
                .items_center()
                .gap(px(10.0))
                .cursor_pointer()
                .when(is_cur, |d| d.bg(role_alpha(ColorRole::PRIMARY, 0.13)))
                .when(!is_cur, |d| {
                    d.hover(|st| st.bg(role_alpha(ColorRole::ON_SURFACE, 0.06)))
                })
                .on_click(move |_, _, cx| {
                    if !is_cur {
                        let t_clone = tr_click.clone();
                        st_click.update(cx, |s, cx| {
                            s.queue_index = idx as isize;
                            s.play_track(t_clone, None, None, cx);
                        });
                    }
                })
                .child(cover_art_box(track_primary_cover(&tr), &tr.id, 40.0, 12.0))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(14.0))
                                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                .text_color(if is_cur { accent } else { ink })
                                .truncate()
                                .child(tr.title.clone()),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(muted)
                                .truncate()
                                .child(tr.artist.clone()),
                        ),
                )
                .child(if is_cur && playing {
                    div()
                        .mr(px(6.0))
                        .child(eq_playing_bars(s.wave_phase, accent.into()))
                } else {
                    div()
                        .text_size(px(12.0))
                        .text_color(if is_cur { accent } else { muted })
                        .pr(px(4.0))
                        .child(fmt_time(tr.duration))
                }),
        );
    }

    list.into_any_element()
}
