use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, Context, Entity, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::crossfade_plan::volume_to_pos;
use resonance_core::i18n::{Key, t};
use resonance_core::models::{PlaybackStatus, RepeatMode};

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{
    M3IconBtnSize, M3IconBtnVariant, M3PlayStyle, M3SliderStyle, m3_icon_button, m3_play_button,
    m3_slider,
};
use crate::ui::seek::{WavySeekProps, render_wavy_seek};
use crate::ui::{
    SurfaceKind, cover_art_box, glass_panel_with_neon, provider_badge, rgba_alpha,
    track_primary_cover,
};

/// Floating MiniPlayer bar rendered inside `.panel-center` (`bottom: 12px`, `left: 12px`, `right: 12px`),
/// matching `src/components/MiniPlayer.tsx` and `.mini` in `src/index.css`.
pub fn render_mini_player(
    store: &Entity<AppStore>,
    drag_seek: Rc<Cell<bool>>,
    compact: bool,
    window_w: f32,
    _window: &mut Window,
    cx: &mut Context<crate::ResonanceRoot>,
) -> AnyElement {
    let s = store.read(cx);
    let lang = s.appearance.lang;
    let dark = s.resolved_theme.dark;
    let tr = s.current_track().cloned();
    let playing = s.status == PlaybackStatus::Playing;
    let loading = s.status == PlaybackStatus::Loading;
    let has_track = tr.is_some();
    let shuffle = s.player.shuffle;
    let repeat = s.player.repeat;
    let volume = s.player.volume;
    let muted = s.player.muted;
    let np_open = s.ui.panel_open;
    let narrow = compact || window_w < 760.0;

    let ink = color(ColorRole::ON_SURFACE);
    let muted_col = color(ColorRole::ON_SURFACE_VARIANT);
    let play_style = M3PlayStyle::from_store(s);

    // Left: Artwork (60x60 rounded(16)) + Title + SourcePill + Artist + LikeButton
    let st_open = store.clone();
    let art_url = tr.as_ref().and_then(track_primary_cover).map(str::to_string);
    let art_id = tr
        .as_ref()
        .map(|track| track.id.clone())
        .unwrap_or_else(|| "none".into());
    let art_size = if compact { 54.0 } else { 60.0 };

    let cover_btn = div()
        .id("mini-cover-btn")
        .relative()
        .group("mini-cover")
        .rounded(px(16.0))
        .overflow_hidden()
        .flex_shrink_0()
        .when(has_track, |d| d.cursor_pointer())
        .on_click(move |_, _, cx| {
            st_open.update(cx, |s, cx| {
                if s.current_track_id.is_some() {
                    s.immersive_open = true;
                    cx.notify();
                }
            });
        })
        .child(cover_art_box(art_url.as_deref(), &art_id, art_size, 16.0))
        .when(has_track, |d| {
            d.child(
                div()
                    .absolute()
                    .inset_0()
                    .bg(rgba_alpha(gpui_kit::rgb(0x000000), 0.45))
                    .flex()
                    .items_center()
                    .justify_center()
                    .opacity(0.0)
                    .group_hover("mini-cover", |st| st.opacity(1.0))
                    .child(ms_icon("open_in_full", false, 22.0, gpui_kit::rgb(0xffffff))),
            )
        });

    let mut meta = div()
        .flex_1()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .justify_center()
        .gap(px(2.0));

    if let Some(ref track) = tr {
        let st_art = store.clone();
        let artist = track.artist.clone();
        meta = meta
            .child(
                div()
                    .text_size(px(15.0))
                    .line_height(px(19.0))
                    .font_weight(gpui_kit::FontWeight::BOLD)
                    .text_color(ink)
                    .truncate()
                    .child(track.title.clone()),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .min_w(px(0.0))
                    .child(provider_badge(track.source, 16.0))
                    .child(
                        div()
                            .id("mini-artist-link")
                            .min_w(px(0.0))
                            .text_size(px(13.0))
                            .text_color(muted_col)
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
    } else {
        meta = meta
            .child(
                div()
                    .text_size(px(15.0))
                    .font_weight(gpui_kit::FontWeight::BOLD)
                    .text_color(ink)
                    .truncate()
                    .child(t(lang, Key::NothingPlaying)),
            )
            .child(
                div()
                    .text_size(px(13.0))
                    .text_color(muted_col)
                    .truncate()
                    .child(t(lang, Key::PickSomething)),
            );
    }

    let mut left = div()
        .flex_1()
        .min_w(px(0.0))
        .flex()
        .items_center()
        .gap(px(12.0))
        .child(cover_btn)
        .child(meta);

    if let Some(ref track) = tr
        && !compact
    {
        let st_like = store.clone();
        let tid = track.id.clone();
        let liked = s.is_liked(&track.id);
        left = left.child(m3_icon_button(
            "mini-like",
            if liked { "favorite" } else { "favorite_border" },
            liked,
            M3IconBtnVariant::Standard,
            M3IconBtnSize::Sm,
            false,
            liked,
            false,
            move |_, cx| {
                let id = tid.clone();
                st_like.update(cx, |s, cx| s.toggle_like(&id, cx));
            },
        ));
    }

    // Center: Transport Controls + Wavy Seek
    let st_shuf = store.clone();
    let st_prev = store.clone();
    let st_play = store.clone();
    let st_next = store.clone();
    let st_rep = store.clone();
    let st_seek = store.clone();

    let mut transport = div()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(4.0));

    if !compact {
        transport = transport.child(m3_icon_button(
            "mini-shuffle",
            "shuffle",
            shuffle,
            M3IconBtnVariant::Standard,
            M3IconBtnSize::Md,
            true,
            shuffle,
            false,
            move |_, cx| {
                st_shuf.update(cx, |s, cx| s.toggle_shuffle(cx));
            },
        ));
    }

    transport = transport
        .child(m3_icon_button(
            "mini-prev",
            "skip_previous",
            true,
            M3IconBtnVariant::Standard,
            M3IconBtnSize::Md,
            false,
            false,
            !has_track,
            move |_, cx| {
                st_prev.update(cx, |s, cx| s.prev_track(cx));
            },
        ))
        .child(m3_play_button(
            "mini-play-pause",
            52.0,
            playing,
            loading,
            !has_track,
            play_style,
            move |_, cx| {
                st_play.update(cx, |s, cx| s.toggle_play(cx));
            },
        ))
        .child(m3_icon_button(
            "mini-next",
            "skip_next",
            true,
            M3IconBtnVariant::Standard,
            M3IconBtnSize::Md,
            false,
            false,
            !has_track,
            move |_, cx| {
                st_next.update(cx, |s, cx| s.next_track(cx));
            },
        ));

    if !compact {
        let rep_icon = if repeat == RepeatMode::One {
            "repeat_one"
        } else {
            "repeat"
        };
        let rep_on = repeat != RepeatMode::Off;
        transport = transport.child(m3_icon_button(
            "mini-repeat",
            rep_icon,
            rep_on,
            M3IconBtnVariant::Standard,
            M3IconBtnSize::Md,
            true,
            rep_on,
            false,
            move |_, cx| {
                st_rep.update(cx, |s, cx| s.cycle_repeat(cx));
            },
        ));
    }

    let dur = s.duration.max(tr.as_ref().map(|t| t.duration).unwrap_or(0.0));
    let seek_el = render_wavy_seek(
        WavySeekProps {
            id_prefix: "mini-seek".into(),
            position: s.position,
            duration: dur,
            phase: s.wave_phase,
            amp: s.wave_amp,
            metallic_neon: s.appearance.metallic && s.appearance.metallic_neon,
            neon_argb: s.resolved_theme.neon_argb,
            neon_intensity: s.resolved_theme.neon_intensity,
            compact: true,
        },
        drag_seek,
        move |sec, cx| {
            st_seek.update(cx, |s, cx| s.seek_to(sec, cx));
        },
    );

    let center = div()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(2.0))
        .when(!compact, |d| d.flex_1().min_w(px(240.0)).max_w(px(560.0)))
        .child(transport)
        .when(!compact, |d| d.child(seek_el));

    // Right: Fullscreen Lyrics + Right Panel Toggle + Compact Volume Slider
    let st_full = store.clone();
    let st_panel = store.clone();
    let st_mute = store.clone();
    let st_vol = store.clone();

    let vol_icon = if muted || volume <= 0.01 {
        "volume_off"
    } else if volume < 0.25 {
        "volume_down"
    } else {
        "volume_up"
    };
    let vol_pos = if muted { 0.0 } else { volume_to_pos(volume) };
    let slider_style = M3SliderStyle::from_store(s, true);

    let right = div()
        .flex_1()
        .min_w(px(0.0))
        .flex()
        .items_center()
        .justify_end()
        .gap(px(4.0))
        .when(!narrow, |d| {
            d.child(m3_icon_button(
                "mini-lyrics-full",
                "lyrics",
                false,
                M3IconBtnVariant::Standard,
                M3IconBtnSize::Md,
                false,
                false,
                !has_track,
                move |_, cx| {
                    st_full.update(cx, |s, cx| {
                        s.immersive_open = true;
                        cx.notify();
                    });
                },
            ))
        })
        .when(!compact, |d| {
            d.child(m3_icon_button(
                "mini-np-toggle",
                if np_open {
                    "right_panel_close"
                } else {
                    "right_panel_open"
                },
                np_open,
                M3IconBtnVariant::Standard,
                M3IconBtnSize::Md,
                true,
                np_open,
                false,
                move |_, cx| {
                    st_panel.update(cx, |s, cx| {
                        if window_w >= 1200.0 {
                            s.ui.panel_open = !s.ui.panel_open;
                            s.mark_dirty();
                        } else {
                            s.mobile_np_open = !s.mobile_np_open;
                        }
                        cx.notify();
                    });
                },
            ))
        })
        .when(!compact, |d| {
            d.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .ml(px(2.0))
                    .child(m3_icon_button(
                        "mini-mute",
                        vol_icon,
                        true,
                        M3IconBtnVariant::Standard,
                        M3IconBtnSize::Sm,
                        false,
                        false,
                        false,
                        move |_, cx| {
                            st_mute.update(cx, |s, cx| s.toggle_mute(cx));
                        },
                    ))
                    .when(!narrow, |v| {
                        v.child(
                            div().w(px(112.0)).child(m3_slider(
                                "mini-volume",
                                vol_pos,
                                Some(0.01),
                                slider_style,
                                move |pos, cx| {
                                    st_vol.update(cx, |s, cx| s.set_volume(pos, cx));
                                },
                            )),
                        )
                    }),
            )
        });

    let mut shell = glass_panel_with_neon(
        &s.appearance,
        dark,
        SurfaceKind::MiniPanel,
        26.0,
        s.resolved_theme.neon_argb,
    )
    .relative()
    .w_full()
    .min_h(px(if compact { 76.0 } else { 84.0 }))
    .pt(px(10.0))
    .pb(px(10.0))
    .pl(px(10.0))
    .pr(px(14.0))
    .flex()
    .items_center()
    .gap(px(12.0));

    // Compact top micro-progress strip (.mini-line)
    if compact {
        let f = if dur > 0.001 {
            (s.position / dur).clamp(0.0, 1.0) as f32
        } else {
            0.0
        };
        shell = shell.child(
            div()
                .absolute()
                .top(px(0.0))
                .left(px(22.0))
                .right(px(22.0))
                .h(px(3.0))
                .rounded(px(3.0))
                .overflow_hidden()
                .bg(color(ColorRole::SECONDARY_CONTAINER))
                .child(div().h_full().w(gpui_kit::relative(f)).bg(color(ColorRole::PRIMARY))),
        );
    }

    shell.child(left).child(center).child(right).into_any_element()
}
