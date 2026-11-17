use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, point,
    prelude::FluentBuilder, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::{
    ButtonSize, ButtonVariant, CheckboxState, LoadingIndicator, MaterialButton, MaterialCheckbox,
    MaterialDialog, MaterialTabs, TabItem, TextField, TextFieldVariant,
};
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, t};
use resonance_core::models::{CreateInitialTab, DialogKind, PlaylistSection, fmt_time};

use crate::assets::ms_icon;
use crate::store::{AppStore, ImportDialogMode, ImportPhase};
use crate::ui::controls::{
    M3ButtonSize, M3ButtonVariant, M3IconBtnSize, M3IconBtnVariant, m3_button, m3_icon_button,
};
use crate::ui::import_review::render_import_review_dialog;
use crate::ui::{rgba_alpha, role_alpha};

pub fn render_overlays(store: &Entity<AppStore>, window: &mut Window, cx: &mut App) -> AnyElement {
    let s = store.read(cx);
    let dialog = s.dialog.clone();
    let lyrics_search_open = s.lyrics_search_open;
    let snacks: Vec<_> = s.snacks.iter().cloned().collect();

    let mut root = div().absolute().inset_0();

    // 1. Active main modal dialog
    if let Some(kind) = dialog {
        let dialog_el: AnyElement = match kind {
            DialogKind::Create { track_id, .. } => {
                render_create_or_import_dialog(store, track_id, window, cx)
            }
            DialogKind::Rename { id } => render_rename_dialog(store, id, cx),
            DialogKind::Delete { id } => render_delete_dialog(store, id, cx),
            DialogKind::ImportReview => render_import_review_dialog(store, window, cx),
            DialogKind::Update => render_update_dialog(store, cx),
            DialogKind::UpdateUninstall | DialogKind::Uninstall => render_uninstall_dialog(store, cx),
            DialogKind::ClearCache => render_clear_cache_dialog(store, cx),
        };
        root = root.child(dialog_el);
    }

    // 2. Manual Lyrics Search modal
    if lyrics_search_open {
        root = root.child(render_lyrics_search_dialog(store, cx));
    }

    // 3. Snackbars stack (.snackbar: centered bottom: 122px pill in INVERSE_SURFACE)
    if !snacks.is_empty() {
        let mut stack = div()
            .absolute()
            .bottom(px(122.0))
            .left(px(0.0))
            .right(px(0.0))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(8.0));

        for sn in snacks {
            let st_act = store.clone();
            let st_dis = store.clone();
            let sn_id = sn.id;
            let sn_id2 = sn.id;
            let inv_bg = color(ColorRole::INVERSE_SURFACE);
            let inv_fg = color(ColorRole::INVERSE_ON_SURFACE);
            let inv_pri = color(ColorRole::INVERSE_PRIMARY);

            let mut pill = div()
                .id(SharedString::from(format!("snack-{sn_id}")))
                .min_h(px(50.0))
                .max_w(px(560.0))
                .pl(px(18.0))
                .pr(px(8.0))
                .py(px(4.0))
                .rounded(px(18.0))
                .bg(inv_bg)
                .shadow(vec![BoxShadow {
                    color: rgba_alpha(gpui_kit::rgb(0x000000), 0.50),
                    offset: point(px(0.0), px(14.0)),
                    blur_radius: px(36.0),
                    spread_radius: px(-10.0),
                    inset: false,
                }])
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .text_size(px(14.0))
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .text_color(inv_fg)
                        .child(sn.text),
                );

            if let Some(lbl) = sn.action_label {
                pill = pill.child(
                    div()
                        .id(SharedString::from(format!("snack-act-{sn_id}")))
                        .h(px(40.0))
                        .px(px(14.0))
                        .rounded(px(20.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(14.0))
                        .font_weight(gpui_kit::FontWeight::BOLD)
                        .text_color(inv_pri)
                        .cursor_pointer()
                        .hover(|st| st.bg(rgba_alpha(gpui_kit::rgb(0xffffff), 0.10)))
                        .on_click(move |_, w, cx| {
                            st_act.update(cx, |s, cx| s.trigger_snack_action(sn_id, w, cx));
                        })
                        .child(lbl),
                );
            }

            pill = pill.child(m3_icon_button(
                SharedString::from(format!("snack-cls-{sn_id2}")),
                "close",
                false,
                M3IconBtnVariant::Standard,
                M3IconBtnSize::Sm,
                false,
                false,
                false,
                move |_, cx| {
                    st_dis.update(cx, |s, cx| {
                        s.snacks.retain(|x| x.id != sn_id2);
                        cx.notify();
                    });
                },
            ));

            stack = stack.child(pill);
        }
        root = root.child(stack);
    }

    root.into_any_element()
}

fn wrap_modal(content: impl IntoElement) -> AnyElement {
    div()
        .id("modal-scrim")
        .absolute()
        .inset_0()
        .bg(gpui_kit::Hsla { h: 0.0, s: 0.0, l: 0.0, a: 0.56 })
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.0))
        .child(content)
        .into_any_element()
}

fn render_create_or_import_dialog(
    store: &Entity<AppStore>,
    track_id: Option<String>,
    _window: &mut Window,
    cx: &App,
) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let ink = rgba_alpha(color(ColorRole::ON_SURFACE), 0.96);
    let muted = rgba_alpha(color(ColorRole::ON_SURFACE_VARIANT), 0.84);
    let accent = color(ColorRole::PRIMARY);
    let tab = s.create_initial_tab.clone();
    let mode = s.import_mode;
    let import = s.import_job.clone();
    let name_inp = s.dialog_name_input.clone();
    let url_inp = s.dialog_url_input.clone();
    let cname_inp = s.dialog_custom_name_input.clone();

    let st_tab = store.clone();
    let tabs = MaterialTabs::new("create-tabs", "Create Playlist Mode")
        .items([
            TabItem::new("scratch", t(lang, Key::ImportTabScratch)),
            TabItem::new("import", t(lang, Key::ImportTabImport)),
        ])
        .selected(if tab == CreateInitialTab::Import { "import" } else { "scratch" })
        .on_change(move |val: &SharedString, _, cx| {
            let next = if val.as_ref() == "import" {
                CreateInitialTab::Import
            } else {
                CreateInitialTab::Scratch
            };
            st_tab.update(cx, |s, cx| {
                s.create_initial_tab = next;
                cx.notify();
            });
        });

    let body: AnyElement = if tab == CreateInitialTab::Scratch {
        div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .pt(px(8.0))
            .child(
                TextField::new("create-pl-name", &name_inp)
                    .variant(TextFieldVariant::Outlined)
                    .label(t(lang, Key::PlaylistName)),
            )
            .into_any_element()
    } else {
        let st_m1 = store.clone();
        let st_m2 = store.clone();
        div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .pt(px(8.0))
            .child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        MaterialButton::new("imp-mode-link")
                            .variant(if mode == ImportDialogMode::Link { ButtonVariant::Tonal } else { ButtonVariant::Outlined })
                            .button_size(ButtonSize::Small)
                            .child(t(lang, Key::ImportModePlaylist))
                            .on_click(move |_, _, cx| {
                                st_m1.update(cx, |s, cx| {
                                    s.import_mode = ImportDialogMode::Link;
                                    cx.notify();
                                });
                            }),
                    )
                    .child(
                        MaterialButton::new("imp-mode-sc")
                            .variant(if mode == ImportDialogMode::ScLikes { ButtonVariant::Tonal } else { ButtonVariant::Outlined })
                            .button_size(ButtonSize::Small)
                            .child(t(lang, Key::ImportModeScLikes))
                            .on_click(move |_, _, cx| {
                                st_m2.update(cx, |s, cx| {
                                    s.import_mode = ImportDialogMode::ScLikes;
                                    cx.notify();
                                });
                            }),
                    ),
            )
            .child(
                TextField::new("imp-url-tf", &url_inp)
                    .variant(TextFieldVariant::Outlined)
                    .label(t(
                        lang,
                        if mode == ImportDialogMode::Link {
                            Key::ImportLinkLabel
                        } else {
                            Key::ImportScUserLabel
                        },
                    )),
            )
            .child(
                TextField::new("imp-cname-tf", &cname_inp)
                    .variant(TextFieldVariant::Outlined)
                    .label(t(lang, Key::ImportCustomNameLabel)),
            )
            .child(
                div()
                    .text_size(px(11.5))
                    .text_color(muted)
                    .child(t(
                        lang,
                        if mode == ImportDialogMode::Link {
                            Key::ImportSourcesHint
                        } else {
                            Key::ImportScLikesHint
                        },
                    )),
            )
            .when(import.running, |d| {
                let status_txt = match import.phase {
                    Some(ImportPhase::Matching) => s.tf(
                        Key::ImportMatching,
                        &[
                            ("done", &import.done.to_string()),
                            ("total", &import.total.to_string()),
                        ],
                    ),
                    Some(ImportPhase::Saving) => t(lang, Key::ImportFinalizing).to_string(),
                    _ => t(lang, Key::ImportFetching).to_string(),
                };
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.0))
                        .p(px(10.0))
                        .rounded(px(12.0))
                        .bg(role_alpha(ColorRole::PRIMARY_CONTAINER, 0.45))
                        .child(LoadingIndicator::new("imp-prog", t(lang, Key::ImportFetching)))
                        .child(div().text_size(px(12.5)).text_color(ink).child(status_txt)),
                )
            })
            .into_any_element()
    };

    let st_cancel = store.clone();
    let st_ok = store.clone();
    let tid_c = track_id.clone();

    let dlg = MaterialDialog::new("create-pl-dialog")
        .width(460.0)
        .icon(ms_icon("playlist_add", true, 24.0, accent))
        .headline(t(lang, Key::NewPlaylist))
        .content(div().flex().flex_col().gap(px(8.0)).child(tabs).child(body))
        .on_dismiss(move |_, cx| {
            st_cancel.update(cx, |s, cx| {
                s.dialog = None;
                cx.notify();
            });
        })
        .action({
            let st_c = store.clone();
            MaterialButton::new("create-cancel")
                .variant(ButtonVariant::Text)
                .child(t(lang, Key::Cancel))
                .on_click(move |_, _, cx| {
                    st_c.update(cx, |s, cx| {
                        s.dialog = None;
                        cx.notify();
                    });
                })
        })
        .action(
            MaterialButton::new("create-submit")
                .variant(ButtonVariant::Filled)
                .disabled(import.running)
                .child(t(
                    lang,
                    if tab == CreateInitialTab::Import {
                        Key::ImportStartBtn
                    } else {
                        Key::Create
                    },
                ))
                .on_click(move |_, _, cx| {
                    let tid = tid_c.clone();
                    st_ok.update(cx, |s, cx| {
                        if s.create_initial_tab == CreateInitialTab::Scratch {
                            let name = s.dialog_name_input.read(cx).value().to_string();
                            s.create_playlist(name, tid, PlaylistSection::Local, None, None, cx);
                            s.dialog = None;
                        } else {
                            let url = s.dialog_url_input.read(cx).value().to_string();
                            let cname = s.dialog_custom_name_input.read(cx).value().to_string();
                            let m = s.import_mode;
                            s.start_import(m, url, cname, cx);
                        }
                    });
                }),
        );

    wrap_modal(dlg)
}

fn render_rename_dialog(store: &Entity<AppStore>, id: String, cx: &App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let inp = s.dialog_name_input.clone();
    let st_c = store.clone();
    let st_s = store.clone();
    let id_save = id.clone();

    let dlg = MaterialDialog::new("rename-pl-dlg")
        .width(400.0)
        .headline(t(lang, Key::Rename))
        .content(
            TextField::new("rename-pl-tf", &inp)
                .variant(TextFieldVariant::Outlined)
                .label(t(lang, Key::PlaylistName)),
        )
        .action(
            MaterialButton::new("ren-cancel")
                .variant(ButtonVariant::Text)
                .child(t(lang, Key::Cancel))
                .on_click(move |_, _, cx| {
                    st_c.update(cx, |s, cx| {
                        s.dialog = None;
                        cx.notify();
                    });
                }),
        )
        .action(
            MaterialButton::new("ren-save")
                .variant(ButtonVariant::Filled)
                .child(t(lang, Key::Save))
                .on_click(move |_, _, cx| {
                    let pid = id_save.clone();
                    st_s.update(cx, |s, cx| {
                        let name = s.dialog_name_input.read(cx).value().to_string();
                        s.rename_playlist(&pid, name, cx);
                        s.dialog = None;
                    });
                }),
        );
    wrap_modal(dlg)
}

fn render_delete_dialog(store: &Entity<AppStore>, id: String, cx: &App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let name = s
        .library
        .playlists
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.name.clone())
        .unwrap_or_default();
    let body = s.tf(Key::DeletePlaylistText, &[("name", &name)]);
    let st_c = store.clone();
    let st_d = store.clone();
    let id_del = id;

    let dlg = MaterialDialog::new("del-pl-dlg")
        .width(400.0)
        .icon(ms_icon("delete", true, 24.0, color(ColorRole::ERROR)))
        .headline(t(lang, Key::DeletePlaylistQ))
        .supporting_text(body)
        .action(
            MaterialButton::new("del-cancel")
                .variant(ButtonVariant::Text)
                .child(t(lang, Key::Cancel))
                .on_click(move |_, _, cx| {
                    st_c.update(cx, |s, cx| {
                        s.dialog = None;
                        cx.notify();
                    });
                }),
        )
        .action(
            MaterialButton::new("del-ok")
                .variant(ButtonVariant::Filled)
                .child(t(lang, Key::Delete))
                .on_click(move |_, w, cx| {
                    let pid = id_del.clone();
                    st_d.update(cx, |s, cx| {
                        s.delete_playlist(&pid, w, cx);
                        s.dialog = None;
                    });
                }),
        );
    wrap_modal(dlg)
}

fn render_update_dialog(store: &Entity<AppStore>, cx: &App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let u = &s.update_state;
    let body = format!(
        "{}: v{}\n{}: v{}\n\n{}",
        t(lang, Key::UpdateCurrentVer),
        u.current_version,
        t(lang, Key::UpdateLatestVer),
        u.latest_version,
        u.notes
    );
    let st_c = store.clone();
    let st_go = store.clone();

    let dlg = MaterialDialog::new("upd-dlg")
        .width(440.0)
        .icon(ms_icon("system_update", true, 24.0, color(ColorRole::PRIMARY)))
        .headline(t(lang, Key::UpdateAvailable))
        .supporting_text(body)
        .action(
            MaterialButton::new("upd-close")
                .variant(ButtonVariant::Text)
                .child(t(lang, Key::CloseBtn))
                .on_click(move |_, _, cx| {
                    st_c.update(cx, |s, cx| {
                        s.dialog = None;
                        cx.notify();
                    });
                }),
        )
        .action(
            MaterialButton::new("upd-open")
                .variant(ButtonVariant::Filled)
                .child(t(lang, Key::UpdateInstallBtn))
                .on_click(move |_, _, cx| {
                    st_go.update(cx, |s, cx| {
                        s.open_update_release();
                        s.dialog = None;
                        cx.notify();
                    });
                }),
        );
    wrap_modal(dlg)
}

fn render_uninstall_dialog(store: &Entity<AppStore>, cx: &App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let checked = s.dialog_confirm_checked;
    let st_chk = store.clone();
    let st_c = store.clone();
    let st_run = store.clone();

    let dlg = MaterialDialog::new("uninst-dlg")
        .width(440.0)
        .icon(ms_icon("delete_forever", true, 24.0, color(ColorRole::ERROR)))
        .headline(t(lang, Key::UninstallTitle))
        .supporting_text(t(lang, Key::UninstallText))
        .content(
            MaterialCheckbox::new("uninst-chk", t(lang, Key::UninstallConfirmCheck))
                .checked(checked)
                .on_change(move |st: &CheckboxState, _, cx| {
                    let v = *st == CheckboxState::Checked;
                    st_chk.update(cx, |s, cx| {
                        s.dialog_confirm_checked = v;
                        cx.notify();
                    });
                }),
        )
        .action(
            MaterialButton::new("uninst-cancel")
                .variant(ButtonVariant::Text)
                .child(t(lang, Key::Cancel))
                .on_click(move |_, _, cx| {
                    st_c.update(cx, |s, cx| {
                        s.dialog = None;
                        s.dialog_confirm_checked = false;
                        cx.notify();
                    });
                }),
        )
        .action(
            MaterialButton::new("uninst-go")
                .variant(ButtonVariant::Filled)
                .disabled(!checked)
                .child(t(lang, Key::UninstallBtn))
                .on_click(move |_, _, cx| {
                    st_run.update(cx, |s, cx| s.run_uninstall(cx));
                }),
        );
    wrap_modal(dlg)
}

fn render_clear_cache_dialog(store: &Entity<AppStore>, cx: &App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let checked = s.dialog_confirm_checked;
    let st_chk = store.clone();
    let st_c = store.clone();
    let st_go = store.clone();

    let dlg = MaterialDialog::new("clr-cache-dlg")
        .width(440.0)
        .icon(ms_icon("delete_sweep", true, 24.0, color(ColorRole::ERROR)))
        .headline(t(lang, Key::ClearCacheTitle))
        .supporting_text(t(lang, Key::ClearCacheText))
        .content(
            MaterialCheckbox::new("clr-cache-chk", t(lang, Key::ClearCacheConfirmCheck))
                .checked(checked)
                .on_change(move |st: &CheckboxState, _, cx| {
                    let v = *st == CheckboxState::Checked;
                    st_chk.update(cx, |s, cx| {
                        s.dialog_confirm_checked = v;
                        cx.notify();
                    });
                }),
        )
        .action(
            MaterialButton::new("clr-cancel")
                .variant(ButtonVariant::Text)
                .child(t(lang, Key::Cancel))
                .on_click(move |_, _, cx| {
                    st_c.update(cx, |s, cx| {
                        s.dialog = None;
                        s.dialog_confirm_checked = false;
                        cx.notify();
                    });
                }),
        )
        .action(
            MaterialButton::new("clr-ok")
                .variant(ButtonVariant::Filled)
                .disabled(!checked)
                .child(t(lang, Key::ClearCacheBtn))
                .on_click(move |_, _, cx| {
                    st_go.update(cx, |s, cx| {
                        s.dialog_confirm_checked = false;
                        s.run_clear_cache(cx);
                    });
                }),
        );
    wrap_modal(dlg)
}

fn render_lyrics_search_dialog(store: &Entity<AppStore>, cx: &App) -> AnyElement {
    let s = store.read(cx);
    let lang = s.lang();
    let dark = s.resolved_theme.dark;
    let ink = rgba_alpha(color(ColorRole::ON_SURFACE), 0.96);
    let muted = rgba_alpha(color(ColorRole::ON_SURFACE_VARIANT), 0.84);
    let inp = s.lyrics_search_input.clone();
    let loading = s.lyrics_search_loading;
    let results = s.lyrics_search_results.clone();

    let st_go = store.clone();
    let st_close = store.clone();

    let mut list = div()
        .id("lyr-search-results")
        .max_h(px(300.0))
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(6.0));

    if loading {
        list = list.child(
            div()
                .py(px(18.0))
                .flex()
                .justify_center()
                .child(LoadingIndicator::new("lyr-srch-spin", "Searching")),
        );
    } else if results.is_empty() {
        list = list.child(
            div()
                .py(px(16.0))
                .text_size(px(13.0))
                .text_color(muted)
                .text_center()
                .child(t(lang, Key::ImportSearchEmpty)),
        );
    } else {
        for (idx, item) in results.into_iter().enumerate() {
            let st_pick = store.clone();
            let it_clone = item.clone();
            let synced = item.synced_lyrics.as_deref().is_some_and(|x| !x.is_empty());
            list = list.child(
                div()
                    .id(SharedString::from(format!("lyr-pick-{idx}")))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(10.0))
                    .p(px(10.0))
                    .rounded(px(12.0))
                    .bg(role_alpha(ColorRole::SURFACE_CONTAINER_LOW, 0.7))
                    .hover(|d| d.bg(role_alpha(ColorRole::SURFACE_CONTAINER_HIGH, 0.8)))
                    .cursor_pointer()
                    .on_click(move |_, _, cx| {
                        let choice = it_clone.clone();
                        st_pick.update(cx, |s, cx| s.apply_manual_lyrics(choice, cx));
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .text_size(px(13.5))
                                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                                    .text_color(ink)
                                    .truncate()
                                    .child(item.track_name),
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .text_color(muted)
                                    .truncate()
                                    .child(format!("{} · {}", item.artist_name, fmt_time(item.duration))),
                            ),
                    )
                    .when(synced, |d| {
                        d.child(
                            div()
                                .px(px(8.0))
                                .py(px(2.0))
                                .rounded(px(8.0))
                                .bg(role_alpha(ColorRole::PRIMARY_CONTAINER, 0.75))
                                .text_size(px(11.0))
                                .text_color(color(ColorRole::ON_PRIMARY_CONTAINER))
                                .child(t(lang, Key::LyricsSyncedBadge)),
                        )
                    }),
            );
        }
    }

    let card = div()
        .id("lyr-srch-modal-card")
        .w(px(500.0))
        .p(px(24.0))
        .rounded(px(30.0))
        .bg(color(ColorRole::SURFACE_CONTAINER_HIGH))
        .shadow(vec![BoxShadow {
            color: rgba_alpha(gpui_kit::rgb(0x000000), 0.55),
            offset: point(px(0.0), px(30.0)),
            blur_radius: px(80.0),
            spread_radius: px(-20.0),
            inset: false,
        }])
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(px(22.0))
                        .font_weight(gpui_kit::FontWeight::BOLD)
                        .text_color(ink)
                        .child(t(lang, Key::LyricsSearchTitle)),
                )
                .child(m3_icon_button(
                    "lyr-srch-close",
                    "close",
                    false,
                    M3IconBtnVariant::Standard,
                    M3IconBtnSize::Sm,
                    false,
                    false,
                    false,
                    move |_, cx| {
                        st_close.update(cx, |s, cx| {
                            s.lyrics_search_open = false;
                            cx.notify();
                        });
                    },
                )),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div().flex_1().child(
                        TextField::new("lyr-srch-tf", &inp)
                            .variant(TextFieldVariant::Outlined)
                            .placeholder(t(lang, Key::LyricsSearchPlaceholder)),
                    ),
                )
                .child(m3_button(
                    "lyr-srch-go",
                    t(lang, Key::Search),
                    Some("search"),
                    M3ButtonVariant::Tonal,
                    M3ButtonSize::Default,
                    false,
                    move |_, cx| {
                        st_go.update(cx, |s, cx| {
                            let q = s.lyrics_search_input.read(cx).value().to_string();
                            s.search_lyrics_manual(q, cx);
                        });
                    },
                )),
        )
        .child(list);

    let _ = dark;
    wrap_modal(card)
}
