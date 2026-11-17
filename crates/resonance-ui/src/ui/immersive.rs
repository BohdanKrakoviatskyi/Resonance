use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, StyledImage, Window, div, img,
    linear_color_stop, linear_gradient, point, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::crossfade_plan::volume_to_pos;
use resonance_core::i18n::{Key, t};
use resonance_core::models::{PlaybackStatus, RepeatMode, Track};

use crate::store::AppStore;
use crate::ui::controls::{
    M3IconBtnSize, M3IconBtnVariant, M3PlayStyle, M3SliderStyle, m3_icon_button, m3_play_button,
    m3_slider,
};
use crate::ui::eq_panel::render_eq_card;
use crate::ui::lyrics::render_lyrics_body;
use crate::ui::seek::{WavySeekProps, render_wavy_seek};
use crate::ui::{
    cover_art_box, provider_badge, rgba_alpha, track_primary_cover,
};

/// Fullscreen Immersive Lyrics / Equalizer + 3D-feel Cover Carousel matching `src/components/Immersive.tsx`.
pub fn render_immersive(
    store: &Entity<AppStore>,
    drag_seek: Rc<Cell<bool>>,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let s = store.read(cx);
    if !s.immersive_open {
        return div().into_any_element();
    }

    let tr = s.current_track().cloned();
    let lang = s.lang();
    let playing = s.status == PlaybackStatus::Playing;
    let loading = s.status == PlaybackStatus::Loading;
    let eq_open = s.eq_open;

    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let primary = color(ColorRole::PRIMARY);
    let play_style = M3PlayStyle::from_store(s);

    let st_close = store.clone();
    let st_eq = store.clone();

    let backdrop = if let Some(ref url) = tr.as_ref().and_then(track_primary_cover) {
        div()
            .absolute()
            .inset_0()
            .child(
                img(url.to_string())
                    .size_full()
                    .object_fit(gpui_kit::ObjectFit::Cover),
            )
            .child(div().absolute().inset_0().bg(linear_gradient(
                180.0,
                linear_color_stop(rgba_alpha(color(ColorRole::SURFACE), 0.72), 0.0),
                linear_color_stop(rgba_alpha(color(ColorRole::SURFACE), 0.90), 1.0),
            )))
    } else {
        div()
            .absolute()
            .inset_0()
            .bg(rgba_alpha(color(ColorRole::SURFACE), 0.94))
    };

    // Top bar (.imm-top: right-aligned EQ toggle + Exit Fullscreen button)
    let top_bar = div()
        .w_full()
        .px(px(22.0))
        .pt(px(18.0))
        .pb(px(10.0))
        .flex()
        .items_center()
        .justify_end()
        .gap(px(8.0))
        .child(m3_icon_button(
            "imm-eq",
            "equalizer",
            eq_open,
            M3IconBtnVariant::Glass,
            M3IconBtnSize::Md,
            true,
            eq_open,
            false,
            move |_, cx| {
                st_eq.update(cx, |s, cx| {
                    s.eq_open = !s.eq_open;
                    cx.notify();
                });
            },
        ))
        .child(m3_icon_button(
            "imm-close",
            "close_fullscreen",
            false,
            M3IconBtnVariant::Glass,
            M3IconBtnSize::Md,
            false,
            false,
            false,
            move |_, cx| {
                st_close.update(cx, |s, cx| {
                    s.immersive_open = false;
                    cx.notify();
                });
            },
        ));

    // Overlapping Coverflow Carousel matching `.imm-carousel`
    let cur_idx = s.queue_index.max(0) as usize;
    let slot_offsets: [isize; 3] = [-1, 0, 1];
    let mut carousel = div()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(14.0))
        .py(px(8.0));

    for off in slot_offsets {
        let target_i = cur_idx as isize + off;
        let slot_track: Option<Track> = if target_i >= 0 {
            s.queue
                .get(target_i as usize)
                .and_then(|id| s.library.catalog.get(id))
                .cloned()
        } else {
            None
        };
        let (box_size, alpha, radius) = if off == 0 {
            (310.0, 1.0, 36.0)
        } else {
            (180.0, 0.52, 26.0)
        };
        if let Some(st_tr) = slot_track {
            let st_jump = store.clone();
            let j_idx = target_i as usize;
            let tr_jump = st_tr.clone();
            carousel = carousel.child(
                div()
                    .id(SharedString::from(format!("imm-cf-{off}")))
                    .relative()
                    .opacity(alpha)
                    .cursor_pointer()
                    .on_click(move |_, _, cx| {
                        let t_c = tr_jump.clone();
                        st_jump.update(cx, |s, cx| {
                            if off == 0 {
                                s.toggle_play(cx);
                            } else {
                                s.queue_index = j_idx as isize;
                                s.play_track(t_c, None, None, cx);
                            }
                        });
                    })
                    .child(
                        cover_art_box(track_primary_cover(&st_tr), &st_tr.id, box_size, radius)
                            .shadow(vec![BoxShadow {
                                color: rgba_alpha(gpui_kit::rgb(0x000000), if off == 0 { 0.68 } else { 0.45 }),
                                offset: point(px(0.0), px(if off == 0 { 30.0 } else { 18.0 })),
                                blur_radius: px(if off == 0 { 80.0 } else { 44.0 }),
                                spread_radius: px(-24.0),
                                inset: false,
                            }]),
                    ),
            );
        } else {
            carousel = carousel.child(div().w(px(box_size)).h(px(box_size)));
        }
    }

    let left_col = if let Some(ref track) = tr {
        let liked = s.is_liked(&track.id);
        let disliked = s.is_disliked(&track.id);
        let st_l = store.clone();
        let st_d = store.clone();
        let st_art = store.clone();
        let st_sh = store.clone();
        let st_p = store.clone();
        let st_pl = store.clone();
        let st_n = store.clone();
        let st_r = store.clone();
        let st_sk = store.clone();
        let st_m = store.clone();
        let st_vol = store.clone();
        let tid_l = track.id.clone();
        let tid_d = track.id.clone();
        let artist = track.artist.clone();

        let seek_el = render_wavy_seek(
            WavySeekProps {
                id_prefix: "imm-seek".into(),
                position: s.position,
                duration: s.duration.max(track.duration),
                phase: s.wave_phase,
                amp: s.wave_amp,
                metallic_neon: s.appearance.metallic && s.appearance.metallic_neon,
                neon_argb: s.resolved_theme.neon_argb,
                neon_intensity: s.resolved_theme.neon_intensity,
                compact: false,
            },
            drag_seek,
            move |sec, cx| st_sk.update(cx, |s, cx| s.seek_to(sec, cx)),
        );

        let rep_icon = if s.player.repeat == RepeatMode::One {
            "repeat_one"
        } else {
            "repeat"
        };
        let rep_on = s.player.repeat != RepeatMode::Off;
        let vol_pos = if s.player.muted {
            0.0
        } else {
            volume_to_pos(s.player.volume)
        };
        let slider_style = M3SliderStyle::from_store(s, true);

        div()
            .flex_1()
            .max_w(px(620.0))
            .h_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(16.0))
            .child(carousel)
            .child(
                div()
                    .w_full()
                    .max_w(px(540.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(
                                div()
                                    .text_size(px(32.0))
                                    .line_height(px(36.0))
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
                                            .id("imm-artist-link")
                                            .min_w(px(0.0))
                                            .text_size(px(16.0))
                                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                                            .text_color(muted)
                                            .truncate()
                                            .cursor_pointer()
                                            .hover(|st| st.text_color(primary))
                                            .on_click(move |_, w, cx| {
                                                let q = artist.clone();
                                                st_art.update(cx, |s, cx| {
                                                    s.immersive_open = false;
                                                    s.open_search(Some(&q), w, cx);
                                                });
                                            })
                                            .child(track.artist.clone()),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(m3_icon_button(
                                "imm-like",
                                if liked { "favorite" } else { "favorite_border" },
                                liked,
                                M3IconBtnVariant::Standard,
                                M3IconBtnSize::Lg,
                                false,
                                liked,
                                false,
                                move |_, cx| {
                                    let id = tid_l.clone();
                                    st_l.update(cx, |s, cx| s.toggle_like(&id, cx));
                                },
                            ))
                            .child(m3_icon_button(
                                "imm-dislike",
                                "thumb_down",
                                disliked,
                                M3IconBtnVariant::Standard,
                                M3IconBtnSize::Lg,
                                false,
                                disliked,
                                false,
                                move |_, cx| {
                                    let id = tid_d.clone();
                                    st_d.update(cx, |s, cx| s.toggle_dislike(&id, cx));
                                },
                            )),
                    ),
            )
            .child(div().w_full().max_w(px(540.0)).child(seek_el))
            .child(
                // .controls-lg + volume slider
                div()
                    .w_full()
                    .max_w(px(540.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(m3_icon_button(
                                "imm-shuf",
                                "shuffle",
                                s.player.shuffle,
                                M3IconBtnVariant::Standard,
                                M3IconBtnSize::Md,
                                true,
                                s.player.shuffle,
                                false,
                                move |_, cx| st_sh.update(cx, |s, cx| s.toggle_shuffle(cx)),
                            ))
                            .child(m3_icon_button(
                                "imm-prev",
                                "skip_previous",
                                true,
                                M3IconBtnVariant::Standard,
                                M3IconBtnSize::Lg,
                                false,
                                false,
                                false,
                                move |_, cx| st_p.update(cx, |s, cx| s.prev_track(cx)),
                            ))
                            .child(m3_play_button(
                                "imm-play",
                                76.0,
                                playing,
                                loading,
                                false,
                                play_style,
                                move |_, cx| st_pl.update(cx, |s, cx| s.toggle_play(cx)),
                            ))
                            .child(m3_icon_button(
                                "imm-next",
                                "skip_next",
                                true,
                                M3IconBtnVariant::Standard,
                                M3IconBtnSize::Lg,
                                false,
                                false,
                                false,
                                move |_, cx| st_n.update(cx, |s, cx| s.next_track(cx)),
                            ))
                            .child(m3_icon_button(
                                "imm-rep",
                                rep_icon,
                                rep_on,
                                M3IconBtnVariant::Standard,
                                M3IconBtnSize::Md,
                                true,
                                rep_on,
                                false,
                                move |_, cx| st_r.update(cx, |s, cx| s.cycle_repeat(cx)),
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(m3_icon_button(
                                "imm-mute",
                                if s.player.muted || s.player.volume <= 0.01 {
                                    "volume_off"
                                } else if s.player.volume < 0.25 {
                                    "volume_down"
                                } else {
                                    "volume_up"
                                },
                                true,
                                M3IconBtnVariant::Standard,
                                M3IconBtnSize::Sm,
                                false,
                                false,
                                false,
                                move |_, cx| st_m.update(cx, |s, cx| s.toggle_mute(cx)),
                            ))
                            .child(
                                div().w(px(118.0)).child(m3_slider(
                                    "imm-vol-sl",
                                    vol_pos,
                                    Some(0.01),
                                    slider_style,
                                    move |pos, cx| {
                                        st_vol.update(cx, |s, cx| s.set_volume(pos, cx));
                                    },
                                )),
                            ),
                    ),
            )
            .into_any_element()
    } else {
        div()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(18.0))
            .text_color(muted)
            .child(t(lang, Key::NothingPlaying))
            .into_any_element()
    };

    // Right column: toggles seamlessly between .imm-eq-card and transparent borderless .imm-lyrics-card
    let right_col = if eq_open {
        div()
            .flex_1()
            .min_w(px(0.0))
            .max_w(px(640.0))
            .h_full()
            .max_h(px(660.0))
            .flex()
            .items_center()
            .child(render_eq_card(store, true, cx))
            .into_any_element()
    } else if let Some(ref track) = tr {
        let lyr_data = s.lyrics_cache.get(&track.id).cloned().flatten();
        let lyr_loading = s.lyrics_loading.contains(&track.id);
        let has_manual = s.manual_lyrics.contains_key(&track.id);
        div()
            .flex_1()
            .min_w(px(0.0))
            .max_w(px(640.0))
            .h_full()
            .max_h(px(680.0))
            .px(px(12.0))
            .child(render_lyrics_body(
                store,
                track,
                lyr_data.as_ref(),
                lyr_loading,
                has_manual,
                true,
                cx,
            ))
            .into_any_element()
    } else {
        div().into_any_element()
    };

    div()
        .id("immersive-overlay")
        .absolute()
        .inset_0()
        .child(backdrop)
        .child(
            div()
                .relative()
                .size_full()
                .flex()
                .flex_col()
                .child(top_bar)
                .child(
                    div()
                        .flex_1()
                        .min_h(px(0.0))
                        .max_w(px(1620.0))
                        .w_full()
                        .mx_auto()
                        .px(px(44.0))
                        .pb(px(24.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap(px(56.0))
                        .child(left_col)
                        .child(right_col),
                ),
        )
        .into_any_element()
}
