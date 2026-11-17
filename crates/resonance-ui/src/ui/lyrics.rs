use gpui_kit::{
    AnyElement, App, Entity, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::LoadingIndicator;
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};
use resonance_core::matching::LyricsData;
use resonance_core::models::{LyricLine, Track};

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{
    M3IconBtnSize, M3IconBtnVariant, m3_icon_button,
};
use crate::ui::{rgba_alpha, role_alpha};

pub fn active_lyric_index(lines: &[LyricLine], position: f64) -> Option<usize> {
    if lines.is_empty() {
        return None;
    }
    let t = position + 0.12;
    let mut lo = 0usize;
    let mut hi = lines.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if lines[mid].t <= t {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo.checked_sub(1)
}

/// Lyrics display matching `src/components/Lyrics.tsx` and `.lyrics` in `src/index.css`.
pub fn render_lyrics_body(
    store: &Entity<AppStore>,
    _track: &Track,
    data: Option<&LyricsData>,
    loading: bool,
    has_manual_override: bool,
    large_immersive: bool,
    cx: &App,
) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let position = s.position;
    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let accent = color(ColorRole::PRIMARY);

    let st_change = store.clone();
    let st_reset = store.clone();

    let toolbar = div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(6.0))
        .pb(px(6.0))
        .child(
            div()
                .when(data.is_some_and(|d| d.preview), |d| {
                    d.child(
                        div()
                            .px(px(10.0))
                            .py(px(5.0))
                            .rounded(px(10.0))
                            .bg(role_alpha(ColorRole::TERTIARY, 0.18))
                            .text_size(px(12.0))
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .text_color(color(ColorRole::TERTIARY))
                            .child(t(lang, Key::PreviewNote)),
                    )
                }),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(4.0))
                .child(m3_icon_button(
                    if large_immersive {
                        "lyr-chg-imm"
                    } else {
                        "lyr-chg-np"
                    },
                    "search",
                    false,
                    M3IconBtnVariant::Standard,
                    M3IconBtnSize::Sm,
                    false,
                    false,
                    false,
                    move |w, cx| {
                        st_change.update(cx, |s, cx| s.open_lyrics_search(w, cx));
                    },
                ))
                .when(has_manual_override, |d| {
                    d.child(m3_icon_button(
                        if large_immersive {
                            "lyr-rst-imm"
                        } else {
                            "lyr-rst-np"
                        },
                        "refresh",
                        false,
                        M3IconBtnVariant::Standard,
                        M3IconBtnSize::Sm,
                        false,
                        false,
                        false,
                        move |_, cx| {
                            st_reset.update(cx, |s, cx| s.reset_manual_lyrics(cx));
                        },
                    ))
                }),
        );

    if loading {
        return div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.0))
            .child(LoadingIndicator::new(
                "lyr-loading",
                t(lang, Key::LyricsLoading),
            ))
            .child(
                div()
                    .text_size(px(13.5))
                    .text_color(muted)
                    .child(t(lang, Key::LyricsLoading)),
            )
            .into_any_element();
    }

    let Some(lyr) = data else {
        return div()
            .size_full()
            .flex()
            .flex_col()
            .child(toolbar)
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(10.0))
                    .child(ms_icon("lyrics", false, 36.0, muted))
                    .child(
                        div()
                            .text_size(px(14.0))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(muted)
                            .text_center()
                            .child(t(lang, Key::NoLyrics)),
                    ),
            )
            .into_any_element();
    };

    if lyr.instrumental {
        return div()
            .size_full()
            .flex()
            .flex_col()
            .child(toolbar)
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(12.0))
                    .child(ms_icon("graphic_eq", true, 42.0, accent))
                    .child(
                        div()
                            .text_size(px(15.0))
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .text_color(ink)
                            .child(t(lang, Key::Instrumental)),
                    ),
            )
            .into_any_element();
    }

    let font_main = if large_immersive { 34.0 } else { 21.0 };
    let font_active = if large_immersive { 38.0 } else { 22.0 };
    let line_h = if large_immersive { 44.0 } else { 27.0 };

    if let Some(ref synced) = lyr.synced {
        let active_idx = active_lyric_index(synced, position);
        let mut scroll = div()
            .id(if large_immersive {
                "lyr-sync-imm"
            } else {
                "lyr-sync-np"
            })
            .flex_1()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(if large_immersive { 20.0 } else { 14.0 }))
            .py(px(if large_immersive { 24.0 } else { 14.0 }))
            .px(px(6.0));

        for (i, line) in synced.iter().enumerate() {
            let is_active = active_idx == Some(i);
            let st_seek = store.clone();
            let line_t = line.t;

            if line.gap {
                let mut row = div().flex().items_center().gap(px(8.0)).py(px(6.0));
                for d in 0..3 {
                    let pulse = if is_active {
                        0.40 + 0.60 * (0.5 + 0.5 * (position * 3.0 + d as f64).sin() as f32)
                    } else {
                        0.28
                    };
                    row = row.child(
                        div()
                            .w(px(if large_immersive { 11.0 } else { 8.0 }))
                            .h(px(if large_immersive { 11.0 } else { 8.0 }))
                            .rounded_full()
                            .bg(rgba_alpha(ink, pulse)),
                    );
                }
                scroll = scroll.child(row);
                continue;
            }

            let text_col = if is_active {
                rgba_alpha(ink, 1.0)
            } else {
                rgba_alpha(ink, 0.34)
            };

            scroll = scroll.child(
                div()
                    .id(SharedString::from(format!("lyr-ln-{large_immersive}-{i}")))
                    .cursor_pointer()
                    .hover(move |st| {
                        st.text_color(rgba_alpha(
                            ink,
                            if is_active { 1.0 } else { 0.62 },
                        ))
                    })
                    .on_click(move |_, _, cx| {
                        st_seek.update(cx, |s, cx| s.seek_to(line_t, cx));
                    })
                    .text_size(px(if is_active { font_active } else { font_main }))
                    .line_height(px(line_h))
                    .font_weight(gpui_kit::FontWeight::EXTRA_BOLD)
                    .text_color(text_col)
                    .child(line.text.clone()),
            );
        }

        return div()
            .size_full()
            .flex()
            .flex_col()
            .child(toolbar)
            .child(scroll)
            .into_any_element();
    }

    let plain_lines = lyr.plain.as_deref().unwrap_or(&[]);
    let plain_sz = if large_immersive { 26.0 } else { 19.0 };
    let plain_lh = if large_immersive { 34.0 } else { 25.0 };
    let mut scroll = div()
        .id(if large_immersive {
            "lyr-plain-imm"
        } else {
            "lyr-plain-np"
        })
        .flex_1()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(8.0))
        .py(px(if large_immersive { 24.0 } else { 14.0 }))
        .px(px(6.0));

    for line in plain_lines {
        scroll = scroll.child(
            div()
                .text_size(px(plain_sz))
                .line_height(px(plain_lh))
                .font_weight(gpui_kit::FontWeight::BOLD)
                .text_color(rgba_alpha(ink, 0.85))
                .child(line.clone()),
        );
    }

    div()
        .size_full()
        .flex()
        .flex_col()
        .child(toolbar)
        .child(scroll)
        .into_any_element()
}
