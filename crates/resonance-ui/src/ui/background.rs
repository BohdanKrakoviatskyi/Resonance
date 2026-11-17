use std::path::PathBuf;

use gpui_kit::{
    Bounds, BoxShadow, Corners, Hsla, IntoElement, ObjectFit, ParentElement, Styled, StyledImage,
    canvas, div, fill, hsla, img, linear_color_stop, linear_gradient, point, px, size,
};
use resonance_core::color_engine::BgSpec;
use resonance_core::models::Appearance;

use super::{argb_to_hsla, rgba_alpha};

fn blob_color(argb: u32, metallic: bool, alpha: f32) -> Hsla {
    let mut c = argb_to_hsla(argb);
    if metallic {
        c.s = (c.s * 0.22).clamp(0.0, 1.0);
        c.l = (c.l * 0.85).clamp(0.0, 1.0);
    } else {
        c.s = (c.s * 1.18).clamp(0.0, 1.0);
    }
    c.a = alpha.clamp(0.0, 1.0);
    c
}

/// Full-window layered background matching `src/components/Background.tsx` & `src/index.css`.
pub fn render_background(
    spec: &BgSpec,
    appearance: &Appearance,
    neon_argb: u32,
    neon_k: f32,
    phase: f32,
) -> impl IntoElement {
    let metallic = appearance.metallic;

    match spec {
        BgSpec::Mesh { base, colors, .. } => {
            let base_col = argb_to_hsla(*base);
            let colors = *colors;
            let blob_alpha = if metallic { 0.48 } else { 0.72 };
            let neon_col = argb_to_hsla(neon_argb);

            div()
                .absolute()
                .inset_0()
                .overflow_hidden()
                .bg(base_col)
                .child(
                    canvas(
                        |_, _, _| (),
                        move |bounds, (), window, _| {
                            let w = f32::from(bounds.size.width).max(1.0);
                            let h = f32::from(bounds.size.height).max(1.0);
                            let max_dim = w.max(h);
                            let ox = f32::from(bounds.left());
                            let oy = f32::from(bounds.top());

                            // 4 slowly drifting Gaussian-blurred mesh blobs (mirrors .bg-blob-1..4)
                            let specs: [(f32, f32, f32, f32, f32, f32); 4] = [
                                (-0.08, -0.10, 0.68, 0.68, 1.00, 0.00),
                                (0.48, -0.06, 0.62, 0.62, 0.81, 1.85),
                                (0.40, 0.44, 0.66, 0.66, 0.88, 3.70),
                                (-0.06, 0.46, 0.58, 0.58, 0.73, 5.10),
                            ];

                            for (i, (bx, by, bw, bh, speed, seed)) in specs.iter().enumerate() {
                                let col = blob_color(colors[i], metallic, blob_alpha);
                                if col.a <= 0.01 {
                                    continue;
                                }
                                let t = phase * speed + seed;
                                let dx = t.sin() * 0.09 * w;
                                let dy = (t * 0.77 + 1.1).cos() * 0.09 * h;
                                let scale = 1.0 + 0.08 * (t * 0.63).sin();

                                let rw = w * bw * scale;
                                let rh = h * bh * scale;
                                let left = ox + w * bx + dx;
                                let top = oy + h * by + dy;
                                let b = Bounds::new(point(px(left), px(top)), size(px(rw), px(rh)));
                                let r = rw.min(rh) * 0.5;
                                let blur = rw.max(rh) * 0.34;

                                window.paint_drop_shadows(
                                    b,
                                    Corners::all(px(r)),
                                    &[BoxShadow {
                                        color: col,
                                        offset: point(px(0.0), px(0.0)),
                                        blur_radius: px(blur),
                                        spread_radius: px(0.0),
                                        inset: false,
                                    }],
                                );
                            }

                            // Metallic + neon studio overlay (.bg-metal-fx)
                            if metallic {
                                window.paint_quad(fill(
                                    bounds,
                                    linear_gradient(
                                        155.0,
                                        linear_color_stop(hsla(0.62, 0.14, 0.16, 0.36), 0.0),
                                        linear_color_stop(hsla(0.62, 0.12, 0.04, 0.72), 1.0),
                                    ),
                                ));

                                if neon_k > 0.01 {
                                    let na = (neon_k * 0.38).clamp(0.0, 0.45);
                                    let glow_col = rgba_alpha(neon_col, na);
                                    let g1 = Bounds::new(
                                        point(px(ox - w * 0.12), px(oy - h * 0.14)),
                                        size(px(w * 0.62), px(h * 0.62)),
                                    );
                                    let g2 = Bounds::new(
                                        point(px(ox + w * 0.46), px(oy + h * 0.48)),
                                        size(px(w * 0.58), px(h * 0.58)),
                                    );
                                    window.paint_drop_shadows(
                                        g1,
                                        Corners::all(px(w * 0.31)),
                                        &[BoxShadow {
                                            color: glow_col,
                                            offset: point(px(0.0), px(0.0)),
                                            blur_radius: px(max_dim * 0.24),
                                            spread_radius: px(0.0),
                                            inset: false,
                                        }],
                                    );
                                    window.paint_drop_shadows(
                                        g2,
                                        Corners::all(px(w * 0.29)),
                                        &[BoxShadow {
                                            color: glow_col,
                                            offset: point(px(0.0), px(0.0)),
                                            blur_radius: px(max_dim * 0.24),
                                            spread_radius: px(0.0),
                                            inset: false,
                                        }],
                                    );
                                }
                            }

                            // Soft radial edge vignette (.bg-vignette) via analytical inset shadow
                            window.paint_inset_shadows(
                                bounds,
                                Corners::default(),
                                &[BoxShadow {
                                    color: hsla(0.0, 0.0, 0.0, 0.54),
                                    offset: point(px(0.0), px(0.0)),
                                    blur_radius: px(max_dim * 0.30),
                                    spread_radius: px(-max_dim * 0.03),
                                    inset: true,
                                }],
                            );
                        },
                    )
                    .size_full(),
                )
        }
        BgSpec::Image {
            image_ref,
            is_custom_file,
            base,
            blur,
            dim_alpha,
            dark,
            ..
        } => {
            let base_col = argb_to_hsla(*base);
            let dim_col = if *dark {
                hsla(0.0, 0.0, 0.0, *dim_alpha)
            } else {
                hsla(0.0, 0.0, 1.0, *dim_alpha * 0.85)
            };
            let img_el = if *is_custom_file {
                img(PathBuf::from(image_ref))
                    .w_full()
                    .h_full()
                    .object_fit(ObjectFit::Cover)
            } else {
                img(image_ref.clone())
                    .w_full()
                    .h_full()
                    .object_fit(ObjectFit::Cover)
            };
            let soft_blur_veil = ((*blur / 100.0).clamp(0.0, 1.0)) * 0.28;

            div()
                .absolute()
                .inset_0()
                .overflow_hidden()
                .bg(base_col)
                .child(img_el)
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .bg(rgba_alpha(base_col, soft_blur_veil)),
                )
                .child(div().absolute().inset_0().bg(dim_col))
        }
    }
}
