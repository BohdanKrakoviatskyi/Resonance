use gpui_kit::{
    AnyElement, App, Entity, IntoElement, ParentElement, Styled, Window, div, img,
    prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::{TextField, TextFieldVariant};
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};
use resonance_core::models::Route;

use crate::store::AppStore;
use crate::ui::controls::{
    M3ButtonSize, M3ButtonVariant, m3_button, m3_card, subpage_header,
};

/// Providers account management page matching `src/pages/Providers.tsx`.
pub fn render_providers_page(
    store: &Entity<AppStore>,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let dark = s.resolved_theme.dark;
    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let sc_tok_inp = s.sc_token_input.clone();

    let st_back = store.clone();
    let header = subpage_header(
        t(lang, Key::Settings),
        t(lang, Key::Providers),
        t(lang, Key::ProvidersPageDesc),
        move |w, cx| {
            st_back.update(cx, |s, cx| s.navigate(Route::Settings, w, cx));
        },
    );

    let status_pill = |connected: bool| {
        let dot_col = if connected {
            color(ColorRole::PRIMARY)
        } else {
            color(ColorRole::ON_SURFACE_VARIANT)
        };
        let label_k = if connected {
            Key::ProviderStatusConnected
        } else {
            Key::ProviderStatusNotConnected
        };
        div()
            .flex_shrink_0()
            .px(px(12.0))
            .py(px(6.0))
            .rounded_full()
            .bg(color(ColorRole::SURFACE_CONTAINER_HIGH))
            .flex()
            .items_center()
            .gap(px(8.0))
            .text_size(px(13.0))
            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
            .text_color(ink)
            .child(div().w(px(8.0)).h(px(8.0)).rounded_full().bg(dot_col))
            .child(t(lang, label_k))
    };

    // SoundCloud Card
    let sc_ok = s.sc_authorized;
    let sc_name = s
        .sc_profile
        .as_ref()
        .map(|p| {
            if !p.full_name.is_empty() {
                p.full_name.clone()
            } else {
                p.username.clone()
            }
        })
        .unwrap_or_default();
    let st_sc_login = store.clone();
    let st_sc_tok = store.clone();
    let st_sc_ref = store.clone();
    let st_sc_out = store.clone();

    let sc_card = m3_card(&s.appearance, dark)
        .flex()
        .flex_col()
        .gap(px(14.0))
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_start()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.0))
                        .min_w(px(0.0))
                        .flex_1()
                        .child(
                            img("assets/soundcloud.svg")
                                .w(px(30.0))
                                .h(px(30.0))
                                .rounded(px(7.0))
                                .flex_shrink_0(),
                        )
                        .child(
                            div()
                                .min_w(px(0.0))
                                .child(
                                    div()
                                        .text_size(px(20.0))
                                        .font_weight(gpui_kit::FontWeight::BOLD)
                                        .text_color(ink)
                                        .child("SoundCloud"),
                                )
                                .child(
                                    div()
                                        .mt(px(2.0))
                                        .text_size(px(14.0))
                                        .text_color(muted)
                                        .child(t(lang, Key::ScNote)),
                                ),
                        ),
                )
                .child(status_pill(sc_ok)),
        )
        .when(sc_ok && !sc_name.is_empty(), |d| {
            d.child(
                div()
                    .text_size(px(13.0))
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(ink)
                    .child(format!("{}: {sc_name}", t(lang, Key::ProviderAccount))),
            )
        })
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.0))
                .child(m3_button(
                    "prov-sc-login",
                    t(
                        lang,
                        if s.sc_logging_in {
                            Key::ScWaitingBtn
                        } else {
                            Key::ScLoginBtn
                        },
                    ),
                    Some("login"),
                    M3ButtonVariant::Filled,
                    M3ButtonSize::Default,
                    s.sc_logging_in,
                    move |_, cx| {
                        st_sc_login.update(cx, |s, cx| s.login_soundcloud(cx));
                    },
                ))
                .when(sc_ok, |d| {
                    d.child(m3_button(
                        "prov-sc-ref",
                        t(lang, Key::ProviderRefresh),
                        Some("refresh"),
                        M3ButtonVariant::Tonal,
                        M3ButtonSize::Default,
                        false,
                        move |_, cx| {
                            st_sc_ref.update(cx, |s, cx| s.refresh_soundcloud(true, cx));
                        },
                    ))
                    .child(m3_button(
                        "prov-sc-out",
                        t(lang, Key::ProviderDisconnect),
                        Some("logout"),
                        M3ButtonVariant::Outlined,
                        M3ButtonSize::Default,
                        false,
                        move |_, cx| {
                            st_sc_out.update(cx, |s, cx| s.logout_soundcloud(cx));
                        },
                    ))
                }),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(
                    div().flex_1().child(
                        TextField::new("prov-sc-token-tf", &sc_tok_inp)
                            .variant(TextFieldVariant::Outlined)
                            .label(t(lang, Key::ScUseTokenBtn)),
                    ),
                )
                .child(m3_button(
                    "prov-sc-tok-go",
                    t(lang, Key::ScUseTokenBtn),
                    None,
                    M3ButtonVariant::Tonal,
                    M3ButtonSize::Default,
                    false,
                    move |_, cx| {
                        st_sc_tok.update(cx, |s, cx| {
                            let tok = s.sc_token_input.read(cx).value().to_string();
                            s.login_soundcloud_with_token(tok, cx);
                        });
                    },
                )),
        );

    // YouTube Music Card
    let yt_ok = s.library.ytmusic_authorized;
    let yt_name = if !s.library.ytmusic_account_name.is_empty() {
        format!(
            "{} ({})",
            s.library.ytmusic_account_name, s.library.ytmusic_account_handle
        )
    } else {
        s.library.ytmusic_account_handle.clone()
    };
    let st_yt_login = store.clone();
    let st_yt_ref = store.clone();
    let st_yt_out = store.clone();

    let yt_card = m3_card(&s.appearance, dark)
        .flex()
        .flex_col()
        .gap(px(14.0))
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_start()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.0))
                        .min_w(px(0.0))
                        .flex_1()
                        .child(
                            img("assets/youtube-music.svg")
                                .w(px(30.0))
                                .h(px(30.0))
                                .rounded(px(7.0))
                                .flex_shrink_0(),
                        )
                        .child(
                            div()
                                .min_w(px(0.0))
                                .child(
                                    div()
                                        .text_size(px(20.0))
                                        .font_weight(gpui_kit::FontWeight::BOLD)
                                        .text_color(ink)
                                        .child("YouTube Music"),
                                )
                                .child(
                                    div()
                                        .mt(px(2.0))
                                        .text_size(px(14.0))
                                        .text_color(muted)
                                        .child(t(lang, Key::YtNote)),
                                ),
                        ),
                )
                .child(status_pill(yt_ok)),
        )
        .when(yt_ok && !yt_name.is_empty(), |d| {
            d.child(
                div()
                    .text_size(px(13.0))
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(ink)
                    .child(format!("{}: {yt_name}", t(lang, Key::ProviderAccount))),
            )
        })
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.0))
                .child(m3_button(
                    "prov-yt-login",
                    t(
                        lang,
                        if s.yt_logging_in {
                            Key::YtWaitingBtn
                        } else {
                            Key::YtLoginBtn
                        },
                    ),
                    Some("login"),
                    M3ButtonVariant::Filled,
                    M3ButtonSize::Default,
                    s.yt_logging_in,
                    move |_, cx| {
                        st_yt_login.update(cx, |s, cx| s.login_ytmusic(cx));
                    },
                ))
                .when(yt_ok, |d| {
                    d.child(m3_button(
                        "prov-yt-ref",
                        t(lang, Key::ProviderRefresh),
                        Some("refresh"),
                        M3ButtonVariant::Tonal,
                        M3ButtonSize::Default,
                        false,
                        move |_, cx| {
                            st_yt_ref.update(cx, |s, cx| s.refresh_ytmusic(true, cx));
                        },
                    ))
                    .child(m3_button(
                        "prov-yt-out",
                        t(lang, Key::ProviderDisconnect),
                        Some("logout"),
                        M3ButtonVariant::Outlined,
                        M3ButtonSize::Default,
                        false,
                        move |_, cx| {
                            st_yt_out.update(cx, |s, cx| s.logout_ytmusic(cx));
                        },
                    ))
                }),
        );

    div()
        .w_full()
        .max_w(px(980.0))
        .mx_auto()
        .flex()
        .flex_col()
        .child(header)
        .child(div().flex().flex_col().gap(px(16.0)).child(sc_card).child(yt_card))
        .into_any_element()
}
