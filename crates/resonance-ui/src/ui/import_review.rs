use gpui_kit::{
    AnyElement, App, Entity, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::{
    ButtonSize, ButtonVariant, CheckboxState, IconButton, IconButtonVariant, LoadingIndicator,
    MaterialButton, MaterialCheckbox, MaterialDialog, TextField, TextFieldVariant,
};
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};
use resonance_core::matching::ImportReviewReason;
use resonance_core::models::fmt_time;

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::{cover_art_box, rgba_alpha, role_alpha, track_primary_cover};

pub fn render_import_review_dialog(
    store: &Entity<AppStore>,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let ink = rgba_alpha(color(ColorRole::ON_SURFACE), 0.96);
    let muted = rgba_alpha(color(ColorRole::ON_SURFACE_VARIANT), 0.84);
    let accent = color(ColorRole::PRIMARY);
    let job = &s.import_job;
    let total = job.review_items.len();
    let matched = job.review_items.iter().filter(|i| i.selected.is_some()).count();
    let pending = job
        .review_items
        .iter()
        .filter(|i| i.reason != ImportReviewReason::AutoMatched)
        .count();
    let selected_count = job
        .review_items
        .iter()
        .filter(|i| i.accepted && i.selected.is_some())
        .count();

    let summary = s.tf(
        Key::ImportReviewSummary,
        &[
            ("matched", &matched.to_string()),
            ("total", &total.to_string()),
            ("pending", &pending.to_string()),
        ],
    );

    let st_all = store.clone();
    let st_none = store.clone();
    let st_skip = store.clone();

    let actions_row = div()
        .flex()
        .flex_wrap()
        .gap(px(8.0))
        .child(
            MaterialButton::new("ir-sel-all")
                .variant(ButtonVariant::Text)
                .button_size(ButtonSize::ExtraSmall)
                .child(t(lang, Key::ImportSelectAll))
                .on_click(move |_, _, cx| {
                    st_all.update(cx, |s, cx| {
                        for it in &mut s.import_job.review_items {
                            if it.selected.is_some() {
                                it.accepted = true;
                            }
                        }
                        cx.notify();
                    });
                }),
        )
        .child(
            MaterialButton::new("ir-sel-none")
                .variant(ButtonVariant::Text)
                .button_size(ButtonSize::ExtraSmall)
                .child(t(lang, Key::ImportDeselectAll))
                .on_click(move |_, _, cx| {
                    st_none.update(cx, |s, cx| {
                        for it in &mut s.import_job.review_items {
                            it.accepted = false;
                        }
                        cx.notify();
                    });
                }),
        )
        .child(
            MaterialButton::new("ir-skip-unc")
                .variant(ButtonVariant::Text)
                .button_size(ButtonSize::ExtraSmall)
                .child(t(lang, Key::ImportSkipAll))
                .on_click(move |_, _, cx| {
                    st_skip.update(cx, |s, cx| {
                        for it in &mut s.import_job.review_items {
                            it.accepted = it.reason == ImportReviewReason::AutoMatched && it.selected.is_some();
                        }
                        cx.notify();
                    });
                }),
        );

    let alt_open_idx = job.review_alt_open_idx;
    let alt_loading = job.review_alt_loading;
    let alt_results = job.review_alt_results.clone();
    let alt_inp = s.import_alt_search_input.clone();
    let preview_tid = s.preview_track_id.clone();

    let mut rows = div()
        .id("ir-scroll")
        .w_full()
        .max_h(px(400.0))
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(8.0));

    for (idx, item) in job.review_items.iter().enumerate() {
        let reason_label = match item.reason {
            ImportReviewReason::AutoMatched => None,
            ImportReviewReason::LowConfidenceMatch => Some(t(lang, Key::ImportReasonLow)),
            ImportReviewReason::AmbiguousMatch => Some(t(lang, Key::ImportReasonAmbiguous)),
            ImportReviewReason::DurationMismatch => Some(t(lang, Key::ImportReasonDuration)),
            ImportReviewReason::NoCatalogCandidates => Some(t(lang, Key::ImportReasonNone)),
            ImportReviewReason::CatalogLookupFailed => Some(t(lang, Key::ImportReasonFailed)),
        };

        let st_chk = store.clone();
        let st_open_alt = store.clone();
        let src_prefill = format!("{} {}", item.source.artist, item.source.title);

        let mut card = div()
            .p(px(10.0))
            .rounded(px(14.0))
            .bg(role_alpha(ColorRole::SURFACE_CONTAINER_LOW, 0.72))
            .border_1()
            .border_color(role_alpha(ColorRole::OUTLINE_VARIANT, 0.35))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(10.0))
                    .child(
                        MaterialCheckbox::new(
                            SharedString::from(format!("ir-chk-{idx}")),
                            format!("{} — {}", item.source.artist, item.source.title),
                        )
                        .checked(item.accepted)
                        .disabled(item.selected.is_none())
                        .on_change(move |st: &CheckboxState, _, cx| {
                            let v = *st == CheckboxState::Checked;
                            st_chk.update(cx, |s, cx| {
                                if let Some(it) = s.import_job.review_items.get_mut(idx) {
                                    it.accepted = v;
                                }
                                cx.notify();
                            });
                        }),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .when_some(reason_label, |d, lbl| {
                                d.child(
                                    div()
                                        .px(px(8.0))
                                        .py(px(2.0))
                                        .rounded(px(8.0))
                                        .bg(role_alpha(ColorRole::TERTIARY_CONTAINER, 0.7))
                                        .text_size(px(10.5))
                                        .text_color(color(ColorRole::ON_TERTIARY_CONTAINER))
                                        .child(lbl),
                                )
                            })
                            .child(
                                MaterialButton::new(SharedString::from(format!("ir-alt-btn-{idx}")))
                                    .variant(ButtonVariant::Text)
                                    .button_size(ButtonSize::ExtraSmall)
                                    .icon(ms_icon("search", false, 15.0, accent))
                                    .child(t(lang, Key::ImportSearchAltBtn))
                                    .on_click(move |_, w, cx| {
                                        let q = src_prefill.clone();
                                        st_open_alt.update(cx, |s, cx| {
                                            s.import_alt_search_input.update(cx, |inp, cx| inp.set_value(&q, w, cx));
                                            s.review_search_alternative(idx, q, cx);
                                        });
                                    }),
                            ),
                    ),
            );

        if let Some(ref sel) = item.selected {
            let is_prev = preview_tid.as_deref() == Some(&sel.id);
            let st_pv = store.clone();
            let sel_c = sel.clone();
            card = card.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .pl(px(28.0))
                    .child(cover_art_box(track_primary_cover(sel), &sel.id, 36.0, 8.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .text_size(px(12.5))
                                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                                    .text_color(ink)
                                    .truncate()
                                    .child(sel.title.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(muted)
                                    .truncate()
                                    .child(format!("{} · {} ({}%)", sel.artist, fmt_time(sel.duration), item.score)),
                            ),
                    )
                    .child(
                        IconButton::new(
                            SharedString::from(format!("ir-pv-{idx}")),
                            ms_icon(if is_prev { "pause" } else { "play_arrow" }, true, 18.0, accent),
                            t(lang, if is_prev { Key::ImportPreviewPause } else { Key::ImportPreviewPlay }),
                        )
                        .variant(IconButtonVariant::Tonal)
                        .on_click(move |_, _, cx| {
                            let t_c = sel_c.clone();
                            st_pv.update(cx, |s, cx| s.toggle_preview_track(t_c, cx));
                        }),
                    ),
            );
        } else {
            card = card.child(
                div()
                    .pl(px(28.0))
                    .text_size(px(12.0))
                    .text_color(color(ColorRole::ERROR))
                    .child(t(lang, Key::ImportNoCandidate)),
            );
        }

        // Inline manual search picker when opened for this row
        if alt_open_idx == Some(idx) {
            let st_go_alt = store.clone();
            let mut alt_box = div()
                .mt(px(4.0))
                .pl(px(28.0))
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(
                            div().flex_1().child(
                                TextField::new("ir-alt-tf", &alt_inp)
                                    .variant(TextFieldVariant::Outlined)
                                    .placeholder(t(lang, Key::ImportSearchPlaceholder)),
                            ),
                        )
                        .child(
                            MaterialButton::new("ir-alt-go")
                                .variant(ButtonVariant::Tonal)
                                .button_size(ButtonSize::ExtraSmall)
                                .icon(ms_icon("search", false, 16.0, ink))
                                .on_click(move |_, _, cx| {
                                    st_go_alt.update(cx, |s, cx| {
                                        let q = s.import_alt_search_input.read(cx).value().to_string();
                                        s.review_search_alternative(idx, q, cx);
                                    });
                                }),
                        ),
                );
            if alt_loading {
                alt_box = alt_box.child(LoadingIndicator::new("ir-alt-spin", "Searching"));
            } else {
                for (ci, cand) in alt_results.iter().take(5).enumerate() {
                    let st_choose = store.clone();
                    let cand_c = cand.clone();
                    alt_box = alt_box.child(
                        div()
                            .id(SharedString::from(format!("ir-alt-pick-{idx}-{ci}")))
                            .flex()
                            .items_center()
                            .justify_between()
                            .px(px(8.0))
                            .py(px(5.0))
                            .rounded(px(8.0))
                            .bg(role_alpha(ColorRole::SURFACE_CONTAINER, 0.8))
                            .hover(|d| d.bg(role_alpha(ColorRole::PRIMARY_CONTAINER, 0.45)))
                            .cursor_pointer()
                            .on_click(move |_, _, cx| {
                                let chosen = cand_c.clone();
                                st_choose.update(cx, |s, cx| {
                                    if let Some(it) = s.import_job.review_items.get_mut(idx) {
                                        it.selected = Some(chosen);
                                        it.accepted = true;
                                        it.reason = ImportReviewReason::AutoMatched;
                                    }
                                    s.import_job.review_alt_open_idx = None;
                                    cx.notify();
                                });
                            })
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .text_color(ink)
                                    .truncate()
                                    .child(format!("{} — {}", cand.artist, cand.title)),
                            )
                            .child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(muted)
                                    .child(fmt_time(cand.duration)),
                            ),
                    );
                }
            }
            card = card.child(alt_box);
        }

        rows = rows.child(card);
    }

    let st_cancel = store.clone();
    let st_apply = store.clone();
    let apply_lbl = s.tf(Key::ImportApplyBtn, &[("count", &selected_count.to_string())]);

    let dlg = MaterialDialog::new("import-review-dlg")
        .width(640.0)
        .icon(ms_icon("playlist_add", true, 24.0, accent))
        .headline(t(lang, Key::ImportReviewTitle))
        .supporting_text(summary)
        .content(div().flex().flex_col().gap(px(10.0)).child(actions_row).child(rows))
        .action(
            MaterialButton::new("ir-cancel")
                .variant(ButtonVariant::Text)
                .child(t(lang, Key::Cancel))
                .on_click(move |_, _, cx| {
                    st_cancel.update(cx, |s, cx| {
                        s.audio.stop_preview();
                        s.preview_track_id = None;
                        s.import_job.review_items.clear();
                        s.dialog = None;
                        cx.notify();
                    });
                }),
        )
        .action(
            MaterialButton::new("ir-apply")
                .variant(ButtonVariant::Filled)
                .disabled(selected_count == 0)
                .child(apply_lbl)
                .on_click(move |_, _, cx| {
                    st_apply.update(cx, |s, cx| s.apply_import_review(cx));
                }),
        );

    div()
        .id("ir-scrim")
        .absolute()
        .inset_0()
        .bg(gpui_kit::Hsla { h: 0.0, s: 0.0, l: 0.0, a: 0.56 })
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.0))
        .child(dlg)
        .into_any_element()
}
