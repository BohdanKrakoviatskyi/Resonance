use gpui_kit::{
    AnyElement, App, Entity, IntoElement, ParentElement, SharedString, Styled, Window, div,
    prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};
use resonance_core::models::{CrossfadeCurve, NormalizationTarget, Route};

use crate::store::AppStore;
use crate::ui::controls::{
    M3SliderStyle, SegOption, m3_card, m3_segmented, m3_slider, section_card_header,
    subpage_header,
};

/// Audio settings page matching `src/pages/AudioSettings.tsx`.
pub fn render_audio_page(store: &Entity<AppStore>, _window: &mut Window, cx: &mut App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.appearance.lang;
    let dark = s.resolved_theme.dark;
    let norm_en = s.player.normalization_enabled;
    let norm_tgt = s.player.normalization_target;
    let xf_en = s.player.crossfade_enabled;
    let xf_dur = s.player.crossfade_duration;
    let xf_curve = s.player.crossfade_curve;

    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let ink = color(ColorRole::ON_SURFACE);

    let st_back = store.clone();
    let header = subpage_header(
        t(lang, Key::Settings),
        t(lang, Key::AudioSettings),
        t(lang, Key::AudioSettingsSub),
        move |w, cx| {
            st_back.update(cx, |s, cx| s.navigate(Route::Settings, w, cx));
        },
    );

    // 1. Loudness Normalization Card
    let st_norm_toggle = store.clone();
    let st_norm_tgt = store.clone();
    let norm_card = m3_card(&s.appearance, dark)
        .flex()
        .flex_col()
        .child(section_card_header(
            "graphic_eq",
            t(lang, Key::AudioNormalization),
            Some(SharedString::from(t(lang, Key::AudioNormalizationDesc))),
        ))
        .child(m3_segmented(
            "aud-norm-en",
            norm_en,
            vec![
                SegOption::icon_text(true, "check", t(lang, Key::Enabled)),
                SegOption::text(false, t(lang, Key::Disabled)),
            ],
            false,
            move |enabled, cx| {
                st_norm_toggle.update(cx, |s, cx| {
                    let tgt = s.player.normalization_target;
                    s.set_normalization(enabled, tgt, cx);
                });
            },
        ))
        .child(
            div()
                .mt(px(20.0))
                .when(!norm_en, |d| d.opacity(0.40))
                .flex()
                .flex_col()
                .child(
                    div()
                        .mb(px(8.0))
                        .text_size(px(14.0))
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .text_color(ink)
                        .child(t(lang, Key::TargetLoudness)),
                )
                .child(m3_segmented(
                    "aud-norm-tgt",
                    norm_tgt,
                    vec![
                        SegOption::icon_text(
                            NormalizationTarget::Quiet,
                            "volume_down",
                            t(lang, Key::LoudnessQuiet),
                        ),
                        SegOption::icon_text(
                            NormalizationTarget::Normal,
                            "graphic_eq",
                            t(lang, Key::LoudnessNormal),
                        ),
                        SegOption::icon_text(
                            NormalizationTarget::Loud,
                            "volume_up",
                            t(lang, Key::LoudnessLoud),
                        ),
                    ],
                    false,
                    move |tgt, cx| {
                        st_norm_tgt.update(cx, |s, cx| {
                            if s.player.normalization_enabled {
                                s.set_normalization(true, tgt, cx);
                            }
                        });
                    },
                )),
        );

    // 2. Crossfade Card
    let st_xf_toggle = store.clone();
    let st_xf_dur = store.clone();
    let st_xf_curve = store.clone();
    let curve_desc = match xf_curve {
        CrossfadeCurve::Linear => t(lang, Key::CurveLinearDesc),
        CrossfadeCurve::EqualPower => t(lang, Key::CurveEqualPowerDesc),
        CrossfadeCurve::SCurve => t(lang, Key::CurveSCurveDesc),
    };
    let slider_val = (((xf_dur - 1.0) / 11.0).clamp(0.0, 1.0)) as f32;
    let mut slider_style = M3SliderStyle::from_store(s, false);
    slider_style.disabled = !xf_en;

    let xf_card = m3_card(&s.appearance, dark)
        .flex()
        .flex_col()
        .child(section_card_header(
            "tune",
            t(lang, Key::Crossfade),
            Some(SharedString::from(t(lang, Key::CrossfadeDesc))),
        ))
        .child(m3_segmented(
            "aud-xf-en",
            xf_en,
            vec![
                SegOption::icon_text(true, "check", t(lang, Key::Enabled)),
                SegOption::text(false, t(lang, Key::Disabled)),
            ],
            false,
            move |enabled, cx| {
                st_xf_toggle.update(cx, |s, cx| {
                    let dur = s.player.crossfade_duration;
                    let curve = s.player.crossfade_curve;
                    s.set_crossfade(enabled, dur, curve, cx);
                });
            },
        ))
        .child(
            div()
                .mt(px(20.0))
                .when(!xf_en, |d| d.opacity(0.40))
                .flex()
                .flex_col()
                .child(
                    div()
                        .mb(px(6.0))
                        .flex()
                        .justify_between()
                        .text_size(px(14.0))
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .child(div().text_color(ink).child(t(lang, Key::CrossfadeDurationLabel)))
                        .child(
                            div()
                                .text_color(muted)
                                .child(format!("{xf_dur:.1} {}", t(lang, Key::SecUnit))),
                        ),
                )
                .child(m3_slider(
                    "aud-xf-dur",
                    slider_val,
                    Some(0.5 / 11.0),
                    slider_style,
                    move |frac, cx| {
                        let raw = 1.0 + (frac as f64) * 11.0;
                        let snapped = ((raw * 2.0).round() / 2.0).clamp(1.0, 12.0);
                        st_xf_dur.update(cx, |s, cx| {
                            if s.player.crossfade_enabled {
                                let curve = s.player.crossfade_curve;
                                s.set_crossfade(true, snapped, curve, cx);
                            }
                        });
                    },
                ))
                .child(
                    div()
                        .mt(px(20.0))
                        .mb(px(8.0))
                        .text_size(px(14.0))
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .text_color(ink)
                        .child(t(lang, Key::CrossfadeCurveLabel)),
                )
                .child(m3_segmented(
                    "aud-xf-curve",
                    xf_curve,
                    vec![
                        SegOption::text(CrossfadeCurve::Linear, t(lang, Key::CurveLinear)),
                        SegOption::text(CrossfadeCurve::EqualPower, t(lang, Key::CurveEqualPower)),
                        SegOption::text(CrossfadeCurve::SCurve, t(lang, Key::CurveSCurve)),
                    ],
                    false,
                    move |curve, cx| {
                        st_xf_curve.update(cx, |s, cx| {
                            if s.player.crossfade_enabled {
                                let dur = s.player.crossfade_duration;
                                s.set_crossfade(true, dur, curve, cx);
                            }
                        });
                    },
                ))
                .child(
                    div()
                        .mt(px(12.0))
                        .text_size(px(12.0))
                        .text_color(muted)
                        .child(curve_desc),
                ),
        );

    div()
        .w_full()
        .max_w(px(980.0))
        .mx_auto()
        .flex()
        .flex_col()
        .child(header)
        .child(div().flex().flex_col().gap(px(16.0)).child(norm_card).child(xf_card))
        .into_any_element()
}
