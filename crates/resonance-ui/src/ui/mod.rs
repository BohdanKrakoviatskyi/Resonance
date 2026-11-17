pub mod background;
pub mod controls;
pub mod eq_panel;
pub mod immersive;
pub mod import_review;
pub mod lyrics;
pub mod mini_player;
pub mod now_playing;
pub mod overlays;
pub mod seek;
pub mod sidebar;
pub mod splash;
pub mod track_list;

use gpui_kit::{
    AnyElement, Hsla, IntoElement, ParentElement, Rgba, Styled, StyledImage, canvas, div, img,
    linear_color_stop, linear_gradient, point, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::theme::color;
use resonance_core::color_engine::{argb_from_hex, fallback_color};
use resonance_core::models::{Appearance, GlassMode, Source, Track};

pub fn argb_to_hsla(argb: u32) -> Hsla {
    Rgba {
        r: ((argb >> 16) & 0xff) as f32 / 255.0,
        g: ((argb >> 8) & 0xff) as f32 / 255.0,
        b: (argb & 0xff) as f32 / 255.0,
        a: ((argb >> 24) & 0xff) as f32 / 255.0,
    }
    .into()
}

/// Which panel/surface role in the CSS M3 Expressive hierarchy a container belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceKind {
    /// Sidebar & NowPlaying right panel (`--md-surface-container-low`).
    SidePanel,
    /// Main center stage container (`--md-surface-container-lowest`).
    CenterPanel,
    /// Floating MiniPlayer inside center panel (`--md-surface-container-high` + 26% opacity boost + heavy drop shadow).
    MiniPanel,
    /// Borderless translucent content card (`58%` `--md-surface-container-high` or solid `--md-surface-container` when glass off).
    Card,
}

/// Linearly interpolate two HSLA colors in RGBA space for authentic `color-mix` results.
pub fn mix_hsla(a: impl Into<Hsla>, b: impl Into<Hsla>, t: f32) -> Hsla {
    let t = t.clamp(0.0, 1.0);
    let ra: Rgba = a.into().into();
    let rb: Rgba = b.into().into();
    Rgba {
        r: ra.r + (rb.r - ra.r) * t,
        g: ra.g + (rb.g - ra.g) * t,
        b: ra.b + (rb.b - ra.b) * t,
        a: ra.a + (rb.a - ra.a) * t,
    }
    .into()
}

pub fn rgba_alpha(c: impl Into<Hsla>, alpha: f32) -> Hsla {
    let mut h: Hsla = c.into();
    h.a = (h.a * alpha).clamp(0.0, 1.0);
    h
}

pub fn role_alpha(role: ColorRole, alpha: f32) -> Hsla {
    rgba_alpha(color(role), alpha)
}

/// Builds a panel/card container matching `.panel` / `.mini` / `.card` rules from `src/index.css`.
pub fn glass_panel_with_neon(
    appearance: &Appearance,
    dark: bool,
    kind: SurfaceKind,
    radius_px: f32,
    neon_argb: u32,
) -> gpui_kit::Div {
    let mut d = div().rounded(px(radius_px));

    if kind == SurfaceKind::Card {
        let fill = match appearance.glass {
            GlassMode::Off => role_alpha(ColorRole::SURFACE_CONTAINER, 1.0),
            GlassMode::Frosted | GlassMode::Liquid => role_alpha(ColorRole::SURFACE_CONTAINER_HIGH, 0.58),
        };
        return d.bg(fill);
    }

    let base_role = match kind {
        SurfaceKind::SidePanel => ColorRole::SURFACE_CONTAINER_LOW,
        SurfaceKind::CenterPanel => ColorRole::SURFACE_CONTAINER_LOWEST,
        SurfaceKind::MiniPanel => ColorRole::SURFACE_CONTAINER_HIGH,
        SurfaceKind::Card => ColorRole::SURFACE_CONTAINER_HIGH,
    };
    let boost = if kind == SurfaceKind::MiniPanel { 0.26 } else { 0.0 };
    let opacity_frac = (appearance.opacity / 100.0).clamp(0.0, 1.0);

    let alpha = match appearance.glass {
        GlassMode::Off => 1.0,
        GlassMode::Frosted => (opacity_frac + 0.24 + boost).clamp(0.28, 0.96),
        GlassMode::Liquid => (opacity_frac * 0.80 + boost).clamp(0.18, 0.92),
    };
    d = d.bg(role_alpha(base_role, alpha));

    let mut shadows: Vec<gpui_kit::BoxShadow> = Vec::new();
    match (kind, appearance.glass) {
        (SurfaceKind::MiniPanel, _) => {
            shadows.push(gpui_kit::BoxShadow {
                color: gpui_kit::hsla(0.0, 0.0, 0.0, if dark { 0.55 } else { 0.26 }),
                offset: gpui_kit::point(px(0.0), px(16.0)),
                blur_radius: px(40.0),
                spread_radius: px(-16.0),
                inset: false,
            });
        }
        (_, GlassMode::Frosted | GlassMode::Liquid) => {
            shadows.push(gpui_kit::BoxShadow {
                color: gpui_kit::hsla(0.0, 0.0, 0.0, if dark { 0.40 } else { 0.22 }),
                offset: gpui_kit::point(px(0.0), px(14.0)),
                blur_radius: px(44.0),
                spread_radius: px(-16.0),
                inset: false,
            });
        }
        (_, GlassMode::Off) => {}
    }

    match appearance.glass {
        GlassMode::Off => {}
        GlassMode::Frosted => {
            let edge_a = if dark { 0.08 } else { 0.22 };
            d = d.border_1().border_color(gpui_kit::hsla(0.0, 0.0, 1.0, edge_a));
            shadows.push(gpui_kit::BoxShadow {
                color: gpui_kit::hsla(0.0, 0.0, 1.0, if dark { 0.10 } else { 0.28 }),
                offset: gpui_kit::point(px(0.0), px(1.0)),
                blur_radius: px(1.0),
                spread_radius: px(0.0),
                inset: true,
            });
        }
        GlassMode::Liquid => {
            let k = (appearance.refraction / 100.0).clamp(0.0, 1.0);
            d = d
                .border_1()
                .border_color(gpui_kit::hsla(0.0, 0.0, 1.0, if dark { 0.16 } else { 0.34 }));
            shadows.push(gpui_kit::BoxShadow {
                color: gpui_kit::hsla(0.0, 0.0, 1.0, 0.26 + 0.18 * k),
                offset: gpui_kit::point(px(1.0), px(1.0)),
                blur_radius: px(2.0),
                spread_radius: px(-0.5),
                inset: true,
            });
            shadows.push(gpui_kit::BoxShadow {
                color: gpui_kit::hsla(0.0, 0.0, 1.0, 0.16),
                offset: gpui_kit::point(px(-1.0), px(-1.0)),
                blur_radius: px(2.0),
                spread_radius: px(-0.5),
                inset: true,
            });
            shadows.push(gpui_kit::BoxShadow {
                color: gpui_kit::hsla(0.0, 0.0, 1.0, 0.08),
                offset: gpui_kit::point(px(0.0), px(0.0)),
                blur_radius: px(22.0),
                spread_radius: px(0.0),
                inset: true,
            });
        }
    }

    if appearance.metallic {
        let neon_k = if appearance.metallic_neon {
            (appearance.metallic_neon_intensity / 100.0).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let neon_col = argb_to_hsla(neon_argb);
        let white = gpui_kit::hsla(0.0, 0.0, 1.0, 1.0);
        let rim = mix_hsla(white, neon_col, 0.52 * neon_k);
        shadows.push(gpui_kit::BoxShadow {
            color: rgba_alpha(rim, 0.42),
            offset: gpui_kit::point(px(1.5), px(1.5)),
            blur_radius: px(1.0),
            spread_radius: px(-0.5),
            inset: true,
        });
        shadows.push(gpui_kit::BoxShadow {
            color: rgba_alpha(rim, 0.16),
            offset: gpui_kit::point(px(0.0), px(0.0)),
            blur_radius: px(28.0),
            spread_radius: px(0.0),
            inset: true,
        });
        d = d
            .border_1()
            .border_color(rgba_alpha(rim, 0.14 + 0.18 * neon_k));
    }

    if !shadows.is_empty() {
        d = d.shadow(shadows);
    }
    d
}

pub fn glass_panel(
    appearance: &Appearance,
    dark: bool,
    kind: SurfaceKind,
    radius_px: f32,
) -> gpui_kit::Div {
    glass_panel_with_neon(appearance, dark, kind, radius_px, 0xff8c_7cff)
}

pub fn neon_accent_hsla(neon_argb: u32, neon_k: f32) -> Hsla {
    let mut h = argb_to_hsla(neon_argb);
    h.a = (0.35 + neon_k * 0.55).clamp(0.0, 1.0);
    h
}

pub fn cover_art_box(
    cover_url: Option<&str>,
    fallback_id: &str,
    size_px: f32,
    radius_px: f32,
) -> gpui_kit::Div {
    let c1 = argb_to_hsla(fallback_color(fallback_id));
    let c2 = argb_to_hsla(fallback_color(&format!("{fallback_id}-b")));
    let mut box_div = div()
        .w(px(size_px))
        .h(px(size_px))
        .min_w(px(size_px))
        .min_h(px(size_px))
        .rounded(px(radius_px))
        .overflow_hidden()
        .flex_shrink_0()
        .bg(linear_gradient(
            135.0,
            linear_color_stop(c1, 0.0),
            linear_color_stop(c2, 1.0),
        ))
        .flex()
        .items_center()
        .justify_center();

    if let Some(url) = cover_url.filter(|u| !u.is_empty()) {
        box_div = box_div.child(
            img(url.to_string())
                .w(px(size_px))
                .h(px(size_px))
                .object_fit(gpui_kit::ObjectFit::Cover),
        );
    } else {
        let icon_s = (size_px * 0.42).clamp(14.0, 48.0);
        box_div = box_div.child(crate::assets::ms_icon(
            "music_note",
            true,
            icon_s,
            rgba_alpha(gpui_kit::rgb(0xffffff), 0.55),
        ));
    }
    box_div
}

/// Favorites gradient artwork matching `.fav-cover` (`linear-gradient(140deg, primary, tertiary)`).
pub fn fav_cover_box(size_px: f32, radius_px: f32) -> gpui_kit::Div {
    div()
        .w(px(size_px))
        .h(px(size_px))
        .min_w(px(size_px))
        .min_h(px(size_px))
        .rounded(px(radius_px))
        .overflow_hidden()
        .flex_shrink_0()
        .bg(linear_gradient(
            140.0,
            linear_color_stop(Hsla::from(color(ColorRole::PRIMARY)), 0.0),
            linear_color_stop(Hsla::from(color(ColorRole::TERTIARY)), 1.0),
        ))
        .flex()
        .items_center()
        .justify_center()
        .child(crate::assets::ms_icon(
            "favorite",
            true,
            (size_px * 0.44).max(16.0),
            color(ColorRole::ON_PRIMARY),
        ))
}

/// 2x2 playlist mosaic artwork when no explicit playlist cover exists, matching `.mosaic`.
pub fn mosaic_cover_box(
    tile_urls: &[Option<&str>],
    fallback_id: &str,
    size_px: f32,
    radius_px: f32,
) -> gpui_kit::Div {
    let valid: Vec<&str> = tile_urls
        .iter()
        .flatten()
        .copied()
        .filter(|u| !u.is_empty())
        .take(4)
        .collect();
    if valid.len() < 4 {
        return cover_art_box(valid.first().copied(), fallback_id, size_px, radius_px);
    }
    let half = size_px * 0.5;
    let tile = |url: &str| {
        img(url.to_string())
            .w(px(half))
            .h(px(half))
            .object_fit(gpui_kit::ObjectFit::Cover)
    };
    div()
        .w(px(size_px))
        .h(px(size_px))
        .min_w(px(size_px))
        .min_h(px(size_px))
        .rounded(px(radius_px))
        .overflow_hidden()
        .flex_shrink_0()
        .flex()
        .flex_col()
        .child(div().flex().child(tile(valid[0])).child(tile(valid[1])))
        .child(div().flex().child(tile(valid[2])).child(tile(valid[3])))
}

/// Crisp inline streaming source mark (`16px` / `size_px` `.provider-logo`, no grey circle wrapper).
pub fn provider_badge(source: Source, size_px: f32) -> AnyElement {
    let path = match source {
        Source::SoundCloud => "assets/soundcloud.svg",
        Source::YouTube => "assets/youtube-music.svg",
    };
    gpui_kit::img(path)
        .w(px(size_px))
        .h(px(size_px))
        .rounded(px((size_px * 0.2).max(2.0)))
        .flex_shrink_0()
        .into_any_element()
}

pub fn eq_playing_bars(phase: f32, bar_color: Hsla) -> AnyElement {
    canvas(
        |_, _, _| (),
        move |bounds, (), window, _| {
            let h = bounds.size.height;
            let bar_w = px(3.0);
            let gap = px(2.0);
            for i in 0..3 {
                let f = 0.28 + 0.68 * (0.5 + 0.5 * (phase * (2.5 + i as f32 * 0.9) + i as f32 * 1.7).sin());
                let bh = h * f;
                let x = bounds.left() + (bar_w + gap) * (i as f32);
                let y = bounds.bottom() - bh;
                window.paint_quad(
                    gpui_kit::fill(
                        gpui_kit::Bounds::new(point(x, y), gpui_kit::size(bar_w, bh)),
                        bar_color,
                    )
                    .corner_radii(gpui_kit::Corners::all(px(1.5))),
                );
            }
        },
    )
    .w(px(13.0))
    .h(px(16.0))
    .flex_shrink_0()
    .into_any_element()
}

pub fn track_primary_cover(t: &Track) -> Option<&str> {
    t.thumb.as_deref().or(t.cover.as_deref())
}

pub fn preset_accent_swatches() -> &'static [&'static str] {
    &[
        "#a0a8b8", "#8c7cff", "#ff6b6b", "#ff9f43",
        "#feca57", "#1dd1a1", "#48dbfb", "#ff9ff3",
    ]
}

pub fn preset_bg_swatches(dark: bool) -> &'static [&'static str] {
    if dark {
        &["#000000", "#0b0d12", "#14111c", "#0f1715", "#191112", "#12151e"]
    } else {
        &["#f6f7fb", "#eef1f8", "#f7f1f5", "#eff6f3", "#faf3ec", "#ffffff"]
    }
}

pub fn normalize_hex_input(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('#');
    if (trimmed.len() == 6 || trimmed.len() == 3) && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        let argb = argb_from_hex(trimmed);
        Some(resonance_core::color_engine::hex_from_argb(argb))
    } else {
        None
    }
}
