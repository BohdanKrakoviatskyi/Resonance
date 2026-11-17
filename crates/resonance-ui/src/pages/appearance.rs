use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, Hsla, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, StyledImage, Window, div, hsla, img, point,
    prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::{TextField, TextFieldVariant};
use gpui_kit_material::theme::color;
use resonance_core::color_engine::{argb_from_hex, build_scheme};
use resonance_core::i18n::{Key, t};
use resonance_core::models::{
    AccentMode, BgMode, BgStyle, ColorVariant, GlassMode, MotionMode, Route, ThemeModePref,
};

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{
    M3ButtonSize, M3ButtonVariant, M3SliderStyle, SegOption, m3_button, m3_card, m3_chip,
    m3_segmented, m3_slider, section_card_header, subpage_header,
};
use crate::ui::{
    argb_to_hsla, preset_accent_swatches, preset_bg_swatches, role_alpha,
};

/// Appearance customization page matching `src/pages/Appearance.tsx` and `src/index.css`.
pub fn render_appearance_page(
    store: &Entity<AppStore>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let dark = s.resolved_theme.dark;
    let a = s.appearance.clone();
    let vw = f32::from(window.viewport_size().width);
    let wide = vw >= 920.0;

    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let primary = color(ColorRole::PRIMARY);
    let slider_style = M3SliderStyle::from_store(s, false);

    let hex_acc_inp = s.hex_accent_input.clone();
    let hex_bg_inp = s.hex_bg_input.clone();

    let st_back = store.clone();
    let header = subpage_header(
        t(lang, Key::Settings),
        t(lang, Key::Appearance),
        t(lang, Key::AppearanceSub),
        move |w, cx| {
            st_back.update(cx, |s, cx| s.navigate(Route::Settings, w, cx));
        },
    );

    let slider_row = |label: SharedString, value_text: String, slider_el: gpui_kit::Stateful<gpui_kit::Div>| {
        div()
            .flex_1()
            .min_w(px(220.0))
            .mt(px(14.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .mb(px(6.0))
                    .flex()
                    .justify_between()
                    .text_size(px(14.0))
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .child(div().text_color(ink).child(label))
                    .child(div().text_color(muted).child(value_text)),
            )
            .child(slider_el)
    };

    // -----------------------------------------------------------------------
    // 1. Glass Card (with .glass-opt live scene previews)
    // -----------------------------------------------------------------------
    let glass_opt = |kind: GlassMode, title_k: Key, desc_k: Key| {
        let on = a.glass == kind;
        let st_g = store.clone();
        let sample_bg = match kind {
            GlassMode::Liquid => role_alpha(ColorRole::SURFACE_CONTAINER_LOW, 0.34),
            GlassMode::Frosted => role_alpha(ColorRole::SURFACE_CONTAINER_LOW, 0.62),
            GlassMode::Off => Hsla::from(color(ColorRole::SURFACE_CONTAINER_HIGH)),
        };

        div()
            .id(SharedString::from(format!("glass-opt-{kind:?}")))
            .flex_1()
            .min_w(px(170.0))
            .p(px(10.0))
            .pb(px(14.0))
            .rounded(px(if on { 32.0 } else { 26.0 }))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .cursor_pointer()
            .when(on, |d| {
                d.bg(role_alpha(ColorRole::PRIMARY, 0.09))
                    .border_2()
                    .border_color(primary)
            })
            .when(!on, |d| {
                d.border_1()
                    .border_color(color(ColorRole::OUTLINE_VARIANT))
                    .hover(|st| st.bg(role_alpha(ColorRole::ON_SURFACE, 0.04)))
            })
            .on_click(move |_, _, cx| {
                st_g.update(cx, |s, cx| {
                    s.appearance.glass = kind;
                    if kind == GlassMode::Liquid && s.appearance.refraction <= 0.0 {
                        s.appearance.refraction = 45.0;
                    }
                    s.mark_dirty();
                    cx.notify();
                });
            })
            .child(
                // .glass-scene
                div()
                    .relative()
                    .w_full()
                    .h(px(96.0))
                    .rounded(px(18.0))
                    .overflow_hidden()
                    .bg(color(ColorRole::SURFACE_CONTAINER_LOWEST))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .absolute()
                            .left(px(14.0))
                            .top(px(-10.0))
                            .w(px(70.0))
                            .h(px(70.0))
                            .rounded_full()
                            .bg(color(ColorRole::PRIMARY)),
                    )
                    .child(
                        div()
                            .absolute()
                            .right(px(16.0))
                            .bottom(px(-12.0))
                            .w(px(56.0))
                            .h(px(56.0))
                            .rounded_full()
                            .bg(color(ColorRole::TERTIARY)),
                    )
                    .child(
                        div()
                            .absolute()
                            .right(px(64.0))
                            .top(px(12.0))
                            .w(px(30.0))
                            .h(px(30.0))
                            .rounded_full()
                            .bg(color(ColorRole::SECONDARY)),
                    )
                    .child(
                        div()
                            .w(gpui_kit::relative(0.62))
                            .h(gpui_kit::relative(0.52))
                            .rounded(px(16.0))
                            .bg(sample_bg)
                            .when(kind == GlassMode::Liquid, |d| {
                                d.border_1().border_color(hsla(0.0, 0.0, 1.0, 0.28))
                            })
                            .when(kind == GlassMode::Frosted, |d| {
                                d.border_1().border_color(hsla(0.0, 0.0, 1.0, 0.12))
                            })
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(ms_icon("music_note", true, 22.0, ink)),
                    ),
            )
            .child(
                div()
                    .px(px(4.0))
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .text_size(px(15.0))
                            .font_weight(gpui_kit::FontWeight::BOLD)
                            .text_color(ink)
                            .child(t(lang, title_k))
                            .when(on, |d| d.child(ms_icon("check", false, 18.0, primary))),
                    )
                    .child(
                        div()
                            .text_size(px(12.0))
                            .text_color(muted)
                            .child(t(lang, desc_k)),
                    ),
            )
    };

    let mut sl_blur_style = slider_style;
    sl_blur_style.disabled = a.glass == GlassMode::Off;
    let st_blur = store.clone();
    let st_opac = store.clone();
    let st_refr = store.clone();

    let mut glass_sliders = div()
        .mt(px(4.0))
        .when(a.glass == GlassMode::Off, |d| d.opacity(0.40))
        .flex()
        .flex_wrap()
        .gap(px(20.0))
        .child(slider_row(
            SharedString::from(t(lang, Key::Blur)),
            format!("{}%", a.blur.round() as i32),
            m3_slider(
                "app-blur-sl",
                (a.blur / 100.0).clamp(0.0, 1.0),
                Some(0.01),
                sl_blur_style,
                move |f, cx| {
                    st_blur.update(cx, |s, cx| {
                        s.appearance.blur = (f * 100.0).round();
                        s.mark_dirty();
                        cx.notify();
                    });
                },
            ),
        ))
        .child(slider_row(
            SharedString::from(t(lang, Key::Tint)),
            format!("{}%", a.opacity.round() as i32),
            m3_slider(
                "app-opac-sl",
                ((a.opacity - 10.0) / 80.0).clamp(0.0, 1.0),
                Some(1.0 / 80.0),
                sl_blur_style,
                move |f, cx| {
                    st_opac.update(cx, |s, cx| {
                        s.appearance.opacity = (10.0 + f * 80.0).round().clamp(10.0, 90.0);
                        s.mark_dirty();
                        cx.notify();
                    });
                },
            ),
        ));

    if a.glass == GlassMode::Liquid {
        glass_sliders = glass_sliders.child(slider_row(
            SharedString::from(t(lang, Key::Refraction)),
            format!("{}%", a.refraction.round() as i32),
            m3_slider(
                "app-refr-sl",
                (a.refraction / 100.0).clamp(0.0, 1.0),
                Some(0.01),
                sl_blur_style,
                move |f, cx| {
                    st_refr.update(cx, |s, cx| {
                        s.appearance.refraction = (f * 100.0).round();
                        s.mark_dirty();
                        cx.notify();
                    });
                },
            ),
        ));
    }

    let glass_card = m3_card(&a, dark)
        .flex()
        .flex_col()
        .child(section_card_header("blur_on", t(lang, Key::Glass), None))
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(12.0))
                .child(glass_opt(GlassMode::Liquid, Key::Liquid, Key::LiquidDesc))
                .child(glass_opt(GlassMode::Frosted, Key::Frosted, Key::FrostedDesc))
                .child(glass_opt(GlassMode::Off, Key::Off, Key::OffDesc)),
        )
        .child(glass_sliders);

    // -----------------------------------------------------------------------
    // 2. Background Card
    // -----------------------------------------------------------------------
    let st_bgm = store.clone();
    let st_bgs = store.clone();
    let st_dim = store.clone();
    let st_bgb = store.clone();
    let st_up = store.clone();
    let st_rm = store.clone();

    let mut bg_card = m3_card(&a, dark)
        .flex()
        .flex_col()
        .child(section_card_header(
            "wallpaper",
            t(lang, Key::Background),
            (a.bg_mode == BgMode::Dynamic).then(|| SharedString::from(t(lang, Key::DynamicHint))),
        ))
        .child(m3_segmented(
            "app-bg-mode",
            a.bg_mode,
            vec![
                SegOption::icon_text(BgMode::Dynamic, "auto_awesome", t(lang, Key::FromCover)),
                SegOption::icon_text(BgMode::Color, "format_paint", t(lang, Key::Color)),
                SegOption::icon_text(BgMode::Image, "image", t(lang, Key::Photo)),
            ],
            false,
            move |mode, cx| {
                st_bgm.update(cx, |s, cx| {
                    s.appearance.bg_mode = mode;
                    s.mark_appearance_changed();
                    cx.notify();
                });
            },
        ));

    match a.bg_mode {
        BgMode::Dynamic => {
            bg_card = bg_card.child(
                div().mt(px(16.0)).max_w(px(360.0)).child(m3_segmented(
                    "app-bg-style",
                    a.bg_style,
                    vec![
                        SegOption::icon_text(BgStyle::Palette, "water_drop", t(lang, Key::BgPalette)),
                        SegOption::icon_text(BgStyle::Artwork, "layers", t(lang, Key::BgArtwork)),
                    ],
                    true,
                    move |st, cx| {
                        st_bgs.update(cx, |s, cx| {
                            s.appearance.bg_style = st;
                            s.mark_appearance_changed();
                            cx.notify();
                        });
                    },
                )),
            );
        }
        BgMode::Color => {
            let mut sw_row = div().mt(px(16.0)).flex().flex_wrap().items_center().gap(px(10.0));
            for hex in preset_bg_swatches(dark) {
                let st_sw = store.clone();
                let h_own = (*hex).to_string();
                let col = argb_to_hsla(argb_from_hex(hex));
                let active = a.bg_color.eq_ignore_ascii_case(hex);
                sw_row = sw_row.child(swatch_dot(
                    SharedString::from(format!("bgsw-{hex}")),
                    col,
                    active,
                    move |w, cx| {
                        let hc = h_own.clone();
                        st_sw.update(cx, |s, cx| {
                            s.appearance.bg_color = hc.clone();
                            s.hex_bg_input.update(cx, |inp, cx| inp.set_value(&hc, w, cx));
                            s.mark_appearance_changed();
                            cx.notify();
                        });
                    },
                ));
            }
            sw_row = sw_row.child(
                div().w(px(160.0)).child(
                    TextField::new("app-hex-bg", &hex_bg_inp)
                        .variant(TextFieldVariant::Outlined)
                        .label(t(lang, Key::CustomColor)),
                ),
            );
            bg_card = bg_card.child(sw_row);
        }
        BgMode::Image => {
            let img_prev = s.custom_bg_image_path.as_ref().map(|p| {
                img(p.clone())
                    .w(px(160.0))
                    .h(px(96.0))
                    .rounded(px(20.0))
                    .object_fit(gpui_kit::ObjectFit::Cover)
            });
            bg_card = bg_card.child(
                div()
                    .mt(px(16.0))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(14.0))
                    .when_some(img_prev, |d, el| d.child(el))
                    .child(m3_button(
                        "app-up-photo",
                        t(
                            lang,
                            if s.custom_bg_image_path.is_some() {
                                Key::ChangePhoto
                            } else {
                                Key::UploadPhoto
                            },
                        ),
                        Some("upload"),
                        M3ButtonVariant::Tonal,
                        M3ButtonSize::Default,
                        false,
                        move |_, cx| {
                            st_up.update(cx, |s, cx| s.pick_custom_bg_photo(cx));
                        },
                    ))
                    .when(s.custom_bg_image_path.is_some(), |d| {
                        d.child(m3_button(
                            "app-rm-photo",
                            t(lang, Key::RemovePhoto),
                            Some("delete"),
                            M3ButtonVariant::Outlined,
                            M3ButtonSize::Default,
                            false,
                            move |_, cx| {
                                st_rm.update(cx, |s, cx| s.remove_custom_bg_photo(cx));
                            },
                        ))
                    }),
            );
        }
    }

    if a.bg_mode == BgMode::Image || (a.bg_mode == BgMode::Dynamic && a.bg_style == BgStyle::Artwork) {
        bg_card = bg_card.child(
            div()
                .mt(px(6.0))
                .flex()
                .flex_wrap()
                .gap(px(20.0))
                .child(slider_row(
                    SharedString::from(t(lang, Key::Dim)),
                    format!("{}%", a.bg_dim.round() as i32),
                    m3_slider(
                        "app-bgdim-sl",
                        (a.bg_dim / 85.0).clamp(0.0, 1.0),
                        Some(1.0 / 85.0),
                        slider_style,
                        move |f, cx| {
                            st_dim.update(cx, |s, cx| {
                                s.appearance.bg_dim = (f * 85.0).round();
                                s.mark_appearance_changed();
                                cx.notify();
                            });
                        },
                    ),
                ))
                .child(slider_row(
                    SharedString::from(t(lang, Key::BgBlur)),
                    format!("{}px", a.bg_blur.round() as i32),
                    m3_slider(
                        "app-bgblur-sl",
                        (a.bg_blur / 60.0).clamp(0.0, 1.0),
                        Some(1.0 / 60.0),
                        slider_style,
                        move |f, cx| {
                            st_bgb.update(cx, |s, cx| {
                                s.appearance.bg_blur = (f * 60.0).round();
                                s.mark_appearance_changed();
                                cx.notify();
                            });
                        },
                    ),
                )),
        );
    }

    // -----------------------------------------------------------------------
    // 3. Accent Color Card + Current Scheme Bar
    // -----------------------------------------------------------------------
    let st_am = store.clone();
    let mut acc_swatches = div().mt(px(16.0)).flex().flex_wrap().items_center().gap(px(10.0));
    for hex in preset_accent_swatches() {
        let st_asw = store.clone();
        let h_own = (*hex).to_string();
        let col = argb_to_hsla(argb_from_hex(hex));
        let active = a.accent_color.eq_ignore_ascii_case(hex);
        acc_swatches = acc_swatches.child(swatch_dot(
            SharedString::from(format!("acsw-{hex}")),
            col,
            active,
            move |w, cx| {
                let hc = h_own.clone();
                st_asw.update(cx, |s, cx| {
                    s.appearance.accent_mode = AccentMode::Custom;
                    s.appearance.accent_color = hc.clone();
                    s.hex_accent_input.update(cx, |inp, cx| inp.set_value(&hc, w, cx));
                    s.mark_appearance_changed();
                    cx.notify();
                });
            },
        ));
    }
    acc_swatches = acc_swatches.child(
        div().w(px(160.0)).child(
            TextField::new("app-hex-acc", &hex_acc_inp)
                .variant(TextFieldVariant::Outlined)
                .label(t(lang, Key::CustomColor)),
        ),
    );

    let scheme_roles = [
        ColorRole::PRIMARY,
        ColorRole::PRIMARY_CONTAINER,
        ColorRole::SECONDARY,
        ColorRole::SECONDARY_CONTAINER,
        ColorRole::TERTIARY,
        ColorRole::TERTIARY_CONTAINER,
        ColorRole::SURFACE_CONTAINER_HIGH,
        ColorRole::ON_SURFACE,
    ];
    let mut scheme_bar = div().mt(px(8.0)).flex().flex_wrap().gap(px(8.0));
    for r in scheme_roles {
        scheme_bar = scheme_bar.child(
            div()
                .flex_1()
                .min_w(px(36.0))
                .h(px(36.0))
                .rounded(px(12.0))
                .bg(color(r)),
        );
    }

    let accent_card = m3_card(&a, dark)
        .flex()
        .flex_col()
        .child(section_card_header(
            "palette",
            t(lang, Key::Accent),
            (a.accent_mode == AccentMode::Dynamic)
                .then(|| SharedString::from(t(lang, Key::DynamicHint))),
        ))
        .child(m3_segmented(
            "app-acc-mode",
            a.accent_mode,
            vec![
                SegOption::icon_text(AccentMode::Dynamic, "auto_awesome", t(lang, Key::FromCover)),
                SegOption::icon_text(AccentMode::Custom, "colorize", t(lang, Key::Custom)),
            ],
            false,
            move |mode, cx| {
                st_am.update(cx, |s, cx| {
                    s.appearance.accent_mode = mode;
                    s.mark_appearance_changed();
                    cx.notify();
                });
            },
        ))
        .when(a.accent_mode == AccentMode::Custom, |d| d.child(acc_swatches))
        .child(
            div()
                .mt(px(20.0))
                .text_size(px(14.0))
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(ink)
                .child(t(lang, Key::CurrentScheme)),
        )
        .child(scheme_bar);

    // -----------------------------------------------------------------------
    // 4. Color Style Variants Card (8 chips with 3 overlapping dots)
    // -----------------------------------------------------------------------
    let variant_labels = [
        (ColorVariant::Vibrant, Key::Vibrant),
        (ColorVariant::Tonal, Key::Tonal),
        (ColorVariant::Expressive, Key::Expressive),
        (ColorVariant::Fidelity, Key::Fidelity),
        (ColorVariant::Rainbow, Key::Rainbow),
        (ColorVariant::Fruit, Key::Fruit),
        (ColorVariant::Neutral, Key::Neutral),
        (ColorVariant::Mono, Key::Mono),
    ];
    let mut var_grid = div()
        .flex()
        .flex_wrap()
        .gap(px(10.0))
        .when(a.metallic, |d| d.opacity(0.45));

    for (v, k) in variant_labels {
        let st_v = store.clone();
        let preview_sch = build_scheme(
            s.resolved_theme.accent_argb,
            s.resolved_theme.accent_argb,
            dark,
            v,
        );
        let c1 = argb_to_hsla(preview_sch.get(ColorRole::PRIMARY).to_argb());
        let c2 = argb_to_hsla(preview_sch.get(ColorRole::SECONDARY).to_argb());
        let c3 = argb_to_hsla(preview_sch.get(ColorRole::TERTIARY).to_argb());
        let active = !a.metallic && a.variant == v;

        let dot = |col: Hsla, overlap: bool| {
            let mut d = div()
                .w(px(20.0))
                .h(px(20.0))
                .rounded_full()
                .bg(col)
                .border_2()
                .border_color(color(ColorRole::SURFACE_CONTAINER_HIGH));
            if overlap {
                d = d.ml(px(-8.0));
            }
            d
        };

        var_grid = var_grid.child(
            m3_chip(
                SharedString::from(format!("cvar-{v:?}")),
                "",
                None,
                active,
                move |_, cx| {
                    st_v.update(cx, |s, cx| {
                        if s.appearance.metallic {
                            return;
                        }
                        s.appearance.variant = v;
                        s.mark_appearance_changed();
                        cx.notify();
                    });
                },
            )
            .w(px(if wide { 196.0 } else { 156.0 }))
            .h(px(44.0))
            .px(px(10.0))
            .rounded(px(if active { 26.0 } else { 18.0 }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .child(dot(c1, false))
                    .child(dot(c2, true))
                    .child(dot(c3, true)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .text_size(px(13.0))
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .truncate()
                    .child(t(lang, k)),
            ),
        );
    }

    let style_card = m3_card(&a, dark)
        .flex()
        .flex_col()
        .child(section_card_header(
            "auto_awesome",
            t(lang, Key::ColorStyle),
            a.metallic
                .then(|| SharedString::from(t(lang, Key::ColorStyleMetallicHint))),
        ))
        .child(var_grid);

    // -----------------------------------------------------------------------
    // 5. Metallic Mode + Neon Accent Card
    // -----------------------------------------------------------------------
    let st_met = store.clone();
    let st_neon = store.clone();
    let st_neon_sl = store.clone();
    let mut neon_sl_style = slider_style;
    neon_sl_style.disabled = !a.metallic || !a.metallic_neon;

    let metallic_card = m3_card(&a, dark)
        .flex()
        .flex_col()
        .child(section_card_header(
            "layers",
            t(lang, Key::MetallicMode),
            Some(SharedString::from(t(lang, Key::MetallicModeDesc))),
        ))
        .child(m3_segmented(
            "app-metallic-seg",
            a.metallic,
            vec![
                SegOption::icon_text(true, "auto_awesome", t(lang, Key::Enabled)),
                SegOption::text(false, t(lang, Key::Disabled)),
            ],
            false,
            move |enabled, cx| {
                st_met.update(cx, |s, cx| {
                    s.appearance.metallic = enabled;
                    s.mark_appearance_changed();
                    cx.notify();
                });
            },
        ))
        .child(
            div()
                .mt(px(16.0))
                .p(px(16.0))
                .rounded(px(16.0))
                .bg(role_alpha(ColorRole::SURFACE_CONTAINER_LOW, 0.60))
                .when(!a.metallic, |d| d.opacity(0.45))
                .flex()
                .flex_col()
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .justify_between()
                        .gap(px(12.0))
                        .child(
                            div()
                                .text_size(px(14.0))
                                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                .text_color(ink)
                                .child(t(lang, Key::NeonAccent)),
                        )
                        .child(div().w(px(210.0)).child(m3_segmented(
                            "app-neon-seg",
                            a.metallic && a.metallic_neon,
                            vec![
                                SegOption::icon_text(true, "bolt", t(lang, Key::Enabled)),
                                SegOption::text(false, t(lang, Key::Disabled)),
                            ],
                            true,
                            move |on, cx| {
                                st_neon.update(cx, |s, cx| {
                                    if s.appearance.metallic {
                                        s.appearance.metallic_neon = on;
                                        s.mark_appearance_changed();
                                        cx.notify();
                                    }
                                });
                            },
                        ))),
                )
                .child(
                    div()
                        .when(!a.metallic || !a.metallic_neon, |d| d.opacity(0.45))
                        .child(slider_row(
                            SharedString::from(t(lang, Key::NeonIntensity)),
                            format!("{}%", a.metallic_neon_intensity.round() as i32),
                            m3_slider(
                                "app-neon-sl",
                                ((a.metallic_neon_intensity - 10.0) / 75.0).clamp(0.0, 1.0),
                                Some(1.0 / 75.0),
                                neon_sl_style,
                                move |f, cx| {
                                    st_neon_sl.update(cx, |s, cx| {
                                        if s.appearance.metallic && s.appearance.metallic_neon {
                                            s.appearance.metallic_neon_intensity =
                                                (10.0 + f * 75.0).round().clamp(10.0, 85.0);
                                            s.mark_appearance_changed();
                                            cx.notify();
                                        }
                                    });
                                },
                            ),
                        )),
                ),
        );

    // -----------------------------------------------------------------------
    // 6. Theme + Motion 2-column Row + Centered Reset Button
    // -----------------------------------------------------------------------
    let st_theme = store.clone();
    let theme_card = m3_card(&a, dark)
        .flex_1()
        .min_w(px(280.0))
        .flex()
        .flex_col()
        .child(section_card_header("contrast", t(lang, Key::Theme), None))
        .child(m3_segmented(
            "app-theme-seg",
            a.theme,
            vec![
                SegOption::icon_text(ThemeModePref::Dark, "dark_mode", t(lang, Key::Dark)),
                SegOption::icon_text(ThemeModePref::Light, "light_mode", t(lang, Key::Light)),
                SegOption::icon_text(ThemeModePref::System, "brightness_auto", t(lang, Key::System)),
            ],
            false,
            move |mode, cx| {
                st_theme.update(cx, |s, cx| {
                    s.appearance.theme = mode;
                    s.mark_appearance_changed();
                    cx.notify();
                });
            },
        ));

    let st_mot = store.clone();
    let motion_card = m3_card(&a, dark)
        .flex_1()
        .min_w(px(280.0))
        .flex()
        .flex_col()
        .child(section_card_header("animation", t(lang, Key::Motion), None))
        .child(m3_segmented(
            "app-mot-seg",
            a.motion,
            vec![
                SegOption::text(MotionMode::Expressive, t(lang, Key::MotionExpressive)),
                SegOption::text(MotionMode::Standard, t(lang, Key::MotionStandard)),
                SegOption::text(MotionMode::Reduced, t(lang, Key::MotionReduced)),
            ],
            false,
            move |mot, cx| {
                st_mot.update(cx, |s, cx| {
                    s.appearance.motion = mot;
                    s.mark_dirty();
                    cx.notify();
                });
            },
        ));

    let st_rst = store.clone();
    let bottom_row = div()
        .py(px(16.0))
        .flex()
        .justify_center()
        .child(m3_button(
            "app-reset-btn",
            t(lang, Key::Reset),
            Some("refresh"),
            M3ButtonVariant::Outlined,
            M3ButtonSize::Default,
            false,
            move |w, cx| {
                st_rst.update(cx, |s, cx| s.reset_appearance(w, cx));
            },
        ));

    div()
        .w_full()
        .max_w(px(980.0))
        .mx_auto()
        .flex()
        .flex_col()
        .child(header)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(16.0))
                .child(glass_card)
                .child(bg_card)
                .child(accent_card)
                .child(style_card)
                .child(metallic_card)
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(16.0))
                        .child(theme_card)
                        .child(motion_card),
                )
                .child(bottom_row),
        )
        .into_any_element()
}

fn swatch_dot(
    id: impl Into<gpui_kit::ElementId>,
    col: Hsla,
    active: bool,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let mut dot = div()
        .id(id)
        .w(px(44.0))
        .h(px(44.0))
        .rounded(px(if active { 14.0 } else { 22.0 }))
        .bg(col)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .on_click(move |_, w, cx| on_click(w, cx));

    if active {
        dot = dot
            .shadow(vec![
                BoxShadow {
                    color: color(ColorRole::SURFACE_CONTAINER_HIGH).into(),
                    offset: point(px(0.0), px(0.0)),
                    blur_radius: px(0.0),
                    spread_radius: px(3.0),
                    inset: false,
                },
                BoxShadow {
                    color: color(ColorRole::PRIMARY).into(),
                    offset: point(px(0.0), px(0.0)),
                    blur_radius: px(0.0),
                    spread_radius: px(5.0),
                    inset: false,
                },
            ])
            .child(ms_icon("check", false, 20.0, gpui_kit::rgb(0xffffff)));
    } else {
        dot = dot.border_1().border_color(hsla(0.0, 0.0, 1.0, 0.14));
    }
    dot
}
