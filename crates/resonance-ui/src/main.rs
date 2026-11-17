mod assets;
mod http_client;
mod pages;
mod store;
mod ui;

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::{
    AppContext, Bounds, Context, Entity, Focusable, InteractiveElement, IntoElement, KeyDownEvent,
    MouseButton, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled,
    TitlebarOptions, Window, WindowBounds, WindowOptions, div, prelude::FluentBuilder, px, size,
};
use gpui_kit_material::theme;
use resonance_core::color_engine::{argb_from_hex, build_scheme};
use resonance_core::models::{Appearance, ColorVariant};
use resonance_core::shortcuts::{ShortcutId, shortcut_from_keystroke};

use crate::assets::ResonanceAssets;
use crate::http_client::ReqwestGpuiHttpClient;
use crate::pages::render_center_page;
use crate::store::AppStore;
use crate::ui::background::render_background;
use crate::ui::controls::{
    M3IconBtnSize, M3IconBtnVariant, end_global_slider_drag, handle_global_slider_mouse_move,
    m3_icon_button,
};
use crate::ui::eq_panel::render_eq_popover;
use crate::ui::immersive::render_immersive;
use crate::ui::mini_player::render_mini_player;
use crate::ui::now_playing::render_now_playing_panel;
use crate::ui::overlays::render_overlays;
use crate::ui::seek::{end_global_seek_drag, handle_global_seek_mouse_move};
use crate::ui::sidebar::render_sidebar;
use crate::ui::splash::render_splash;
use crate::ui::{SurfaceKind, glass_panel_with_neon};

struct ResonanceRoot {
    store: Entity<AppStore>,
    drag_seek: Rc<Cell<bool>>,
    theme_frame_scheduled: bool,
}

impl ResonanceRoot {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = cx.new(|cx| AppStore::new(window, cx));
        Self {
            store,
            drag_seek: Rc::new(Cell::new(false)),
            theme_frame_scheduled: false,
        }
    }

    fn schedule_theme_step(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.theme_frame_scheduled {
            return;
        }
        self.theme_frame_scheduled = true;
        cx.on_next_frame(window, |root, window, cx| {
            root.theme_frame_scheduled = false;
            let still_running = root.store.update(cx, |s, cx| s.advance_theme_if_needed(window, cx));
            if still_running {
                root.schedule_theme_step(window, cx);
            }
        });
    }

    fn handle_key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let ks = &ev.keystroke;
        let combo = shortcut_from_keystroke(
            &ks.key,
            ks.modifiers.control,
            ks.modifiers.alt,
            ks.modifiers.shift,
            ks.modifiers.platform,
        );
        let Some(combo) = combo else { return };

        let rec = self.store.read(cx).recording_shortcut;
        if let Some(id) = rec {
            if ks.key == "escape" {
                self.store.update(cx, |s, cx| {
                    s.recording_shortcut = None;
                    s.shortcut_error = None;
                    cx.notify();
                });
                return;
            }
            self.store.update(cx, |s, cx| {
                s.update_shortcut(id, combo, cx);
            });
            return;
        }

        // Ignore plain single-key shortcuts when a text field is focused
        let has_modifier = ks.modifiers.control || ks.modifiers.alt || ks.modifiers.platform;
        if !has_modifier {
            let any_focused = {
                let s = self.store.read(cx);
                [
                    &s.search_input,
                    &s.fav_filter_input,
                    &s.playlist_filter_input,
                    &s.dialog_name_input,
                    &s.dialog_url_input,
                    &s.dialog_custom_name_input,
                    &s.lyrics_search_input,
                    &s.import_alt_search_input,
                    &s.sc_token_input,
                    &s.hex_accent_input,
                    &s.hex_bg_input,
                ]
                .iter()
                .any(|inp| inp.read(cx).focus_handle(cx).is_focused(window))
            };
            if any_focused {
                if ks.key == "escape" {
                    self.store.update(cx, |s, cx| {
                        if s.lyrics_search_open {
                            s.lyrics_search_open = false;
                        } else if s.dialog.is_some() {
                            s.dialog = None;
                        } else if s.eq_open {
                            s.eq_open = false;
                        } else if s.immersive_open {
                            s.immersive_open = false;
                        }
                        cx.notify();
                    });
                }
                return;
            }
        }

        if ks.key == "escape" {
            self.store.update(cx, |s, cx| {
                if s.lyrics_search_open {
                    s.lyrics_search_open = false;
                } else if s.dialog.is_some() {
                    s.dialog = None;
                } else if s.eq_open {
                    s.eq_open = false;
                } else if s.immersive_open {
                    s.immersive_open = false;
                } else if s.search_open {
                    s.search_open = false;
                }
                cx.notify();
            });
            return;
        }

        let bindings = self.store.read(cx).shortcuts.clone();
        if combo == bindings.get(ShortcutId::PlayPause) {
            self.store.update(cx, |s, cx| s.toggle_play(cx));
        } else if combo == bindings.get(ShortcutId::SeekBack) {
            self.store.update(cx, |s, cx| {
                let target = (s.position - 5.0).max(0.0);
                s.seek_to(target, cx);
            });
        } else if combo == bindings.get(ShortcutId::SeekForward) {
            self.store.update(cx, |s, cx| {
                let target = s.position + 5.0;
                s.seek_to(target, cx);
            });
        } else if combo == bindings.get(ShortcutId::Previous) {
            self.store.update(cx, |s, cx| s.prev_track(cx));
        } else if combo == bindings.get(ShortcutId::Next) {
            self.store.update(cx, |s, cx| s.next_track(cx));
        } else if combo == bindings.get(ShortcutId::Like) {
            self.store.update(cx, |s, cx| {
                if let Some(id) = s.current_track_id.clone() {
                    s.toggle_like(&id, cx);
                }
            });
        } else if combo == bindings.get(ShortcutId::Lyrics) {
            self.store.update(cx, |s, cx| {
                s.immersive_open = !s.immersive_open;
                cx.notify();
            });
        } else if combo == bindings.get(ShortcutId::Search) {
            self.store.update(cx, |s, cx| s.open_search(None, window, cx));
        } else if combo == bindings.get(ShortcutId::Mute) {
            self.store.update(cx, |s, cx| s.toggle_mute(cx));
        }
    }
}

impl Render for ResonanceRoot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let need_theme_step = {
            let s = self.store.read(cx);
            s.theme_dirty || s.theme_animating
        };
        if need_theme_step {
            self.schedule_theme_step(window, cx);
        }

        let vp = window.viewport_size();
        let vw = f32::from(vp.width);
        let is_md_or_wider = vw >= 768.0;
        let is_xl_or_wider = vw >= 1200.0;

        let (
            appearance,
            resolved_dark,
            neon_argb,
            neon_k,
            bg_spec,
            mesh_phase,
            panel_open,
            sidebar_collapsed,
            mob_nav,
            mob_np,
            has_track,
        ) = {
            let s = self.store.read(cx);
            let k = if s.appearance.metallic_neon {
                (s.appearance.metallic_neon_intensity / 100.0).clamp(0.0, 1.0)
            } else {
                0.0
            };
            (
                s.appearance.clone(),
                s.resolved_theme.dark,
                s.resolved_theme.neon_argb,
                k,
                s.resolved_theme.bg.clone(),
                s.mesh_phase,
                s.ui.panel_open,
                s.ui.sidebar_collapsed,
                s.mobile_nav_open,
                s.mobile_np_open,
                s.current_track_id.is_some(),
            )
        };

        let gap_px = if is_md_or_wider { 12.0 } else { 8.0 };
        let sb_w = if is_md_or_wider {
            (if sidebar_collapsed { 88.0 } else { 272.0 }) + gap_px
        } else {
            0.0
        };
        let np_w = if is_xl_or_wider && panel_open {
            360.0 + gap_px
        } else {
            0.0
        };
        let center_w = (vw - gap_px * 2.0 - sb_w - np_w).max(0.0);

        let desktop_sidebar = if is_md_or_wider {
            Some(render_sidebar(&self.store, false, window, cx))
        } else {
            None
        };
        let center_el = render_center_page(&self.store, window, cx);
        let desktop_np = if is_xl_or_wider && panel_open {
            Some(render_now_playing_panel(&self.store, false, window, cx))
        } else {
            None
        };
        let mini_el = render_mini_player(
            &self.store,
            self.drag_seek.clone(),
            center_w < 540.0,
            vw,
            window,
            cx,
        );

        let mut center_panel = glass_panel_with_neon(
            &appearance,
            resolved_dark,
            SurfaceKind::CenterPanel,
            28.0,
            neon_argb,
        )
        .flex_1()
        .min_w(px(0.0))
        .h_full()
        .relative()
        .overflow_hidden()
        .child(center_el)
        .child(
            div()
                .absolute()
                .left(px(12.0))
                .right(px(12.0))
                .bottom(px(12.0))
                .child(mini_el),
        );

        if !is_md_or_wider {
            let st_mob_nav = self.store.clone();
            center_panel = center_panel.child(
                div().absolute().top(px(12.0)).left(px(12.0)).child(m3_icon_button(
                    "fab-menu",
                    "menu",
                    false,
                    M3IconBtnVariant::Glass,
                    M3IconBtnSize::Lg,
                    false,
                    false,
                    false,
                    move |_, cx| {
                        st_mob_nav.update(cx, |s, cx| {
                            s.mobile_nav_open = !s.mobile_nav_open;
                            cx.notify();
                        });
                    },
                )),
            );
        }

        if !is_xl_or_wider && has_track {
            let st_mob_np = self.store.clone();
            center_panel = center_panel.child(
                div().absolute().top(px(12.0)).right(px(12.0)).child(m3_icon_button(
                    "fab-mob-np",
                    "lyrics",
                    mob_np,
                    M3IconBtnVariant::Glass,
                    M3IconBtnSize::Md,
                    true,
                    mob_np,
                    false,
                    move |_, cx| {
                        st_mob_np.update(cx, |s, cx| {
                            s.mobile_np_open = !s.mobile_np_open;
                            cx.notify();
                        });
                    },
                )),
            );
        }

        let mut workspace_row = div()
            .flex_1()
            .min_h(px(0.0))
            .w_full()
            .h_full()
            .flex()
            .gap(px(gap_px))
            .p(px(gap_px));
        if let Some(sb) = desktop_sidebar {
            workspace_row = workspace_row.child(sb);
        }
        workspace_row = workspace_row.child(center_panel);
        if let Some(np) = desktop_np {
            workspace_row = workspace_row.child(np);
        }

        let st_close_drawers = self.store.clone();
        let mobile_nav_overlay = if !is_md_or_wider && mob_nav {
            let sb = render_sidebar(&self.store, true, window, cx);
            Some(
                div()
                    .id("mob-nav-scrim")
                    .absolute()
                    .inset_0()
                    .bg(gpui_kit::Hsla { h: 0.0, s: 0.0, l: 0.0, a: 0.5 })
                    .flex()
                    .p(px(12.0))
                    .on_click(move |_, _, cx| {
                        st_close_drawers.update(cx, |s, cx| {
                            s.mobile_nav_open = false;
                            cx.notify();
                        });
                    })
                    .child(sb),
            )
        } else {
            None
        };

        let st_close_np = self.store.clone();
        let mobile_np_overlay = if !is_xl_or_wider && mob_np {
            let np = render_now_playing_panel(&self.store, true, window, cx);
            Some(
                div()
                    .id("mob-np-scrim")
                    .absolute()
                    .inset_0()
                    .bg(gpui_kit::Hsla { h: 0.0, s: 0.0, l: 0.0, a: 0.5 })
                    .flex()
                    .justify_end()
                    .p(px(12.0))
                    .on_click(move |_, _, cx| {
                        st_close_np.update(cx, |s, cx| {
                            s.mobile_np_open = false;
                            cx.notify();
                        });
                    })
                    .child(np),
            )
        } else {
            None
        };

        let immersive_el = render_immersive(&self.store, self.drag_seek.clone(), window, cx);
        let eq_el = render_eq_popover(&self.store, window, cx);
        let overlays_el = render_overlays(&self.store, window, cx);
        let splash_el = render_splash(&self.store, cx);

        let _ = SharedString::from("");

        div()
            .id("resonance-app-root")
            .relative()
            .size_full()
            .overflow_hidden()
            .font_family("Roboto")
            .on_key_down(cx.listener(Self::handle_key_down))
            .on_mouse_move(|ev, _, cx| {
                let left = ev.pressed_button == Some(MouseButton::Left);
                handle_global_slider_mouse_move(ev.position, left, cx);
                handle_global_seek_mouse_move(ev.position, left, cx);
            })
            .on_mouse_up(MouseButton::Left, |_, _, _| {
                end_global_slider_drag();
                end_global_seek_drag();
            })
            .child(render_background(
                &bg_spec,
                &appearance,
                neon_argb,
                neon_k,
                mesh_phase,
            ))
            .child(workspace_row)
            .when_some(mobile_nav_overlay, |d, el| d.child(el))
            .when_some(mobile_np_overlay, |d, el| d.child(el))
            .child(immersive_el)
            .child(eq_el)
            .child(overlays_el)
            .child(splash_el)
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    gpui_kit::application()
        .with_assets(ResonanceAssets.into_asset_source())
        .with_http_client(Arc::new(ReqwestGpuiHttpClient::default()))
        .run(|cx| {
            gpui_kit::init(cx);
            crate::assets::register_embedded_fonts(cx);
            gpui_kit_material::init(cx);

            let def = Appearance::default();
            let init_scheme = build_scheme(
                argb_from_hex(&def.accent_color),
                argb_from_hex(&def.bg_color),
                true,
                ColorVariant::Neutral,
            );
            theme::init_component_theme(init_scheme, 1.0, cx);

            let opts = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1280.0), px(720.0)),
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Resonance".into()),
                    appears_transparent: false,
                    traffic_light_position: None,
                }),
                ..Default::default()
            };

            gpui_kit::open_window(opts, cx, |window, cx| {
                cx.new(|cx| ResonanceRoot::new(window, cx))
            })
            .expect("open Resonance window");

            cx.activate(true);
        });
}
