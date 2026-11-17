use gpui_kit::{
    AnyElement, App, Entity, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};
use resonance_core::models::Route;
use resonance_core::shortcuts::{SHORTCUTS, ShortcutScope, display_shortcut};

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{
    kbd_cap, m3_card, section_card_header, subpage_header,
};
use crate::ui::role_alpha;

/// Keyboard shortcuts page matching `src/pages/Shortcuts.tsx` and `src/components/ShortcutSettings.tsx`.
pub fn render_shortcuts_page(store: &Entity<AppStore>, _window: &mut Window, cx: &mut App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.appearance.lang;
    let dark = s.resolved_theme.dark;
    let recording = s.recording_shortcut;
    let error = s.shortcut_error.clone();

    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let primary = color(ColorRole::PRIMARY);

    let st_back = store.clone();
    let header = subpage_header(
        t(lang, Key::Settings),
        t(lang, Key::Shortcuts),
        t(lang, Key::ShortcutsSub),
        move |w, cx| {
            st_back.update(cx, |s, cx| s.navigate(Route::Settings, w, cx));
        },
    );

    let mut rows = div().flex().flex_col().gap(px(2.0));
    for def in SHORTCUTS {
        let binding = s.shortcuts.get(def.id);
        let keys = display_shortcut(binding);
        let is_recording = recording == Some(def.id);
        let is_default = binding == def.default_binding;
        let is_global = def.scope == ShortcutScope::Global;

        let st_rec = store.clone();
        let st_rst = store.clone();

        let mut key_btn = div()
            .id(SharedString::from(format!("sc-btn-{:?}", def.id)))
            .min_w(px(96.0))
            .min_h(px(34.0))
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(12.0))
            .border_1()
            .border_color(if is_recording {
                HslaOrRole::from(primary)
            } else {
                role_alpha(ColorRole::OUTLINE_VARIANT, 0.50)
            })
            .when(is_recording, |d| d.bg(role_alpha(ColorRole::PRIMARY, 0.14)))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(4.0))
            .cursor_pointer()
            .hover(|st| st.bg(color(ColorRole::SURFACE_CONTAINER_HIGH)))
            .on_click(move |_, _, cx| {
                st_rec.update(cx, |s, cx| {
                    if s.recording_shortcut == Some(def.id) {
                        s.recording_shortcut = None;
                    } else {
                        s.recording_shortcut = Some(def.id);
                    }
                    s.shortcut_error = None;
                    cx.notify();
                });
            });

        if is_recording {
            key_btn = key_btn.child(
                div()
                    .text_size(px(12.0))
                    .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                    .text_color(primary)
                    .child(t(lang, Key::ShortcutListening)),
            );
        } else {
            for cap in &keys {
                key_btn = key_btn.child(kbd_cap(cap.clone()));
            }
        }

        let reset_btn = div()
            .id(SharedString::from(format!("sc-rst-{:?}", def.id)))
            .w(px(32.0))
            .h(px(32.0))
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .child(ms_icon("refresh", false, 17.0, muted))
            .when(is_default, |d| d.opacity(0.35))
            .when(!is_default, |d| {
                d.cursor_pointer()
                    .hover(|st| st.bg(color(ColorRole::SURFACE_CONTAINER_HIGH)))
                    .on_click(move |_, _, cx| {
                        st_rst.update(cx, |s, cx| {
                            s.update_shortcut(def.id, def.default_binding.to_string(), cx);
                        });
                    })
            });

        rows = rows.child(
            div()
                .min_h(px(38.0))
                .py(px(2.0))
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .min_w(px(0.0))
                        .child(
                            div()
                                .text_size(px(14.0))
                                .text_color(ink)
                                .truncate()
                                .child(t(lang, def.label)),
                        )
                        .when(is_global, |d| {
                            d.child(
                                div()
                                    .px(px(6.0))
                                    .py(px(2.0))
                                    .rounded(px(6.0))
                                    .bg(role_alpha(ColorRole::ON_SURFACE, 0.09))
                                    .text_size(px(10.0))
                                    .font_weight(gpui_kit::FontWeight::BOLD)
                                    .text_color(muted)
                                    .child("GLOBAL"),
                            )
                        }),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(key_btn)
                        .child(reset_btn),
                ),
        );
    }

    if let Some(err) = error {
        let msg = match err.as_str() {
            "duplicate" => t(lang, Key::ShortcutDuplicate),
            "storage" => t(lang, Key::ShortcutStorageError),
            _ => t(lang, Key::ShortcutRegisterError),
        };
        rows = rows.child(
            div()
                .pt(px(6.0))
                .text_size(px(12.0))
                .text_color(color(ColorRole::ERROR))
                .child(msg),
        );
    }

    let card = m3_card(&s.appearance, dark)
        .flex()
        .flex_col()
        .child(section_card_header(
            "keyboard",
            t(lang, Key::Shortcuts),
            Some(SharedString::from(t(lang, Key::ShortcutsSub))),
        ))
        .child(rows);

    div()
        .w_full()
        .max_w(px(980.0))
        .mx_auto()
        .flex()
        .flex_col()
        .child(header)
        .child(card)
        .into_any_element()
}

type HslaOrRole = gpui_kit::Hsla;
