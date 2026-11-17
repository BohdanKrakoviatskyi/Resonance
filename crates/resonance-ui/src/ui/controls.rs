use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui_kit::{
    App, Bounds, BoxShadow, Corners, Div, ElementId, Hsla, ImageSource,
    InteractiveElement, MouseButton, ObjectFit, ParentElement, PathBuilder, Pixels, Point,
    SharedString, Stateful, StatefulInteractiveElement, Styled, StyledImage, canvas, div, fill,
    hsla, img, linear_color_stop, linear_gradient, point, prelude::FluentBuilder, px, size,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::shapes::{MaterialShape, ShapeFrame, ShapeKind};
use gpui_kit_material::theme::color;

use crate::assets::{ms_icon, tinted_rs_mark};
use crate::store::AppStore;
use crate::ui::{SurfaceKind, glass_panel, mix_hsla, neon_accent_hsla, rgba_alpha, role_alpha};
use resonance_core::models::Appearance;

// ---------------------------------------------------------------------------
// Global pointer drag tracking for custom M3 Expressive capsule sliders
// ---------------------------------------------------------------------------

pub type SliderChangeFn = Rc<dyn Fn(f32, &mut App)>;

struct ActiveSliderDrag {
    bounds: Bounds<Pixels>,
    step: Option<f32>,
    on_change: SliderChangeFn,
}

thread_local! {
    static ACTIVE_SLIDER_DRAG: RefCell<Option<ActiveSliderDrag>> = const { RefCell::new(None) };
}

fn calc_slider_fraction(pos: Point<Pixels>, bounds: Bounds<Pixels>, step: Option<f32>) -> f32 {
    let w = f32::from(bounds.size.width).max(1.0);
    let raw = ((f32::from(pos.x) - f32::from(bounds.left())) / w).clamp(0.0, 1.0);
    if let Some(s) = step
        && s > 0.0
    {
        ((raw / s).round() * s).clamp(0.0, 1.0)
    } else {
        raw
    }
}

/// Forward window-level mouse movement to any actively dragged `m3_slider`.
pub fn handle_global_slider_mouse_move(pos: Point<Pixels>, left_pressed: bool, cx: &mut App) {
    if !left_pressed {
        end_global_slider_drag();
        return;
    }
    let active = ACTIVE_SLIDER_DRAG.with(|slot| {
        let guard = slot.borrow();
        guard.as_ref().map(|d| (d.bounds, d.step, d.on_change.clone()))
    });
    if let Some((bounds, step, cb)) = active {
        let next = calc_slider_fraction(pos, bounds, step);
        cb(next, cx);
    }
}

/// Clears active custom slider drag state on mouse release.
pub fn end_global_slider_drag() {
    ACTIVE_SLIDER_DRAG.with(|slot| {
        *slot.borrow_mut() = None;
    });
}

// ---------------------------------------------------------------------------
// Buttons (.btn / .ib / .play-btn)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum M3ButtonVariant {
    Filled,
    Tonal,
    Outlined,
    Text,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum M3ButtonSize {
    Default,
    Lg,
}

/// M3 Expressive pill button matching `.btn` / `.btn-lg` / `.btn-*` in `src/index.css`.
pub fn m3_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    icon: Option<&'static str>,
    variant: M3ButtonVariant,
    size: M3ButtonSize,
    disabled: bool,
    on_click: impl Fn(&mut gpui_kit::Window, &mut App) + 'static,
) -> Stateful<Div> {
    let (h, px_pad, font_px, icon_px) = match size {
        M3ButtonSize::Default => (40.0, 20.0, 14.0, 20.0),
        M3ButtonSize::Lg => (56.0, 28.0, 16.0, 26.0),
    };
    let h_pad = if variant == M3ButtonVariant::Text {
        14.0
    } else {
        px_pad
    };

    let (bg, fg, border) = match variant {
        M3ButtonVariant::Filled => (
            Hsla::from(color(ColorRole::PRIMARY)),
            Hsla::from(color(ColorRole::ON_PRIMARY)),
            None,
        ),
        M3ButtonVariant::Tonal => (
            Hsla::from(color(ColorRole::SECONDARY_CONTAINER)),
            Hsla::from(color(ColorRole::ON_SECONDARY_CONTAINER)),
            None,
        ),
        M3ButtonVariant::Outlined => (
            gpui_kit::transparent_black(),
            Hsla::from(color(ColorRole::ON_SURFACE)),
            Some(Hsla::from(color(ColorRole::OUTLINE_VARIANT))),
        ),
        M3ButtonVariant::Text => (
            gpui_kit::transparent_black(),
            Hsla::from(color(ColorRole::PRIMARY)),
            None,
        ),
    };

    let mut d = div()
        .id(id)
        .h(px(h))
        .px(px(h_pad))
        .rounded(px(h * 0.5))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .bg(bg)
        .text_size(px(font_px))
        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
        .text_color(fg)
        .whitespace_nowrap();

    if let Some(bcol) = border {
        d = d.border_1().border_color(bcol);
    }

    if let Some(ic) = icon {
        d = d.child(ms_icon(ic, false, icon_px, fg));
    }
    d = d.child(label.into());

    if disabled {
        d.opacity(0.38)
    } else {
        let hover_overlay = match variant {
            M3ButtonVariant::Filled => mix_hsla(bg, color(ColorRole::ON_PRIMARY), 0.08),
            M3ButtonVariant::Tonal => mix_hsla(bg, color(ColorRole::ON_SECONDARY_CONTAINER), 0.08),
            M3ButtonVariant::Outlined | M3ButtonVariant::Text => role_alpha(ColorRole::ON_SURFACE, 0.08),
        };
        d.cursor_pointer()
            .hover(move |s| s.bg(hover_overlay))
            .active(move |s| s.rounded(px(h * 0.28)))
            .on_click(move |_, w, cx| on_click(w, cx))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum M3IconBtnVariant {
    Standard,
    Tonal,
    Filled,
    Glass,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum M3IconBtnSize {
    Sm,
    Md,
    Lg,
}

/// M3 Expressive icon button matching `.ib` / `.ib-*` with squircle toggle morph.
#[allow(clippy::too_many_arguments)]
pub fn m3_icon_button(
    id: impl Into<ElementId>,
    icon: &'static str,
    filled: bool,
    variant: M3IconBtnVariant,
    size: M3IconBtnSize,
    toggle: bool,
    selected: bool,
    disabled: bool,
    on_click: impl Fn(&mut gpui_kit::Window, &mut App) + 'static,
) -> Stateful<Div> {
    let (s, icon_px) = match size {
        M3IconBtnSize::Sm => (34.0, 20.0),
        M3IconBtnSize::Md => (40.0, 24.0),
        M3IconBtnSize::Lg => (52.0, 28.0),
    };

    let squircle = (toggle || variant == M3IconBtnVariant::Tonal) && selected;
    let radius = if squircle { s * 0.32 } else { s * 0.5 };

    let (bg, fg) = if toggle && selected {
        (
            Hsla::from(color(ColorRole::SECONDARY_CONTAINER)),
            Hsla::from(color(ColorRole::ON_SECONDARY_CONTAINER)),
        )
    } else {
        match variant {
            M3IconBtnVariant::Standard => (
                gpui_kit::transparent_black(),
                if selected {
                    Hsla::from(color(ColorRole::PRIMARY))
                } else {
                    Hsla::from(color(ColorRole::ON_SURFACE_VARIANT))
                },
            ),
            M3IconBtnVariant::Tonal => (
                Hsla::from(color(ColorRole::SECONDARY_CONTAINER)),
                Hsla::from(color(ColorRole::ON_SECONDARY_CONTAINER)),
            ),
            M3IconBtnVariant::Filled => (
                Hsla::from(color(ColorRole::PRIMARY)),
                Hsla::from(color(ColorRole::ON_PRIMARY)),
            ),
            M3IconBtnVariant::Glass => (
                role_alpha(ColorRole::ON_SURFACE, 0.09),
                Hsla::from(color(ColorRole::ON_SURFACE)),
            ),
        }
    };

    let d = div()
        .id(id)
        .w(px(s))
        .h(px(s))
        .min_w(px(s))
        .min_h(px(s))
        .flex_shrink_0()
        .rounded(px(radius))
        .flex()
        .items_center()
        .justify_center()
        .bg(bg)
        .child(ms_icon(icon, filled || (toggle && selected), icon_px, fg));

    if disabled {
        d.opacity(0.38)
    } else {
        let hover_bg = if toggle && selected || variant == M3IconBtnVariant::Tonal {
            mix_hsla(bg, color(ColorRole::ON_SECONDARY_CONTAINER), 0.10)
        } else if variant == M3IconBtnVariant::Filled {
            mix_hsla(bg, color(ColorRole::ON_PRIMARY), 0.10)
        } else {
            role_alpha(ColorRole::ON_SURFACE, 0.08)
        };
        d.cursor_pointer()
            .hover(move |st| st.bg(hover_bg))
            .active(move |st| st.rounded(px(s * 0.30)))
            .on_click(move |_, w, cx| on_click(w, cx))
    }
}

/// Styling context for [`m3_play_button`], covering metallic studio & spin state.
#[derive(Clone, Copy)]
pub struct M3PlayStyle {
    pub metallic: bool,
    pub neon_argb: u32,
    pub neon_k: f32,
    pub spin_phase: f32,
}

impl M3PlayStyle {
    pub fn from_store(s: &AppStore) -> Self {
        let neon_k = if s.appearance.metallic_neon {
            (s.appearance.metallic_neon_intensity / 100.0).clamp(0.0, 1.0)
        } else {
            0.0
        };
        Self {
            metallic: s.appearance.metallic,
            neon_argb: s.resolved_theme.neon_argb,
            neon_k,
            spin_phase: s.spin_deg * 12.0,
        }
    }
}

/// Morphing Play/Pause hero button matching `.play-btn` (`52px` mini, `76px` fullscreen).
pub fn m3_play_button(
    id: impl Into<ElementId>,
    size_px: f32,
    playing: bool,
    loading: bool,
    disabled: bool,
    style: M3PlayStyle,
    on_click: impl Fn(&mut gpui_kit::Window, &mut App) + 'static,
) -> Stateful<Div> {
    let metallic = style.metallic;
    let neon_argb = style.neon_argb;
    let neon_k = style.neon_k;
    let spin_phase = style.spin_phase;
    let active = playing || loading;
    let radius = if active { size_px * 0.30 } else { size_px * 0.50 };
    let icon_px = size_px * 0.54;
    let icon_name = if active { "pause" } else { "play_arrow" };

    let (fg, mut btn) = if metallic {
        let neon = argb_to_hsla_local(neon_argb);
        let top = gpui_kit::rgb(0xffffff);
        let mid = mix_hsla(gpui_kit::rgb(0xdce1ea), neon, 0.28 * neon_k);
        let bot = mix_hsla(gpui_kit::rgb(0xb8c0ce), neon, 0.38 * neon_k);
        let glow = mix_hsla(gpui_kit::rgb(0xffffff), neon, 0.75 * neon_k);
        let d = div()
            .id(id)
            .w(px(size_px))
            .h(px(size_px))
            .flex_shrink_0()
            .relative()
            .rounded(px(radius))
            .flex()
            .items_center()
            .justify_center()
            .bg(linear_gradient(
                145.0,
                linear_color_stop(Hsla::from(top), 0.0),
                linear_color_stop(bot, 1.0),
            ))
            .shadow(vec![
                BoxShadow {
                    color: rgba_alpha(glow, 0.32 + 0.38 * neon_k),
                    offset: point(px(0.0), px(10.0)),
                    blur_radius: px(32.0),
                    spread_radius: px(-6.0),
                    inset: false,
                },
                BoxShadow {
                    color: hsla(0.0, 0.0, 1.0, 0.90),
                    offset: point(px(0.0), px(1.0)),
                    blur_radius: px(1.0),
                    spread_radius: px(0.0),
                    inset: true,
                },
            ]);
        let _ = mid;
        (Hsla::from(gpui_kit::rgb(0x0e1014)), d)
    } else {
        let d = div()
            .id(id)
            .w(px(size_px))
            .h(px(size_px))
            .flex_shrink_0()
            .relative()
            .rounded(px(radius))
            .flex()
            .items_center()
            .justify_center()
            .bg(color(ColorRole::PRIMARY));
        (Hsla::from(color(ColorRole::ON_PRIMARY)), d)
    };

    btn = btn.child(ms_icon(icon_name, true, icon_px, fg));

    if loading {
        let ring_col = if metallic {
            neon_accent_hsla(neon_argb, neon_k)
        } else {
            color(ColorRole::PRIMARY).into()
        };
        let phase_rad = spin_phase.to_radians();
        btn = btn.child(
            canvas(
                |_, _, _| (),
                move |bounds, (), window, _| {
                    let cx = f32::from(bounds.center().x);
                    let cy = f32::from(bounds.center().y);
                    let r = f32::from(bounds.size.width).min(f32::from(bounds.size.height)) * 0.5 + 4.0;
                    let mut pb = PathBuilder::stroke(px(3.0));
                    let start = phase_rad;
                    let sweep = std::f32::consts::PI * 0.75;
                    let steps = 16;
                    for i in 0..=steps {
                        let a = start + sweep * (i as f32 / steps as f32);
                        let p = point(px(cx + a.cos() * r), px(cy + a.sin() * r));
                        if i == 0 {
                            pb.move_to(p);
                        } else {
                            pb.line_to(p);
                        }
                    }
                    if let Ok(path) = pb.build() {
                        window.paint_path(path, ring_col);
                    }
                },
            )
            .absolute()
            .inset_0(),
        );
    }

    if disabled {
        btn.opacity(0.38)
    } else {
        btn.cursor_pointer()
            .active(move |st| st.rounded(px(size_px * 0.22)))
            .on_click(move |_, w, cx| on_click(w, cx))
    }
}

fn argb_to_hsla_local(argb: u32) -> Hsla {
    crate::ui::argb_to_hsla(argb)
}

// ---------------------------------------------------------------------------
// Connected Segmented Button Group (.seg / .seg-sm)
// ---------------------------------------------------------------------------

pub struct SegOption<T: Clone + PartialEq + 'static> {
    pub value: T,
    pub label: Option<SharedString>,
    pub icon: Option<&'static str>,
    pub image_asset: Option<&'static str>,
    pub flex_fill: bool,
}

impl<T: Clone + PartialEq + 'static> SegOption<T> {
    pub fn text(value: T, label: impl Into<SharedString>) -> Self {
        Self {
            value,
            label: Some(label.into()),
            icon: None,
            image_asset: None,
            flex_fill: true,
        }
    }

    pub fn icon_text(value: T, icon: &'static str, label: impl Into<SharedString>) -> Self {
        Self {
            value,
            label: Some(label.into()),
            icon: Some(icon),
            image_asset: None,
            flex_fill: true,
        }
    }

    pub fn compact_asset(value: T, asset: &'static str) -> Self {
        Self {
            value,
            label: None,
            icon: None,
            image_asset: Some(asset),
            flex_fill: false,
        }
    }
}

/// M3 Expressive connected segmented control matching `.seg` and `.seg-sm`.
pub fn m3_segmented<T: Clone + PartialEq + 'static>(
    id_prefix: &'static str,
    current: T,
    options: Vec<SegOption<T>>,
    small: bool,
    on_change: impl Fn(T, &mut App) + Clone + 'static,
) -> Div {
    let h = if small { 36.0 } else { 44.0 };
    let font_px = if small { 13.0 } else { 14.0 };
    let pad_x = if small { 12.0 } else { 16.0 };
    let total = options.len();

    let mut row = div().flex().flex_wrap().items_center().gap(px(3.0));
    for (idx, opt) in options.into_iter().enumerate() {
        let selected = opt.value == current;
        let is_first = idx == 0;
        let is_last = idx + 1 == total;
        let val = opt.value;
        let cb = on_change.clone();

        let (bg, fg) = if selected {
            (
                Hsla::from(color(ColorRole::PRIMARY)),
                Hsla::from(color(ColorRole::ON_PRIMARY)),
            )
        } else {
            (
                role_alpha(ColorRole::ON_SURFACE, 0.08),
                Hsla::from(color(ColorRole::ON_SURFACE_VARIANT)),
            )
        };

        let left_r = if selected || is_first { h * 0.5 } else { 10.0 };
        let right_r = if selected || is_last { h * 0.5 } else { 10.0 };

        let mut btn = div()
            .id(SharedString::from(format!("{id_prefix}-{idx}")))
            .h(px(h))
            .px(px(if !opt.flex_fill && opt.label.is_none() {
                11.0
            } else {
                pad_x
            }))
            .rounded_tl(px(left_r))
            .rounded_bl(px(left_r))
            .rounded_tr(px(right_r))
            .rounded_br(px(right_r))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .bg(bg)
            .text_size(px(font_px))
            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
            .text_color(fg)
            .whitespace_nowrap()
            .cursor_pointer()
            .when(opt.flex_fill, |d| d.flex_1())
            .when(!opt.flex_fill, |d| d.min_w(px(38.0)).flex_shrink_0())
            .when(!selected, |d| {
                d.hover(|s| s.bg(role_alpha(ColorRole::ON_SURFACE, 0.13)).text_color(color(ColorRole::ON_SURFACE)))
            })
            .on_click(move |_, _, cx| cb(val.clone(), cx));

        if let Some(ic) = opt.icon {
            btn = btn.child(ms_icon(ic, selected, 20.0, fg));
        }
        if let Some(asset) = opt.image_asset {
            btn = btn.child(
                img(asset)
                    .w(px(16.0))
                    .h(px(16.0))
                    .rounded(px(3.0)),
            );
        }
        if let Some(lbl) = opt.label {
            btn = btn.child(lbl);
        }
        row = row.child(btn);
    }
    row
}

// ---------------------------------------------------------------------------
// Custom M3 Expressive Capsule Slider (.slider / .slider-sm)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct M3SliderStyle {
    pub small: bool,
    pub disabled: bool,
    pub metallic: bool,
    pub neon_argb: u32,
    pub neon_k: f32,
}

impl M3SliderStyle {
    pub fn from_store(s: &AppStore, small: bool) -> Self {
        let neon_k = if s.appearance.metallic_neon {
            (s.appearance.metallic_neon_intensity / 100.0).clamp(0.0, 1.0)
        } else {
            0.0
        };
        Self {
            small,
            disabled: false,
            metallic: s.appearance.metallic,
            neon_argb: s.resolved_theme.neon_argb,
            neon_k,
        }
    }
}

/// Interactive Material 3 Expressive segmented capsule slider (with root drag continuation).
pub fn m3_slider(
    id: impl Into<ElementId>,
    value_01: f32,
    step: Option<f32>,
    style: M3SliderStyle,
    on_change: impl Fn(f32, &mut App) + 'static,
) -> Stateful<Div> {
    let f = value_01.clamp(0.0, 1.0);
    let (h, hh, gap) = if style.small {
        (10.0, 28.0, 5.0)
    } else {
        (16.0, 40.0, 6.0)
    };

    let active_col: Hsla = if style.metallic {
        mix_hsla(
            gpui_kit::rgb(0xf5f7fa),
            argb_to_hsla_local(style.neon_argb),
            0.48 * style.neon_k,
        )
    } else {
        color(ColorRole::PRIMARY).into()
    };
    let inactive_col: Hsla = color(ColorRole::SECONDARY_CONTAINER).into();

    let cb: SliderChangeFn = Rc::new(on_change);
    let last_bounds = Rc::new(Cell::new(Bounds::<Pixels>::default()));
    let lb_paint = last_bounds.clone();
    let lb_down = last_bounds;

    let mut d = div()
        .id(id)
        .w_full()
        .h(px(hh))
        .relative()
        .child(
            canvas(
                move |bounds, _, _| lb_paint.set(bounds),
                move |bounds, (), window, _| {
                    let w = f32::from(bounds.size.width);
                    let total_h = f32::from(bounds.size.height);
                    if w <= 2.0 || total_h <= 2.0 {
                        return;
                    }
                    let left = f32::from(bounds.left());
                    let top = f32::from(bounds.top()) + (total_h - h) * 0.5;
                    let thumb_x = left + w * f;

                    let active_w = (w * f - gap).max(0.0);
                    if active_w > 0.5 {
                        let a_bounds = Bounds::new(point(px(left), px(top)), size(px(active_w), px(h)));
                        if style.metallic {
                            window.paint_drop_shadows(
                                a_bounds,
                                Corners::all(px(h * 0.5)),
                                &[BoxShadow {
                                    color: rgba_alpha(active_col, 0.36 + 0.34 * style.neon_k),
                                    offset: point(px(0.0), px(0.0)),
                                    blur_radius: px(14.0),
                                    spread_radius: px(0.0),
                                    inset: false,
                                }],
                            );
                        }
                        window.paint_quad(fill(a_bounds, active_col).corner_radii(Corners {
                            top_left: px(h * 0.5),
                            bottom_left: px(h * 0.5),
                            top_right: px(3.0),
                            bottom_right: px(3.0),
                        }));
                    }

                    let inactive_w = (w * (1.0 - f) - gap).max(0.0);
                    if inactive_w > 0.5 {
                        let i_left = left + w - inactive_w;
                        let i_bounds =
                            Bounds::new(point(px(i_left), px(top)), size(px(inactive_w), px(h)));
                        window.paint_quad(fill(i_bounds, inactive_col).corner_radii(Corners {
                            top_left: px(3.0),
                            bottom_left: px(3.0),
                            top_right: px(h * 0.5),
                            bottom_right: px(h * 0.5),
                        }));
                    }

                    // Handle bar (slider-h)
                    let handle_w = 4.0;
                    let handle_top = f32::from(bounds.top()) + (total_h - hh) * 0.5;
                    let h_bounds = Bounds::new(
                        point(px((thumb_x - handle_w * 0.5).clamp(left, left + w - handle_w)), px(handle_top)),
                        size(px(handle_w), px(hh)),
                    );
                    window.paint_quad(
                        fill(h_bounds, active_col).corner_radii(Corners::all(px(3.0))),
                    );
                },
            )
            .size_full(),
        );

    if style.disabled {
        d = d.opacity(0.38);
    } else {
        d = d
            .cursor_pointer()
            .on_mouse_down(MouseButton::Left, move |ev, _, cx| {
                let bounds = lb_down.get();
                if f32::from(bounds.size.width) <= 1.0 {
                    return;
                }
                let next = calc_slider_fraction(ev.position, bounds, step);
                ACTIVE_SLIDER_DRAG.with(|slot| {
                    *slot.borrow_mut() = Some(ActiveSliderDrag {
                        bounds,
                        step,
                        on_change: cb.clone(),
                    });
                });
                cb(next, cx);
            });
    }
    d
}

// ---------------------------------------------------------------------------
// Filter Chip (.chip), Card (.card), Keycap (.kbd), Header, Morphing Logo
// ---------------------------------------------------------------------------

/// M3 filter chip matching `.chip` (`height: 38px`, `border-radius: 12px`).
pub fn m3_chip(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    icon: Option<&'static str>,
    selected: bool,
    on_click: impl Fn(&mut gpui_kit::Window, &mut App) + 'static,
) -> Stateful<Div> {
    let (bg, fg, icon_col) = if selected {
        (
            Hsla::from(color(ColorRole::SECONDARY_CONTAINER)),
            Hsla::from(color(ColorRole::ON_SECONDARY_CONTAINER)),
            Hsla::from(color(ColorRole::ON_SECONDARY_CONTAINER)),
        )
    } else {
        (
            gpui_kit::transparent_black(),
            Hsla::from(color(ColorRole::ON_SURFACE)),
            Hsla::from(color(ColorRole::PRIMARY)),
        )
    };

    let mut d = div()
        .id(id)
        .h(px(38.0))
        .pl(px(if icon.is_some() { 12.0 } else { 16.0 }))
        .pr(px(16.0))
        .rounded(px(12.0))
        .flex_shrink_0()
        .flex()
        .items_center()
        .gap(px(8.0))
        .bg(bg)
        .text_size(px(14.0))
        .font_weight(gpui_kit::FontWeight::MEDIUM)
        .text_color(fg)
        .cursor_pointer()
        .when(!selected, |c| c.border_1().border_color(color(ColorRole::OUTLINE_VARIANT)))
        .hover(move |c| {
            c.bg(if selected {
                mix_hsla(bg, color(ColorRole::ON_SECONDARY_CONTAINER), 0.08)
            } else {
                role_alpha(ColorRole::ON_SURFACE, 0.08)
            })
        })
        .active(|c| c.rounded(px(19.0)))
        .on_click(move |_, w, cx| on_click(w, cx));

    if let Some(ic) = icon {
        d = d.child(ms_icon(ic, selected, 18.0, icon_col));
    }
    d.child(label.into())
}

/// Keycap badge matching `.kbd` in `src/index.css:713`.
pub fn kbd_cap(text: impl Into<SharedString>) -> Div {
    div()
        .min_w(px(30.0))
        .h(px(28.0))
        .px(px(8.0))
        .rounded(px(8.0))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(role_alpha(ColorRole::ON_SURFACE, 0.10))
        .shadow(vec![BoxShadow {
            color: role_alpha(ColorRole::ON_SURFACE, 0.14),
            offset: point(px(0.0), px(-2.0)),
            blur_radius: px(0.0),
            spread_radius: px(0.0),
            inset: true,
        }])
        .text_size(px(12.0))
        .font_weight(gpui_kit::FontWeight::BOLD)
        .text_color(color(ColorRole::ON_SURFACE))
        .child(text.into())
}

/// M3 borderless translucent card matching `.card` (`border-radius: 28px`, `padding: 20px`).
pub fn m3_card(appearance: &Appearance, dark: bool) -> Div {
    glass_panel(appearance, dark, SurfaceKind::Card, 28.0).p(px(20.0))
}

/// Standard `.card` header with 40x40 rounded-14 secondary_container icon badge + title + optional subtitle.
pub fn section_card_header(
    icon: &'static str,
    title: impl Into<SharedString>,
    subtitle: Option<SharedString>,
) -> Div {
    let mut col = div().flex_1().min_w(px(0.0)).child(
        div()
            .text_size(px(18.0))
            .line_height(px(22.0))
            .font_weight(gpui_kit::FontWeight::BOLD)
            .text_color(color(ColorRole::ON_SURFACE))
            .child(title.into()),
    );
    if let Some(sub) = subtitle {
        col = col.child(
            div()
                .mt(px(2.0))
                .text_size(px(14.0))
                .text_color(color(ColorRole::ON_SURFACE_VARIANT))
                .child(sub),
        );
    }

    div()
        .mb(px(16.0))
        .flex()
        .items_center()
        .gap(px(12.0))
        .child(
            div()
                .w(px(40.0))
                .h(px(40.0))
                .flex_shrink_0()
                .rounded(px(14.0))
                .bg(color(ColorRole::SECONDARY_CONTAINER))
                .flex()
                .items_center()
                .justify_center()
                .child(ms_icon(icon, true, 22.0, color(ColorRole::ON_SECONDARY_CONTAINER))),
        )
        .child(col)
}

/// Top-level Display H1 header matching `Settings.tsx` (`clamp(32..54px)` ExtraBold + subtitle).
pub fn display_page_header(
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
) -> Div {
    div()
        .mb(px(24.0))
        .mt(px(8.0))
        .flex()
        .flex_col()
        .child(
            div()
                .text_size(px(44.0))
                .line_height(px(46.0))
                .font_weight(gpui_kit::FontWeight::EXTRA_BOLD)
                .text_color(color(ColorRole::ON_SURFACE))
                .child(title.into()),
        )
        .child(
            div()
                .mt(px(8.0))
                .text_size(px(17.0))
                .text_color(color(ColorRole::ON_SURFACE_VARIANT))
                .child(subtitle.into()),
        )
}

/// Settings subpage header matching `AudioSettings.tsx` / `Appearance.tsx` / `Shortcuts.tsx` / `Providers.tsx`.
pub fn subpage_header(
    back_label: impl Into<SharedString>,
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    on_back: impl Fn(&mut gpui_kit::Window, &mut App) + 'static,
) -> Div {
    div()
        .mb(px(24.0))
        .mt(px(8.0))
        .flex()
        .flex_col()
        .child(
            div()
                .mb(px(12.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(m3_icon_button(
                    "subpage-back-btn",
                    "arrow_back",
                    false,
                    M3IconBtnVariant::Tonal,
                    M3IconBtnSize::Sm,
                    false,
                    false,
                    false,
                    on_back,
                ))
                .child(
                    div()
                        .text_size(px(14.0))
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .text_color(color(ColorRole::ON_SURFACE_VARIANT))
                        .child(back_label.into()),
                ),
        )
        .child(
            div()
                .text_size(px(44.0))
                .line_height(px(46.0))
                .font_weight(gpui_kit::FontWeight::EXTRA_BOLD)
                .text_color(color(ColorRole::ON_SURFACE))
                .child(title.into()),
        )
        .child(
            div()
                .mt(px(8.0))
                .text_size(px(17.0))
                .text_color(color(ColorRole::ON_SURFACE_VARIANT))
                .child(subtitle.into()),
        )
}

/// Resonance morphing M3 Expressive blob mark with tinted `rs-mark.png` emblem (`Sidebar.tsx::Logo`).
pub fn m3_logo(
    id: impl Into<ElementId>,
    size_px: f32,
    spin_deg: f32,
    palette_style: bool,
) -> Div {
    const LOGO_KINDS: [ShapeKind; 6] = [
        ShapeKind::Cookie12Sided,
        ShapeKind::Cookie9Sided,
        ShapeKind::Cookie7Sided,
        ShapeKind::Flower,
        ShapeKind::SoftBurst,
        ShapeKind::Cookie6Sided,
    ];
    let pos = (spin_deg.max(0.0) / 60.0) % (LOGO_KINDS.len() as f32);
    let idx = (pos.floor() as usize) % LOGO_KINDS.len();
    let next = (idx + 1) % LOGO_KINDS.len();
    let frac = pos.fract();
    let (container_role, mark_role) = if palette_style {
        (ColorRole::SECONDARY_CONTAINER, ColorRole::ON_SECONDARY_CONTAINER)
    } else {
        (ColorRole::PRIMARY, ColorRole::ON_PRIMARY)
    };
    let mark_w = (size_px * (19.0 / 40.0)).round();
    let mark_h = (size_px * (13.0 / 40.0)).round();

    let mut box_div = div()
        .w(px(size_px))
        .h(px(size_px))
        .min_w(px(size_px))
        .min_h(px(size_px))
        .flex_shrink_0()
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .child(
            MaterialShape::new(id, LOGO_KINDS[idx])
                .frame(ShapeFrame::morph(LOGO_KINDS[idx], LOGO_KINDS[next], frac))
                .size(size_px)
                .rotation(spin_deg)
                .color(container_role),
        );

    if let Some(mark_img) = tinted_rs_mark(color(mark_role)) {
        box_div = box_div.child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    img(ImageSource::Image(mark_img))
                        .w(px(mark_w))
                        .h(px(mark_h))
                        .object_fit(ObjectFit::Contain),
                ),
        );
    }

    box_div
}
