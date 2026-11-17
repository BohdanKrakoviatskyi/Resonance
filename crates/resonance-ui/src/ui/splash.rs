use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, IntoElement, ParentElement, Styled, div, point, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};

use crate::store::{AppStore, SplashStage};
use crate::ui::controls::m3_logo;
use crate::ui::{rgba_alpha, role_alpha};

/// Startup splash card matching `.splash-card` in `src/components/Splash.tsx` & `src/index.css`.
pub fn render_splash(store: &Entity<AppStore>, cx: &App) -> AnyElement {
    let s = store.read(cx);
    if s.splash_stage == SplashStage::Hidden {
        return div().into_any_element();
    }
    let lang = s.lang();
    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);

    let card = div()
        .relative()
        .overflow_hidden()
        .w(px(360.0))
        .h(px(440.0))
        .p(px(28.0))
        .rounded(px(32.0))
        .bg(color(ColorRole::SURFACE_CONTAINER_LOW))
        .shadow(vec![
            BoxShadow {
                color: rgba_alpha(gpui_kit::rgb(0x000000), 0.62),
                offset: point(px(0.0), px(20.0)),
                blur_radius: px(50.0),
                spread_radius: px(-14.0),
                inset: false,
            },
            BoxShadow {
                color: role_alpha(ColorRole::ON_SURFACE, 0.11),
                offset: point(px(0.0), px(0.0)),
                blur_radius: px(0.0),
                spread_radius: px(1.0),
                inset: true,
            },
        ])
        .flex()
        .flex_col()
        .justify_between()
        .child(div().h(px(4.0)))
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .relative()
                        .w(px(124.0))
                        .h(px(124.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            div()
                                .w(px(124.0))
                                .h(px(124.0))
                                .rounded_full()
                                .bg(role_alpha(ColorRole::PRIMARY, 0.14)),
                        )
                        .child(
                            div()
                                .absolute()
                                .inset_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(m3_logo("splash-logo", 92.0, s.spin_deg, false)),
                        ),
                )
                .child(
                    div()
                        .mt(px(22.0))
                        .text_size(px(32.0))
                        .font_weight(gpui_kit::FontWeight::EXTRA_BOLD)
                        .text_color(ink)
                        .child("Resonance"),
                )
                .child(
                    div()
                        .mt(px(8.0))
                        .text_size(px(15.0))
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .text_color(ink)
                        .child(t(lang, Key::SplashChecking)),
                )
                .child(
                    div()
                        .mt(px(4.0))
                        .text_size(px(13.0))
                        .text_color(muted)
                        .child(t(lang, Key::UpdateChecking)),
                ),
        )
        .child(
            div()
                .w_full()
                .h(px(8.0))
                .rounded_full()
                .overflow_hidden()
                .bg(role_alpha(ColorRole::ON_SURFACE, 0.12))
                .child(
                    div()
                        .h_full()
                        .w(gpui_kit::relative(0.45))
                        .rounded_full()
                        .bg(color(ColorRole::PRIMARY)),
                ),
        );

    div()
        .absolute()
        .inset_0()
        .bg(rgba_alpha(color(ColorRole::SURFACE), 0.90))
        .flex()
        .items_center()
        .justify_center()
        .child(card)
        .into_any_element()
}
