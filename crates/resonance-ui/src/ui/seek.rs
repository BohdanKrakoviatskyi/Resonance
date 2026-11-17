use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, Bounds, BoxShadow, Corners, Hsla, InteractiveElement, IntoElement, MouseButton,
    ParentElement, PathBuilder, Pixels, Point, Styled, canvas, div, fill, point, px, size,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::models::fmt_time;

use super::{mix_hsla, neon_accent_hsla, rgba_alpha};

#[derive(Clone)]
pub struct WavySeekProps {
    pub id_prefix: String,
    pub position: f64,
    pub duration: f64,
    pub phase: f32,
    pub amp: f32,
    pub metallic_neon: bool,
    pub neon_argb: u32,
    pub neon_intensity: f32,
    pub compact: bool,
}

pub type SeekChangeFn = Rc<dyn Fn(f64, &mut App)>;

struct ActiveSeekDrag {
    bounds: Bounds<Pixels>,
    duration: f64,
    flag: Rc<Cell<bool>>,
    on_seek: SeekChangeFn,
}

thread_local! {
    static ACTIVE_SEEK_DRAG: RefCell<Option<ActiveSeekDrag>> = const { RefCell::new(None) };
}

fn calc_seek_sec(pos: Point<Pixels>, b: Bounds<Pixels>, dur: f64) -> f64 {
    let w = f32::from(b.size.width).max(1.0);
    let rel = (f32::from(pos.x) - f32::from(b.left())) / w;
    (rel.clamp(0.0, 1.0) as f64) * dur
}

/// Forward root mouse move events while scrubbing wavy seek bars smoothly across the window.
pub fn handle_global_seek_mouse_move(pos: Point<Pixels>, left_pressed: bool, cx: &mut App) {
    if !left_pressed {
        end_global_seek_drag();
        return;
    }
    let active = ACTIVE_SEEK_DRAG.with(|slot| {
        let g = slot.borrow();
        g.as_ref().map(|d| (d.bounds, d.duration, d.on_seek.clone()))
    });
    if let Some((bounds, dur, cb)) = active {
        cb(calc_seek_sec(pos, bounds, dur), cx);
    }
}

/// Clear active wavy seek scrubbing on pointer release.
pub fn end_global_seek_drag() {
    ACTIVE_SEEK_DRAG.with(|slot| {
        if let Some(prev) = slot.borrow_mut().take() {
            prev.flag.set(false);
        }
    });
}

/// Interactive Material 3 Expressive wavy squiggly progress bar rendered at 60fps on GPUI Canvas.
pub fn render_wavy_seek(
    props: WavySeekProps,
    drag_active: Rc<Cell<bool>>,
    on_seek: impl Fn(f64, &mut App) + Clone + 'static,
) -> AnyElement {
    let dur = props.duration.max(0.001);
    let frac = (props.position / dur).clamp(0.0, 1.0) as f32;
    let bar_h = if props.compact { 28.0 } else { 36.0 };
    let stroke_w = if props.compact { 4.0 } else { 6.0 };
    let gap = if props.compact { 6.0 } else { 8.0 };

    let active_col: Hsla = if props.metallic_neon {
        mix_hsla(
            gpui_kit::rgb(0xf5f7fa),
            neon_accent_hsla(props.neon_argb, props.neon_intensity),
            0.48 * props.neon_intensity.clamp(0.0, 1.0),
        )
    } else {
        color(ColorRole::PRIMARY).into()
    };
    let track_col: Hsla = color(ColorRole::SECONDARY_CONTAINER).into();
    let label_col = color(ColorRole::ON_SURFACE_VARIANT);

    let last_bounds = Rc::new(Cell::new(Bounds::<Pixels>::default()));
    let lb_paint = last_bounds.clone();
    let lb_down = last_bounds;

    let seek_rc: SeekChangeFn = Rc::new(on_seek);
    let drag_down = drag_active.clone();
    let drag_paint = drag_active;

    let metallic = props.metallic_neon;
    let neon_argb = props.neon_argb;
    let neon_k = props.neon_intensity;
    let compact = props.compact;
    let phase = props.phase;
    let amp = props.amp;

    let track_el = div()
        .id(gpui_kit::SharedString::from(format!("{}-track", props.id_prefix)))
        .flex_1()
        .min_w(px(60.0))
        .h(px(bar_h))
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, move |ev, _, cx| {
            let b = lb_down.get();
            if f32::from(b.size.width) <= 1.0 {
                return;
            }
            drag_down.set(true);
            ACTIVE_SEEK_DRAG.with(|slot| {
                *slot.borrow_mut() = Some(ActiveSeekDrag {
                    bounds: b,
                    duration: dur,
                    flag: drag_down.clone(),
                    on_seek: seek_rc.clone(),
                });
            });
            seek_rc(calc_seek_sec(ev.position, b, dur), cx);
        })
        .on_mouse_up(MouseButton::Left, move |_, _, _| {
            end_global_seek_drag();
        })
        .child(
            canvas(
                move |bounds, _, _| {
                    lb_paint.set(bounds);
                },
                move |bounds, (), window, _| {
                    let w = f32::from(bounds.size.width);
                    let h = f32::from(bounds.size.height);
                    if w <= 2.0 {
                        return;
                    }
                    let mid_y = f32::from(bounds.top()) + h * 0.5;
                    let left_x = f32::from(bounds.left());
                    let right_x = left_x + w;
                    let thumb_x = left_x + w * frac;

                    // Inactive right track (.seek-rest)
                    let rest_start = (thumb_x + gap).min(right_x);
                    if right_x - rest_start > 1.0 {
                        let rest_w = right_x - rest_start;
                        let r_bounds = Bounds::new(
                            point(px(rest_start), px(mid_y - stroke_w * 0.5)),
                            size(px(rest_w), px(stroke_w)),
                        );
                        window.paint_quad(
                            fill(r_bounds, track_col).corner_radii(Corners::all(px(stroke_w * 0.5))),
                        );
                    }

                    // Active wavy M3 path (.seek-wave)
                    let played_end = (thumb_x - gap * 0.5).max(left_x);
                    let played_w = played_end - left_x;
                    if played_w > 1.0 {
                        let steps = ((played_w / 3.0).ceil() as usize).clamp(8, 260);
                        let mut pb = PathBuilder::stroke(px(stroke_w));
                        let k_freq = if compact { 0.16_f32 } else { 0.12_f32 };
                        for i in 0..=steps {
                            let u = i as f32 / steps as f32;
                            let x = left_x + u * played_w;
                            let edge = (1.0 - (u * 2.0 - 1.0).powi(8)).max(0.0);
                            let y = mid_y + amp * edge * ((x - left_x) * k_freq - phase).sin();
                            let pt = point(px(x), px(y));
                            if i == 0 {
                                pb.move_to(pt);
                            } else {
                                pb.line_to(pt);
                            }
                        }
                        if let Ok(path) = pb.build() {
                            window.paint_path(path, active_col);
                        }
                    }

                    // End stop dot (.seek-stop)
                    let stop_r = if compact { 2.0 } else { 3.0 };
                    let stop_bounds = Bounds::new(
                        point(px(right_x - stop_r * 2.0), px(mid_y - stop_r)),
                        size(px(stop_r * 2.0), px(stop_r * 2.0)),
                    );
                    window.paint_quad(
                        fill(stop_bounds, active_col).corner_radii(Corners::all(px(stop_r))),
                    );

                    // Expressive vertical pill thumb (.seek-thumb)
                    let dragging = drag_paint.get();
                    let thumb_w = if compact { 4.0 } else { 6.0 };
                    let thumb_h = match (compact, dragging) {
                        (true, false) => 20.0,
                        (true, true) => 30.0,
                        (false, false) => 28.0,
                        (false, true) => 38.0,
                    };
                    let t_bounds = Bounds::new(
                        point(
                            px((thumb_x - thumb_w * 0.5).clamp(left_x, right_x - thumb_w)),
                            px(mid_y - thumb_h * 0.5),
                        ),
                        size(px(thumb_w), px(thumb_h)),
                    );
                    if metallic {
                        window.paint_drop_shadows(
                            t_bounds,
                            Corners::all(px(3.0)),
                            &[BoxShadow {
                                color: rgba_alpha(neon_accent_hsla(neon_argb, neon_k), 0.72),
                                offset: point(px(0.0), px(0.0)),
                                blur_radius: px(14.0),
                                spread_radius: px(0.0),
                                inset: false,
                            }],
                        );
                    }
                    window.paint_quad(
                        fill(t_bounds, active_col).corner_radii(Corners::all(px(3.0))),
                    );
                },
            )
            .size_full(),
        );

    div()
        .w_full()
        .h(px(28.0))
        .flex()
        .items_center()
        .gap(px(10.0))
        .child(
            div()
                .text_size(px(12.0))
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(label_col)
                .min_w(px(36.0))
                .flex_shrink_0()
                .text_right()
                .child(fmt_time(props.position)),
        )
        .child(track_el)
        .child(
            div()
                .text_size(px(12.0))
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(label_col)
                .min_w(px(36.0))
                .flex_shrink_0()
                .child(fmt_time(props.duration)),
        )
        .into_any_element()
}
