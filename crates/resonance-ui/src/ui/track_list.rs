use gpui_kit::{
    AnyElement, App, Entity, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::{MaterialMenu, MaterialMenuItem, MenuPopup};
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};
use resonance_core::models::{CreateInitialTab, DialogKind, PlaybackStatus, Track, fmt_time};

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{M3IconBtnSize, M3IconBtnVariant, m3_icon_button};
use crate::ui::{
    cover_art_box, eq_playing_bars, provider_badge, role_alpha, track_primary_cover,
};

pub struct TrackListProps {
    pub id_prefix: String,
    pub tracks: Vec<Track>,
    pub context_id: Option<String>,
    pub removable_playlist_id: Option<String>,
}

/// Renders an interactive M3 Expressive track list matching `.track-row` in `src/components/TrackList.tsx`.
pub fn render_track_list(
    store: &Entity<AppStore>,
    props: TrackListProps,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let cur_id = s.current_track_id.clone();
    let playing = s.status == PlaybackStatus::Playing;
    let wide_album = f32::from(window.viewport_size().width) >= 1080.0;

    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let primary = color(ColorRole::PRIMARY);
    let local_playlists: Vec<_> = s
        .library
        .playlists
        .iter()
        .map(|p| (p.id.clone(), p.name.clone()))
        .collect();
    let open_menu = s.open_track_menu_id.clone();

    let mut list = div().flex().flex_col().gap(px(2.0));
    let full_tracks = props.tracks.clone();

    for (idx, tr) in props.tracks.iter().enumerate() {
        let is_cur = cur_id.as_deref() == Some(&tr.id);
        let liked = s.is_liked(&tr.id);
        let disliked = s.is_disliked(&tr.id);
        let row_key = format!("{}-{idx}-{}", props.id_prefix, tr.id);
        let menu_open = open_menu.as_deref() == Some(row_key.as_str());

        let st_play = store.clone();
        let st_like = store.clone();
        let all_t = full_tracks.clone();
        let ctx_id = props.context_id.clone();
        let tid_like = tr.id.clone();

        // Build M3 Context MenuPopup
        let st_next = store.clone();
        let tr_next = tr.clone();
        let st_q = store.clone();
        let tr_q = tr.clone();
        let st_mlike = store.clone();
        let tid_mlike = tr.id.clone();
        let st_mdis = store.clone();
        let tid_mdis = tr.id.clone();
        let st_artist = store.clone();
        let artist_q = tr.artist.clone();
        let st_newpl = store.clone();
        let tid_newpl = tr.id.clone();

        let mut menu = MaterialMenu::new(SharedString::from(format!("{}-menu-{idx}", props.id_prefix)))
            .item(
                MaterialMenuItem::new(t(lang, Key::PlayNext))
                    .leading(ms_icon("playlist_play", false, 18.0, muted))
                    .on_click(move |_, _, cx| {
                        let t_c = tr_next.clone();
                        st_next.update(cx, |s, cx| {
                            s.open_track_menu_id = None;
                            s.play_next_in_queue(t_c, cx);
                        });
                    }),
            )
            .item(
                MaterialMenuItem::new(t(lang, Key::AddToQueue))
                    .leading(ms_icon("queue_music", false, 18.0, muted))
                    .on_click(move |_, _, cx| {
                        let t_c = tr_q.clone();
                        st_q.update(cx, |s, cx| {
                            s.open_track_menu_id = None;
                            s.add_to_queue(t_c, cx);
                        });
                    }),
            )
            .item(
                MaterialMenuItem::new(t(lang, if liked { Key::Unlike } else { Key::Like }))
                    .leading(ms_icon(
                        if liked { "favorite" } else { "favorite_border" },
                        liked,
                        18.0,
                        if liked { primary } else { muted },
                    ))
                    .on_click(move |_, _, cx| {
                        let id = tid_mlike.clone();
                        st_mlike.update(cx, |s, cx| {
                            s.open_track_menu_id = None;
                            s.toggle_like(&id, cx);
                        });
                    }),
            );

        for (pl_id, pl_name) in local_playlists.iter().take(6) {
            let st_addpl = store.clone();
            let pid_c = pl_id.clone();
            let t_c = tr.clone();
            menu = menu.item(
                MaterialMenuItem::new(format!("+ {pl_name}"))
                    .leading(ms_icon("playlist_add", false, 18.0, muted))
                    .on_click(move |_, _, cx| {
                        let pid = pid_c.clone();
                        let t = t_c.clone();
                        st_addpl.update(cx, |s, cx| {
                            s.open_track_menu_id = None;
                            s.add_track_to_playlist(&pid, t, cx);
                        });
                    }),
            );
        }

        menu = menu.item(
            MaterialMenuItem::new(t(lang, Key::NewPlaylist))
                .leading(ms_icon("add", false, 18.0, muted))
                .on_click(move |_, w, cx| {
                    let tid = tid_newpl.clone();
                    st_newpl.update(cx, |s, cx| {
                        s.open_track_menu_id = None;
                        s.dialog_name_input.update(cx, |inp, cx| inp.set_value("", w, cx));
                        s.create_initial_tab = CreateInitialTab::Scratch;
                        s.dialog = Some(DialogKind::Create {
                            track_id: Some(tid),
                            initial_tab: CreateInitialTab::Scratch,
                        });
                        cx.notify();
                    });
                }),
        );

        if let Some(ref rem_pl_id) = props.removable_playlist_id {
            let st_rem = store.clone();
            let pid_rem = rem_pl_id.clone();
            let tid_rem = tr.id.clone();
            menu = menu.item(
                MaterialMenuItem::new(t(lang, Key::RemoveFromPlaylist))
                    .leading(ms_icon("playlist_remove", false, 18.0, color(ColorRole::ERROR)))
                    .on_click(move |_, _, cx| {
                        let p = pid_rem.clone();
                        let tid = tid_rem.clone();
                        st_rem.update(cx, |s, cx| {
                            s.open_track_menu_id = None;
                            s.remove_track_from_playlist(&p, &tid, cx);
                        });
                    }),
            );
        }

        menu = menu
            .item(
                MaterialMenuItem::new(t(lang, Key::GoToArtist))
                    .leading(ms_icon("person", false, 18.0, muted))
                    .on_click(move |_, w, cx| {
                        let q = artist_q.clone();
                        st_artist.update(cx, |s, cx| {
                            s.open_track_menu_id = None;
                            s.open_search(Some(&q), w, cx);
                        });
                    }),
            )
            .item(
                MaterialMenuItem::new(t(lang, Key::Dislike))
                    .leading(ms_icon("thumb_down", disliked, 18.0, muted))
                    .on_click(move |_, _, cx| {
                        let id = tid_mdis.clone();
                        st_mdis.update(cx, |s, cx| {
                            s.open_track_menu_id = None;
                            s.toggle_dislike(&id, cx);
                        });
                    }),
            );

        let st_menu_open = store.clone();
        let rk_open = row_key.clone();
        let trigger = m3_icon_button(
            SharedString::from(format!("tr-more-{row_key}")),
            "more_vert",
            false,
            M3IconBtnVariant::Standard,
            M3IconBtnSize::Sm,
            false,
            false,
            false,
            move |_, cx| {
                let rk = rk_open.clone();
                st_menu_open.update(cx, |s, cx| {
                    s.open_track_menu_id = if s.open_track_menu_id.as_deref() == Some(rk.as_str()) {
                        None
                    } else {
                        Some(rk)
                    };
                    cx.notify();
                });
            },
        );

        let st_menu_chg = store.clone();
        let rk_chg = row_key.clone();
        let more_popup = MenuPopup::new(
            SharedString::from(format!("tr-pop-{row_key}")),
            trigger,
            menu,
        )
        .open(menu_open)
        .on_open_change(move |open: &bool, _, cx| {
            let is_open = *open;
            let rk = rk_chg.clone();
            st_menu_chg.update(cx, |s, cx| {
                if is_open {
                    s.open_track_menu_id = Some(rk);
                } else if s.open_track_menu_id.as_deref() == Some(rk.as_str()) {
                    s.open_track_menu_id = None;
                }
                cx.notify();
            });
        });

        let grp_name = SharedString::from(format!("tr-grp-{idx}"));
        let row_play_icon = if is_cur && playing { "pause" } else { "play_arrow" };

        list = list.child(
            div()
                .id(SharedString::from(format!("tr-row-{row_key}")))
                .group(grp_name.clone())
                .h(px(62.0))
                .px(px(8.0))
                .pl(px(4.0))
                .rounded(px(18.0))
                .flex()
                .items_center()
                .gap(px(12.0))
                .when(disliked, |d| d.opacity(0.45))
                .when(is_cur, |d| d.bg(role_alpha(ColorRole::PRIMARY, 0.13)))
                .when(!is_cur, |d| {
                    d.hover(|st| st.bg(role_alpha(ColorRole::ON_SURFACE, 0.06)))
                })
                .active(|d| d.rounded(px(26.0)))
                .child(
                    div()
                        .id(SharedString::from(format!("tr-play-{row_key}")))
                        .flex_1()
                        .min_w(px(0.0))
                        .flex()
                        .items_center()
                        .gap(px(12.0))
                        .cursor_pointer()
                        .on_click(move |_, _, cx| {
                            if is_cur {
                                st_play.update(cx, |s, cx| s.toggle_play(cx));
                            } else {
                                let tracks_c = all_t.clone();
                                let ctx = ctx_id.clone();
                                st_play.update(cx, |s, cx| {
                                    s.play_from_list_index(&tracks_c, idx, ctx, cx);
                                });
                            }
                        })
                        .child(
                            // .row-idx (32x32 swaps number/EQ for play/pause on hover)
                            div()
                                .relative()
                                .w(px(32.0))
                                .h(px(32.0))
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(
                                    div()
                                        .w_full()
                                        .h_full()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .group_hover(grp_name.clone(), |st| st.opacity(0.0))
                                        .child(if is_cur {
                                            if playing {
                                                eq_playing_bars(s.wave_phase, primary.into())
                                            } else {
                                                div()
                                                    .text_size(px(14.0))
                                                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                                    .text_color(primary)
                                                    .child((idx + 1).to_string())
                                                    .into_any_element()
                                            }
                                        } else {
                                            div()
                                                .text_size(px(14.0))
                                                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                                .text_color(muted)
                                                .child((idx + 1).to_string())
                                                .into_any_element()
                                        }),
                                )
                                .child(
                                    div()
                                        .absolute()
                                        .inset_0()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .opacity(0.0)
                                        .group_hover(grp_name.clone(), |st| st.opacity(1.0))
                                        .child(ms_icon(row_play_icon, true, 22.0, ink)),
                                ),
                        )
                        .child(cover_art_box(track_primary_cover(tr), &tr.id, 44.0, 14.0))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.0))
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .child(
                                            div()
                                                .min_w(px(0.0))
                                                .text_size(px(15.0))
                                                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                                .text_color(if is_cur { primary } else { ink })
                                                .truncate()
                                                .child(tr.title.clone()),
                                        )
                                        .when(tr.preview == Some(true), |d| {
                                            d.child(
                                                div()
                                                    .px(px(6.0))
                                                    .py(px(1.0))
                                                    .rounded(px(6.0))
                                                    .bg(role_alpha(ColorRole::TERTIARY_CONTAINER, 0.72))
                                                    .text_size(px(10.0))
                                                    .font_weight(gpui_kit::FontWeight::BOLD)
                                                    .text_color(color(ColorRole::ON_TERTIARY_CONTAINER))
                                                    .child(t(lang, Key::Preview)),
                                            )
                                        }),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .min_w(px(0.0))
                                        .child(provider_badge(tr.source, 16.0))
                                        .child(
                                            div()
                                                .min_w(px(0.0))
                                                .text_size(px(14.0))
                                                .text_color(muted)
                                                .truncate()
                                                .child(tr.artist.clone()),
                                        ),
                                ),
                        ),
                )
                .when_some(
                    tr.album
                        .as_ref()
                        .filter(|a| wide_album && !a.is_empty()),
                    |d, album_name| {
                        d.child(
                            div()
                                .w(gpui_kit::relative(0.24))
                                .min_w(px(0.0))
                                .text_size(px(14.0))
                                .text_color(muted)
                                .truncate()
                                .child(album_name.clone()),
                        )
                    },
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .when(!liked, |d| {
                            d.opacity(0.0).group_hover(grp_name.clone(), |st| st.opacity(1.0))
                        })
                        .child(m3_icon_button(
                            SharedString::from(format!("tr-like-{row_key}")),
                            if liked { "favorite" } else { "favorite_border" },
                            liked,
                            M3IconBtnVariant::Standard,
                            M3IconBtnSize::Sm,
                            false,
                            liked,
                            false,
                            move |_, cx| {
                                let id = tid_like.clone();
                                st_like.update(cx, |s, cx| s.toggle_like(&id, cx));
                            },
                        )),
                )
                .child(
                    div()
                        .w(px(44.0))
                        .flex_shrink_0()
                        .text_right()
                        .text_size(px(13.0))
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .text_color(muted)
                        .child(fmt_time(tr.duration)),
                )
                .child(more_popup),
        );
    }

    list.into_any_element()
}
