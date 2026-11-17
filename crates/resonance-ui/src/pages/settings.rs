use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, Window, div, point, prelude::FluentBuilder, px, rgb,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};
use resonance_core::models::{DialogKind, Lang, Route};

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{
    SegOption, display_page_header, m3_card, m3_segmented,
};
use crate::ui::{mix_hsla, rgba_alpha, role_alpha};

/// Settings hub matching `src/pages/Settings.tsx`.
pub fn render_settings_page(store: &Entity<AppStore>, _window: &mut Window, cx: &mut App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.appearance.lang;
    let dark = s.resolved_theme.dark;
    let has_update = s.update_state.available;

    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let ink = color(ColorRole::ON_SURFACE);

    let items: [(&'static str, &'static str, Key, Key, Route, bool); 4] = [
        ("set-app", "palette", Key::Appearance, Key::AppearanceSub, Route::Appearance, false),
        ("set-aud", "graphic_eq", Key::AudioSettings, Key::AudioSettingsSub, Route::Audio, false),
        ("set-prov", "music_note", Key::Providers, Key::ProvidersSub, Route::Providers, false),
        ("set-kb", "keyboard", Key::Shortcuts, Key::ShortcutsSub, Route::Shortcuts, has_update),
    ];

    let mut list = div().flex().flex_col().gap(px(12.0));
    for (id, icon, title_k, sub_k, route, badge) in items {
        let st_nav = store.clone();
        let target_route = route.clone();
        list = list.child(
            m3_card(&s.appearance, dark)
                .id(id)
                .w_full()
                .flex()
                .items_center()
                .gap(px(16.0))
                .cursor_pointer()
                .hover(|st| st.bg(role_alpha(ColorRole::SURFACE_CONTAINER_HIGH, 0.78)))
                .active(|st| st.rounded(px(32.0)))
                .on_click(move |_, w, cx| {
                    let r = target_route.clone();
                    st_nav.update(cx, |s, cx| s.navigate(r, w, cx));
                })
                .child(
                    div()
                        .relative()
                        .w(px(48.0))
                        .h(px(48.0))
                        .flex_shrink_0()
                        .rounded(px(16.0))
                        .bg(color(ColorRole::SECONDARY_CONTAINER))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(ms_icon(icon, true, 24.0, color(ColorRole::ON_SECONDARY_CONTAINER)))
                        .when(badge, |d| {
                            d.child(
                                div()
                                    .absolute()
                                    .top(px(-4.0))
                                    .right(px(-4.0))
                                    .w(px(12.0))
                                    .h(px(12.0))
                                    .rounded_full()
                                    .bg(rgb(0xff3b30)),
                            )
                        }),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .text_size(px(18.0))
                                        .font_weight(gpui_kit::FontWeight::BOLD)
                                        .text_color(ink)
                                        .child(t(lang, title_k)),
                                )
                                .when(badge, |d| {
                                    d.child(
                                        div()
                                            .w(px(10.0))
                                            .h(px(10.0))
                                            .rounded_full()
                                            .bg(rgb(0xff3b30)),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .mt(px(2.0))
                                .text_size(px(14.0))
                                .text_color(muted)
                                .child(t(lang, sub_k)),
                        ),
                )
                .child(ms_icon("chevron_right", false, 24.0, muted)),
        );
    }

    // Language card matching Settings.tsx
    let st_lang = store.clone();
    list = list.child(
        m3_card(&s.appearance, dark)
            .flex()
            .flex_col()
            .child(
                div()
                    .mb(px(16.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(
                        div()
                            .w(px(48.0))
                            .h(px(48.0))
                            .flex_shrink_0()
                            .rounded(px(16.0))
                            .bg(color(ColorRole::SECONDARY_CONTAINER))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(ms_icon(
                                "translate",
                                true,
                                24.0,
                                color(ColorRole::ON_SECONDARY_CONTAINER),
                            )),
                    )
                    .child(
                        div()
                            .text_size(px(18.0))
                            .font_weight(gpui_kit::FontWeight::BOLD)
                            .text_color(ink)
                            .child(t(lang, Key::Language)),
                    ),
            )
            .child(m3_segmented(
                "set-lang",
                lang,
                vec![
                    SegOption::text(Lang::Ru, "Русский"),
                    SegOption::text(Lang::En, "English"),
                ],
                false,
                move |next_lang, cx| {
                    st_lang.update(cx, |s, cx| {
                        s.appearance.lang = next_lang;
                        s.mark_dirty();
                        cx.notify();
                    });
                },
            )),
    );

    // Bottom floating pill buttons: Clear cache + Uninstall
    let st_clr = store.clone();
    let st_uni = store.clone();
    let cache_bg = mix_hsla(
        color(ColorRole::SURFACE_CONTAINER_HIGH),
        color(ColorRole::ON_SURFACE),
        0.12,
    );
    let err_bg = mix_hsla(
        color(ColorRole::SURFACE_CONTAINER_HIGH),
        color(ColorRole::ERROR),
        0.22,
    );

    list = list.child(
        div()
            .mt(px(4.0))
            .flex()
            .flex_wrap()
            .justify_end()
            .gap(px(10.0))
            .child(
                div()
                    .id("set-clear-cache-btn")
                    .px(px(20.0))
                    .py(px(12.0))
                    .rounded_full()
                    .bg(cache_bg)
                    .border_1()
                    .border_color(role_alpha(ColorRole::ON_SURFACE, 0.14))
                    .shadow(vec![BoxShadow {
                        color: rgba_alpha(gpui_kit::rgb(0x000000), 0.25),
                        offset: point(px(0.0), px(8.0)),
                        blur_radius: px(20.0),
                        spread_radius: px(-8.0),
                        inset: false,
                    }])
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .text_size(px(14.0))
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .text_color(ink)
                    .cursor_pointer()
                    .hover(move |st| st.bg(mix_hsla(cache_bg, ink, 0.08)))
                    .on_click(move |_, _, cx| {
                        st_clr.update(cx, |s, cx| {
                            s.dialog_confirm_checked = false;
                            s.dialog = Some(DialogKind::ClearCache);
                            cx.notify();
                        });
                    })
                    .child(ms_icon("history", true, 20.0, ink))
                    .child(t(lang, Key::ClearCacheApp)),
            )
            .child(
                div()
                    .id("set-uninstall-btn")
                    .px(px(20.0))
                    .py(px(12.0))
                    .rounded_full()
                    .bg(err_bg)
                    .border_1()
                    .border_color(role_alpha(ColorRole::ERROR, 0.45))
                    .shadow(vec![BoxShadow {
                        color: rgba_alpha(gpui_kit::rgb(0x000000), 0.25),
                        offset: point(px(0.0), px(8.0)),
                        blur_radius: px(20.0),
                        spread_radius: px(-8.0),
                        inset: false,
                    }])
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .text_size(px(14.0))
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .text_color(color(ColorRole::ERROR))
                    .cursor_pointer()
                    .hover(move |st| st.bg(mix_hsla(err_bg, color(ColorRole::ERROR), 0.14)))
                    .on_click(move |_, _, cx| {
                        st_uni.update(cx, |s, cx| {
                            s.dialog_confirm_checked = false;
                            s.dialog = Some(DialogKind::Uninstall);
                            cx.notify();
                        });
                    })
                    .child(ms_icon("delete", true, 20.0, color(ColorRole::ERROR)))
                    .child(t(lang, Key::UninstallApp)),
            ),
    );

    div()
        .w_full()
        .max_w(px(980.0))
        .mx_auto()
        .flex()
        .flex_col()
        .child(display_page_header(t(lang, Key::Settings), t(lang, Key::SettingsSub)))
        .child(list)
        .into_any_element()
}
