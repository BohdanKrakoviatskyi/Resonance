use gpui_kit::{
    AnyElement, App, Bounds, BoxShadow, Corners, Entity, InteractiveElement, IntoElement,
    ParentElement, PathBuilder, Pixels, SharedString, StatefulInteractiveElement, Styled, Window,
    canvas, div, fill, hsla, point, prelude::FluentBuilder, px, size,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::{MaterialSlider, SliderSize};
use gpui_kit_material::theme::color;
use resonance_core::eq_curve::{EQ_BANDS, freq_to_unit, sample_curve};
use resonance_core::i18n::{Key, t};
use resonance_core::models::EqPreset;

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{
    M3IconBtnSize, M3IconBtnVariant, SegOption, m3_icon_button, m3_segmented,
};
use crate::ui::{rgba_alpha, role_alpha};

/// Renders the M3 Expressive Equalizer card (`src/components/EqPanel.tsx` / `.imm-eq-card`).
pub fn render_eq_card(store: &Entity<AppStore>, embedded_in_immersive: bool, cx: &App) -> gpui_kit::Div {
    let s = store.read(cx);
    let lang = s.lang();
    let enabled = s.player.eq_enabled;
    let preset = s.player.eq_preset;
    let bands = s.player.eq_bands;
    let spectrum = s.spectrum_bars;
    let eq_sliders = s.eq_sliders.clone();

    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let primary = color(ColorRole::PRIMARY);
    let bar_fill = role_alpha(ColorRole::PRIMARY, 0.30);
    let grid_col = role_alpha(ColorRole::ON_SURFACE, 0.14);
    let zero_col = role_alpha(ColorRole::ON_SURFACE, 0.30);

    let st_toggle = store.clone();
    let st_close = store.clone();
    let st_reset = store.clone();

    let mut head_right = div().flex().items_center().gap(px(8.0)).child(
        div().w(px(176.0)).child(m3_segmented(
            "eq-enable-seg",
            enabled,
            vec![
                SegOption::text(true, t(lang, Key::Enabled)),
                SegOption::text(false, t(lang, Key::Disabled)),
            ],
            true,
            move |val, cx| {
                st_toggle.update(cx, |s, cx| {
                    let p = s.player.eq_preset;
                    let b = s.player.eq_bands;
                    s.set_eq(val, p, b, cx);
                });
            },
        )),
    );

    if preset != EqPreset::Flat {
        head_right = head_right.child(
            div()
                .id("eq-reset-btn")
                .px(px(14.0))
                .py(px(8.0))
                .rounded_full()
                .bg(role_alpha(ColorRole::ON_SURFACE, 0.10))
                .text_size(px(12.0))
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(muted)
                .cursor_pointer()
                .hover(|st| st.text_color(ink))
                .on_click(move |_, w, cx| {
                    st_reset.update(cx, |s, cx| s.reset_eq(w, cx));
                })
                .child(t(lang, Key::EqReset)),
        );
    }

    if !embedded_in_immersive {
        head_right = head_right.child(m3_icon_button(
            "eq-close-btn",
            "close",
            false,
            M3IconBtnVariant::Standard,
            M3IconBtnSize::Sm,
            false,
            false,
            false,
            move |_, cx| {
                st_close.update(cx, |s, cx| {
                    s.eq_open = false;
                    cx.notify();
                });
            },
        ));
    }

    let header = div()
        .flex()
        .flex_wrap()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(
                    div()
                        .w(px(40.0))
                        .h(px(40.0))
                        .rounded(px(14.0))
                        .bg(role_alpha(ColorRole::PRIMARY, 0.20))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(ms_icon("graphic_eq", true, 22.0, primary)),
                )
                .child(
                    div()
                        .child(
                            div()
                                .text_size(px(20.0))
                                .font_weight(gpui_kit::FontWeight::BOLD)
                                .text_color(ink)
                                .child(t(lang, Key::Equalizer)),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(muted)
                                .child("60Hz – 14kHz · Native Audio DSP"),
                        ),
                ),
        )
        .child(head_right);

    // .eqx-chips pill presets
    let presets = [
        (EqPreset::Flat, Key::EqFlat),
        (EqPreset::BassBoost, Key::EqBassBoost),
        (EqPreset::Vocal, Key::EqVocal),
        (EqPreset::Rock, Key::EqRock),
        (EqPreset::Electronic, Key::EqElectronic),
        (EqPreset::Custom, Key::EqCustom),
    ];
    let mut chips_row = div().flex().flex_wrap().gap(px(8.0));
    for (p, key) in presets {
        let selected = preset == p;
        let is_state = p == EqPreset::Custom;
        let st_p = store.clone();

        let mut chip = div()
            .id(SharedString::from(format!("eqx-chip-{p:?}")))
            .px(px(15.0))
            .py(px(8.0))
            .rounded_full()
            .text_size(px(13.0))
            .font_weight(gpui_kit::FontWeight::SEMIBOLD);

        if selected {
            chip = chip
                .bg(primary)
                .text_color(color(ColorRole::ON_PRIMARY))
                .shadow(vec![BoxShadow {
                    color: role_alpha(ColorRole::PRIMARY, 0.45),
                    offset: point(px(0.0), px(6.0)),
                    blur_radius: px(18.0),
                    spread_radius: px(-8.0),
                    inset: false,
                }]);
        } else {
            chip = chip
                .bg(role_alpha(ColorRole::ON_SURFACE, 0.09))
                .border_1()
                .border_color(hsla(0.0, 0.0, 1.0, 0.06))
                .text_color(muted)
                .when(is_state, |d| d.opacity(0.45))
                .when(!is_state, |d| {
                    d.cursor_pointer()
                        .hover(|st| st.bg(role_alpha(ColorRole::ON_SURFACE, 0.15)).text_color(ink))
                });
        }

        if !is_state {
            chip = chip.on_click(move |_, w, cx| {
                st_p.update(cx, |s, cx| s.apply_eq_preset(p, w, cx));
            });
        }
        chips_row = chips_row.child(chip.child(t(lang, key)));
    }

    // .eqx-stage live spectrum + RBJ response curve + grid + nodes
    let curve_pts = sample_curve(&EQ_BANDS, if enabled { &bands } else { &[0.0; 5] }, 120);
    let band_units: Vec<(f32, f32)> = EQ_BANDS
        .iter()
        .enumerate()
        .map(|(i, b)| (freq_to_unit(b.freq) as f32, if enabled { bands[i] } else { 0.0 }))
        .collect();

    let graph = div()
        .w_full()
        .h(px(180.0))
        .rounded(px(22.0))
        .bg(role_alpha(ColorRole::ON_SURFACE, 0.05))
        .border_1()
        .border_color(hsla(0.0, 0.0, 1.0, 0.06))
        .overflow_hidden()
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, (), window, _| {
                    let w = f32::from(bounds.size.width).max(1.0);
                    let h = f32::from(bounds.size.height).max(1.0);
                    let left = f32::from(bounds.left());
                    let top = f32::from(bounds.top());
                    let mid_y = top + h * 0.5;

                    // Horizontal dB lines (-12, -6, 0, +6, +12)
                    for db_mark in [-12.0_f32, -6.0, 0.0, 6.0, 12.0] {
                        let y = mid_y - (db_mark / 14.0) * (h * 0.46);
                        window.paint_quad(fill(
                            Bounds::new(point(px(left), px(y)), size(px(w), px(1.0))),
                            if db_mark.abs() < 0.1 { zero_col } else { grid_col },
                        ));
                    }

                    // 72 FFT bars
                    let bar_step = w / 72.0;
                    let bar_w = (bar_step - 1.5).max(1.5);
                    for (i, &lvl) in spectrum.iter().enumerate() {
                        let bh = (lvl.clamp(0.0, 1.0) * h * 0.90).max(1.0);
                        let bx = left + i as f32 * bar_step + 0.5;
                        let by = f32::from(bounds.bottom()) - bh;
                        window.paint_quad(
                            fill(
                                Bounds::new(point(px(bx), px(by)), size(px(bar_w), px(bh))),
                                bar_fill,
                            )
                            .corner_radii(Corners::all(px(1.5))),
                        );
                    }

                    // Frequency response curve
                    let mut pb = PathBuilder::stroke(px(2.8));
                    for (i, (u, db)) in curve_pts.iter().enumerate() {
                        let x = left + (*u as f32) * w;
                        let y = (mid_y - ((*db as f32) / 14.0) * (h * 0.46)).clamp(top + 4.0, top + h - 4.0);
                        let pt = point(px(x), px(y));
                        if i == 0 {
                            pb.move_to(pt);
                        } else {
                            pb.line_to(pt);
                        }
                    }
                    if let Ok(path) = pb.build() {
                        window.paint_path(path, primary);
                    }

                    // Control handle circles (.eqx-handle)
                    for (u, db) in &band_units {
                        let cx_pt = left + u * w;
                        let cy_pt = (mid_y - (db / 14.0) * (h * 0.46)).clamp(top + 8.0, top + h - 8.0);
                        let handle_b = Bounds::new(
                            point(px(cx_pt - 8.0), px(cy_pt - 8.0)),
                            size(px(16.0), px(16.0)),
                        );
                        window.paint_drop_shadows(
                            handle_b,
                            Corners::all(px(8.0)),
                            &[BoxShadow {
                                color: rgba_alpha(gpui_kit::rgb(0x000000), 0.45),
                                offset: point(px(0.0), px(2.0)),
                                blur_radius: px(8.0),
                                spread_radius: px(0.0),
                                inset: false,
                            }],
                        );
                        window.paint_quad(
                            fill(handle_b, color(ColorRole::SURFACE_CONTAINER_HIGHEST))
                                .corner_radii(Corners::all(px(8.0))),
                        );
                        window.paint_quad(
                            fill(
                                Bounds::new(point(px(cx_pt - 4.0), px(cy_pt - 4.0)), size(px(8.0), px(8.0))),
                                primary,
                            )
                            .corner_radii(Corners::all(px(4.0))),
                        );
                    }
                },
            )
            .size_full(),
        );

    // 5-column readouts + vertical sliders
    let mut readouts = div().w_full().flex().items_center().gap(px(8.0));
    for (i, band) in EQ_BANDS.iter().enumerate() {
        let db = bands[i];
        let active_band = db.abs() > 0.05;
        readouts = readouts.child(
            div()
                .flex_1()
                .p(px(8.0))
                .rounded(px(16.0))
                .bg(role_alpha(ColorRole::ON_SURFACE, 0.07))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(4.0))
                .child(
                    div()
                        .text_size(px(13.5))
                        .font_weight(gpui_kit::FontWeight::EXTRA_BOLD)
                        .text_color(if active_band { primary } else { ink })
                        .child(format!("{db:+.1} dB")),
                )
                .child(
                    div().h(px(96.0)).child(
                        MaterialSlider::new(&eq_sliders[i], band.label)
                            .id(SharedString::from(format!("eq-sl-{i}")))
                            .vertical()
                            .size(SliderSize::Small),
                    ),
                )
                .child(
                    div()
                        .text_size(px(11.5))
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .text_color(muted)
                        .child(band.label),
                ),
        );
    }

    let _unused_px: Pixels = px(0.0);

    div()
        .w_full()
        .rounded(px(32.0))
        .bg(role_alpha(ColorRole::SURFACE_CONTAINER_HIGH, if embedded_in_immersive { 0.45 } else { 0.92 }))
        .border_1()
        .border_color(hsla(0.0, 0.0, 1.0, 0.08))
        .shadow(vec![BoxShadow {
            color: rgba_alpha(gpui_kit::rgb(0x000000), 0.50),
            offset: point(px(0.0), px(24.0)),
            blur_radius: px(60.0),
            spread_radius: px(-24.0),
            inset: false,
        }])
        .p(px(24.0))
        .flex()
        .flex_col()
        .gap(px(16.0))
        .child(header)
        .child(chips_row)
        .child(graph)
        .child(readouts)
}

/// Standalone popover equalizer when opened outside Immersive mode.
pub fn render_eq_popover(store: &Entity<AppStore>, _window: &mut Window, cx: &mut App) -> AnyElement {
    let s = store.read(cx);
    if !s.eq_open || s.immersive_open {
        return div().into_any_element();
    }

    div()
        .id("eq-backdrop")
        .absolute()
        .inset_0()
        .flex()
        .items_end()
        .justify_end()
        .pb(px(112.0))
        .pr(px(24.0))
        .child(div().w(px(560.0)).child(render_eq_card(store, false, cx)))
        .into_any_element()
}
