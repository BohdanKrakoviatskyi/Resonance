use std::collections::HashMap;

use gpui_kit_material_color::dynamic::{
    DynamicScheme, Hct, SeedScheme, SpecVersion, TonalPalette, Variant,
};
use gpui_kit_material_color::{Color, ColorRole, Scheme};
use image::imageops::FilterType;

use crate::models::{AccentMode, Appearance, BgMode, BgStyle, ColorVariant};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Palette {
    pub accent: u32,
    pub dominant: u32,
    pub colors: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BgSpec {
    Mesh {
        key: String,
        base: u32,
        colors: [u32; 4],
    },
    Image {
        key: String,
        image_ref: String,
        is_custom_file: bool,
        base: u32,
        blur: f32,
        dim_alpha: f32,
        dark: bool,
    },
}

pub fn argb_from_hex(hex: &str) -> u32 {
    let trimmed = hex.trim().trim_start_matches('#');
    if let Ok(v) = u32::from_str_radix(trimmed, 16) {
        if trimmed.len() == 3 {
            let r = ((v >> 8) & 0xf) * 0x11;
            let g = ((v >> 4) & 0xf) * 0x11;
            let b = (v & 0xf) * 0x11;
            return 0xff00_0000 | (r << 16) | (g << 8) | b;
        }
        if trimmed.len() == 6 {
            return 0xff00_0000 | v;
        }
        if trimmed.len() == 8 {
            return v;
        }
    }
    0xffa0_a8b8
}

pub fn hex_from_argb(argb: u32) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        (argb >> 16) & 0xff,
        (argb >> 8) & 0xff,
        argb & 0xff
    )
}

pub fn color_from_argb(argb: u32) -> Color {
    Color::argb(argb)
}

pub fn hct_argb(hue: f64, chroma: f64, tone: f64) -> u32 {
    let h = hue.rem_euclid(360.0);
    let c = chroma.max(0.0);
    let t = tone.clamp(0.0, 100.0);
    Hct::from_hct(h, c, t).argb()
}

pub fn fnv1a_hash(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in s.encode_utf16() {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

pub fn fallback_color(id: &str) -> u32 {
    let hue = (fnv1a_hash(id) % 360) as f64;
    Hct::from_hct(hue, 44.0, 52.0).argb()
}

pub fn variant_to_m3(v: ColorVariant) -> Variant {
    match v {
        ColorVariant::Tonal => Variant::TonalSpot,
        ColorVariant::Vibrant => Variant::Vibrant,
        ColorVariant::Expressive => Variant::Expressive,
        ColorVariant::Fidelity => Variant::Fidelity,
        ColorVariant::Rainbow => Variant::Rainbow,
        ColorVariant::Fruit => Variant::FruitSalad,
        ColorVariant::Mono => Variant::Monochrome,
        ColorVariant::Neutral => Variant::Neutral,
    }
}

/// Extract dominant, accent, and up to 5 distinct colors from cover art bytes,
/// following Material Color Utilities population + chroma scoring (`src/lib/color.ts`).
pub fn extract_palette_from_image_bytes(bytes: &[u8]) -> Option<Palette> {
    let img = image::load_from_memory(bytes).ok()?;
    let small = img.resize_exact(56, 56, FilterType::Triangle).to_rgba8();

    // 5-bit per channel quantization (32768 buckets) closely mirrors QuantizerCelebi buckets
    let mut buckets: HashMap<u32, (u64, u64, u64, u32)> = HashMap::new();
    for px in small.pixels() {
        if px[3] <= 250 {
            continue;
        }
        let r = px[0] as u64;
        let g = px[1] as u64;
        let b = px[2] as u64;
        let key = (((r >> 3) as u32) << 10) | (((g >> 3) as u32) << 5) | ((b >> 3) as u32);
        let entry = buckets.entry(key).or_insert((0, 0, 0, 0));
        entry.0 += r;
        entry.1 += g;
        entry.2 += b;
        entry.3 += 1;
    }

    if buckets.is_empty() {
        return None;
    }

    let mut entries: Vec<(u32, u32, Hct)> = buckets
        .into_values()
        .map(|(sr, sg, sb, count)| {
            let r = ((sr + (count as u64 / 2)) / count as u64).min(255) as u32;
            let g = ((sg + (count as u64 / 2)) / count as u64).min(255) as u32;
            let b = ((sb + (count as u64 / 2)) / count as u64).min(255) as u32;
            let argb = 0xff00_0000 | (r << 16) | (g << 8) | b;
            (argb, count, Hct::from_argb(argb))
        })
        .collect();

    entries.sort_by_key(|e| std::cmp::Reverse(e.1));
    entries.truncate(48);

    let total_pop: f64 = entries.iter().map(|e| e.1 as f64).sum::<f64>().max(1.0);
    let mut hue_pop = [0.0f64; 360];
    for (_, count, hct) in &entries {
        let hue_idx = (hct.hue().round() as usize) % 360;
        hue_pop[hue_idx] += *count as f64 / total_pop;
    }

    let mut excited = [0.0f64; 360];
    for (h, slot) in excited.iter_mut().enumerate() {
        let mut sum = 0.0;
        for d in -14..=14 {
            let idx = ((h as isize + d).rem_euclid(360)) as usize;
            sum += hue_pop[idx];
        }
        *slot = sum;
    }

    let mut scored: Vec<(u32, f64, Hct)> = entries
        .iter()
        .filter(|(_, _, h)| h.chroma() >= 5.0 && excited[(h.hue().round() as usize) % 360] >= 0.01)
        .map(|&(argb, _, h)| {
            let hue_idx = (h.hue().round() as usize) % 360;
            let proportion = excited[hue_idx];
            let prop_score = proportion * 100.0 * 0.7;
            let weight = if h.chroma() < 48.0 { 0.1 } else { 0.3 };
            let chroma_score = (h.chroma() - 48.0) * weight;
            (argb, prop_score + chroma_score, h)
        })
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let dominant = entries.first().map(|e| e.0).unwrap_or(0xff7c_6cf0);
    let accent = scored.first().map(|s| s.0).unwrap_or(0xff7c_6cf0);

    let mut distinct: Vec<u32> = Vec::with_capacity(5);
    let mut distinct_hcts: Vec<Hct> = Vec::with_capacity(5);
    for (argb, _, h) in entries {
        let far_enough = distinct_hcts.iter().all(|o| {
            let dh = (o.hue() - h.hue()).abs();
            dh.min(360.0 - dh) > 18.0 || (o.tone() - h.tone()).abs() > 22.0
        });
        if far_enough {
            distinct.push(argb);
            distinct_hcts.push(h);
            if distinct.len() >= 5 {
                break;
            }
        }
    }
    if distinct.is_empty() {
        distinct.push(accent);
    }

    Some(Palette {
        accent,
        dominant,
        colors: distinct,
    })
}

/// Build an M3 2025 `Scheme` where accent palettes derive from `accent_argb` and neutral/surface
/// palettes derive independently from `bg_argb` (with true-black neutrality when `bg_argb` chroma < 6).
pub fn build_scheme(accent_argb: u32, bg_argb: u32, dark: bool, variant: ColorVariant) -> Scheme {
    let base = SeedScheme::new(accent_argb & 0xff_ffff)
        .variant(variant_to_m3(variant))
        .dark(dark)
        .spec(SpecVersion::Spec2025)
        .scheme();

    let b = Hct::from_argb(bg_argb);
    let is_neutral_bg = b.chroma() < 6.0;
    let c = if is_neutral_bg {
        0.0
    } else {
        (b.chroma() * 0.56).clamp(8.0, 32.0)
    };
    let cv = if is_neutral_bg { 0.0 } else { c + 4.0 };
    let hue = if is_neutral_bg { 0.0 } else { b.hue() };

    let n = TonalPalette::from_hue_and_chroma(hue, c);
    let nv = TonalPalette::from_hue_and_chroma(hue, cv);

    if dark {
        base.with_role(ColorRole::SURFACE, color_from_argb(n.tone(6.0)))
            .with_role(ColorRole::SURFACE_DIM, color_from_argb(n.tone(6.0)))
            .with_role(ColorRole::SURFACE_BRIGHT, color_from_argb(n.tone(24.0)))
            .with_role(ColorRole::SURFACE_CONTAINER_LOWEST, color_from_argb(n.tone(4.0)))
            .with_role(ColorRole::SURFACE_CONTAINER_LOW, color_from_argb(n.tone(10.0)))
            .with_role(ColorRole::SURFACE_CONTAINER, color_from_argb(n.tone(12.0)))
            .with_role(ColorRole::SURFACE_CONTAINER_HIGH, color_from_argb(n.tone(17.0)))
            .with_role(ColorRole::SURFACE_CONTAINER_HIGHEST, color_from_argb(n.tone(22.0)))
            .with_role(ColorRole::SURFACE_VARIANT, color_from_argb(nv.tone(30.0)))
            .with_role(ColorRole::ON_SURFACE, color_from_argb(n.tone(90.0)))
            .with_role(ColorRole::ON_SURFACE_VARIANT, color_from_argb(nv.tone(80.0)))
            .with_role(ColorRole::OUTLINE, color_from_argb(nv.tone(60.0)))
            .with_role(ColorRole::OUTLINE_VARIANT, color_from_argb(nv.tone(30.0)))
            .with_role(ColorRole::INVERSE_SURFACE, color_from_argb(n.tone(90.0)))
            .with_role(ColorRole::INVERSE_ON_SURFACE, color_from_argb(n.tone(20.0)))
    } else {
        base.with_role(ColorRole::SURFACE, color_from_argb(n.tone(98.0)))
            .with_role(ColorRole::SURFACE_DIM, color_from_argb(n.tone(87.0)))
            .with_role(ColorRole::SURFACE_BRIGHT, color_from_argb(n.tone(98.0)))
            .with_role(ColorRole::SURFACE_CONTAINER_LOWEST, color_from_argb(n.tone(100.0)))
            .with_role(ColorRole::SURFACE_CONTAINER_LOW, color_from_argb(n.tone(96.0)))
            .with_role(ColorRole::SURFACE_CONTAINER, color_from_argb(n.tone(94.0)))
            .with_role(ColorRole::SURFACE_CONTAINER_HIGH, color_from_argb(n.tone(92.0)))
            .with_role(ColorRole::SURFACE_CONTAINER_HIGHEST, color_from_argb(n.tone(90.0)))
            .with_role(ColorRole::SURFACE_VARIANT, color_from_argb(nv.tone(90.0)))
            .with_role(ColorRole::ON_SURFACE, color_from_argb(n.tone(10.0)))
            .with_role(ColorRole::ON_SURFACE_VARIANT, color_from_argb(nv.tone(30.0)))
            .with_role(ColorRole::OUTLINE, color_from_argb(nv.tone(50.0)))
            .with_role(ColorRole::OUTLINE_VARIANT, color_from_argb(nv.tone(80.0)))
            .with_role(ColorRole::INVERSE_SURFACE, color_from_argb(n.tone(20.0)))
            .with_role(ColorRole::INVERSE_ON_SURFACE, color_from_argb(n.tone(95.0)))
    }
}

pub fn compute_neon_argb(accent_argb: u32, dark: bool) -> u32 {
    let h = Hct::from_argb(accent_argb);
    let neon_chroma = h.chroma().max(62.0);
    let neon_tone = if dark {
        h.tone().clamp(58.0, 74.0)
    } else {
        h.tone().clamp(42.0, 58.0)
    };
    hct_argb(h.hue(), neon_chroma, neon_tone)
}

pub fn build_metallic_scheme(
    accent_argb: u32,
    bg_argb: u32,
    base: Scheme,
    dark: bool,
    is_custom_color_bg: bool,
    neon_enabled: bool,
    neon_intensity: f32,
) -> Scheme {
    let h = Hct::from_argb(accent_argb);
    let bg_h = Hct::from_argb(bg_argb);
    let bg_pure_black = is_custom_color_bg && bg_h.chroma() < 6.0 && bg_h.tone() < 3.0;
    let neon_on = neon_enabled && neon_intensity > 0.0;
    let k = if neon_on {
        (neon_intensity / 100.0).clamp(0.0, 1.0) as f64
    } else {
        0.0
    };
    let c_boost = h.chroma().min(76.0) * k;
    let surf_hue = if is_custom_color_bg {
        if bg_h.chroma() < 6.0 { 0.0 } else { bg_h.hue() }
    } else {
        h.hue()
    };
    let surf_chroma = if is_custom_color_bg {
        if bg_h.chroma() < 6.0 {
            0.0
        } else {
            bg_h.chroma().min(32.0) * 0.25
        }
    } else {
        c_boost
    };

    if !dark {
        return base
            .with_role(
                ColorRole::PRIMARY,
                color_from_argb(if neon_on {
                    hct_argb(h.hue(), c_boost * 0.5, 24.0)
                } else {
                    0xff1e_2229
                }),
            )
            .with_role(ColorRole::ON_PRIMARY, color_from_argb(0xfff7_f9fc))
            .with_role(
                ColorRole::PRIMARY_CONTAINER,
                color_from_argb(if neon_on {
                    hct_argb(h.hue(), c_boost * 0.35, 86.0)
                } else {
                    0xffd8_dde6
                }),
            )
            .with_role(ColorRole::ON_PRIMARY_CONTAINER, color_from_argb(0xff14_171c))
            .with_role(
                ColorRole::SECONDARY_CONTAINER,
                color_from_argb(if neon_on {
                    hct_argb(h.hue(), c_boost * 0.28, 89.0)
                } else {
                    0xffe2_e6ee
                }),
            )
            .with_role(
                ColorRole::ON_SECONDARY_CONTAINER,
                color_from_argb(0xff1d_2026),
            );
    }

    let mut s = base
        .with_role(
            ColorRole::PRIMARY,
            color_from_argb(if neon_on {
                hct_argb(h.hue(), c_boost * 0.42, 92.0 - k * 6.0)
            } else {
                0xfff2_f4f8
            }),
        )
        .with_role(
            ColorRole::ON_PRIMARY,
            color_from_argb(if neon_on {
                hct_argb(h.hue(), c_boost * 0.35, 11.0)
            } else {
                0xff11_1317
            }),
        )
        .with_role(
            ColorRole::PRIMARY_CONTAINER,
            color_from_argb(if neon_on {
                hct_argb(h.hue(), c_boost * 0.48, 22.0 + k * 6.0)
            } else {
                0xff2d_3139
            }),
        )
        .with_role(
            ColorRole::ON_PRIMARY_CONTAINER,
            color_from_argb(if neon_on {
                hct_argb(h.hue(), c_boost * 0.45, 92.0)
            } else {
                0xffee_f1f6
            }),
        )
        .with_role(
            ColorRole::SECONDARY,
            color_from_argb(if neon_on {
                hct_argb(h.hue(), c_boost * 0.32, 80.0)
            } else {
                0xffc8_cdd6
            }),
        )
        .with_role(ColorRole::ON_SECONDARY, color_from_argb(0xff18_1a1f))
        .with_role(
            ColorRole::SECONDARY_CONTAINER,
            color_from_argb(if neon_on {
                hct_argb(h.hue(), c_boost * 0.36, 19.0 + k * 4.0)
            } else {
                0xff26_2930
            }),
        )
        .with_role(
            ColorRole::ON_SECONDARY_CONTAINER,
            color_from_argb(if neon_on {
                hct_argb(h.hue(), c_boost * 0.38, 90.0)
            } else {
                0xffe4_e7ee
            }),
        )
        .with_role(
            ColorRole::TERTIARY,
            color_from_argb(if neon_on {
                hct_argb(h.hue() + 24.0, c_boost * 0.45, 84.0)
            } else {
                0xffdf_e3ec
            }),
        )
        .with_role(ColorRole::ON_TERTIARY, color_from_argb(0xff16_181d))
        .with_role(
            ColorRole::TERTIARY_CONTAINER,
            color_from_argb(if neon_on {
                hct_argb(h.hue() + 24.0, c_boost * 0.4, 24.0)
            } else {
                0xff32_3640
            }),
        )
        .with_role(
            ColorRole::ON_TERTIARY_CONTAINER,
            color_from_argb(0xfff0_f2f7),
        )
        .with_role(ColorRole::ON_SURFACE, color_from_argb(0xfff3_f5f9));

    if !is_custom_color_bg || bg_pure_black {
        s = s
            .with_role(
                ColorRole::SURFACE,
                color_from_argb(if bg_pure_black { 0xff00_0000 } else { 0xff0b_0c0f }),
            )
            .with_role(
                ColorRole::SURFACE_CONTAINER_LOWEST,
                color_from_argb(if bg_pure_black { 0xff05_0505 } else { 0xff07_080a }),
            )
            .with_role(
                ColorRole::SURFACE_CONTAINER_LOW,
                color_from_argb(if bg_pure_black {
                    0xff0d_0d0d
                } else if neon_on {
                    hct_argb(surf_hue, surf_chroma * 0.1, 8.0)
                } else {
                    0xff11_1317
                }),
            )
            .with_role(
                ColorRole::SURFACE_CONTAINER,
                color_from_argb(if bg_pure_black {
                    0xff12_1212
                } else if neon_on {
                    hct_argb(surf_hue, surf_chroma * 0.12, 11.0)
                } else {
                    0xff16_181e
                }),
            )
            .with_role(
                ColorRole::SURFACE_CONTAINER_HIGH,
                color_from_argb(if bg_pure_black {
                    0xff1a_1a1a
                } else if neon_on {
                    hct_argb(surf_hue, surf_chroma * 0.15, 15.0)
                } else {
                    0xff1e_2128
                }),
            )
            .with_role(
                ColorRole::SURFACE_CONTAINER_HIGHEST,
                color_from_argb(if bg_pure_black {
                    0xff24_2424
                } else if neon_on {
                    hct_argb(surf_hue, surf_chroma * 0.18, 20.0)
                } else {
                    0xff28_2c35
                }),
            );
    }

    s = s
        .with_role(
            ColorRole::ON_SURFACE_VARIANT,
            color_from_argb(if bg_pure_black || (is_custom_color_bg && bg_h.chroma() < 6.0) {
                0xffa3_a3a3
            } else if neon_on {
                hct_argb(h.hue(), c_boost * 0.18, 70.0)
            } else {
                0xff9f_a6b2
            }),
        )
        .with_role(
            ColorRole::OUTLINE,
            color_from_argb(if bg_pure_black || (is_custom_color_bg && bg_h.chroma() < 6.0) {
                0xff5e_5e5e
            } else if neon_on {
                hct_argb(h.hue(), c_boost * 0.28, 44.0)
            } else {
                0xff5c_626e
            }),
        )
        .with_role(
            ColorRole::OUTLINE_VARIANT,
            color_from_argb(if bg_pure_black || (is_custom_color_bg && bg_h.chroma() < 6.0) {
                0xff36_3636
            } else if neon_on {
                hct_argb(h.hue(), c_boost * 0.22, 26.0)
            } else {
                0xff34_3842
            }),
        );

    let _ = DynamicScheme::argb;
    s
}

pub fn mesh_from_source(src_argb: u32, dark: bool, exact: bool) -> (u32, [u32; 4]) {
    let h = Hct::from_argb(src_argb);
    if exact {
        let c = if h.chroma() < 6.0 { 0.0 } else { h.chroma() };
        let hue = if c == 0.0 { 0.0 } else { h.hue() };
        let tone = if dark {
            (h.tone() * 0.72).clamp(0.0, 46.0)
        } else {
            h.tone().clamp(76.0, 98.0)
        };
        let base = hct_argb(hue, c, tone);
        let min_blob_tone = if h.tone() < 2.0 { 0.0 } else { 4.0 };
        let specs = [(8.0, 1.04, 10.0), (-10.0, 0.96, -8.0), (14.0, 0.94, 6.0), (-6.0, 1.08, 14.0)];
        let colors = specs.map(|(dh, k, dt)| {
            let t = if c == 0.0 && h.tone() < 2.0 {
                0.0
            } else {
                (tone + if dark { dt } else { -dt * 0.5 }).clamp(min_blob_tone, 96.0)
            };
            hct_argb(hue + dh, c * k, t)
        });
        return (base, colors);
    }

    let tone = if dark { h.tone().min(30.0) } else { h.tone().max(84.0) };
    let base = hct_argb(h.hue(), h.chroma(), tone);
    let specs = [(18.0, 1.1, 14.0), (-26.0, 1.0, -9.0), (42.0, 0.9, 8.0), (0.0, 1.25, 20.0)];
    let colors = specs.map(|(dh, k, dt)| {
        hct_argb(
            h.hue() + dh,
            h.chroma() * k,
            (tone + if dark { dt } else { -dt * 0.6 }).clamp(2.0, 98.0),
        )
    });
    (base, colors)
}

#[derive(Clone, Debug)]
pub struct ResolvedTheme {
    pub scheme: Scheme,
    pub dark: bool,
    pub accent_argb: u32,
    pub neon_argb: u32,
    pub neon_intensity: f32,
    pub bg: BgSpec,
}

pub fn resolve_theme(
    appearance: &Appearance,
    dark: bool,
    track_id: Option<&str>,
    track_cover_url: Option<&str>,
    track_palette: Option<&Palette>,
    custom_bg_image_path: Option<&str>,
    custom_bg_palette: Option<&Palette>,
) -> ResolvedTheme {
    let custom_accent = argb_from_hex(&appearance.accent_color);
    let accent_argb = if appearance.accent_mode == AccentMode::Dynamic {
        track_palette
            .map(|p| p.accent)
            .unwrap_or_else(|| track_id.map(fallback_color).unwrap_or(custom_accent))
    } else {
        custom_accent
    };

    let bg_src = match appearance.bg_mode {
        BgMode::Dynamic => track_palette.map(|p| p.dominant).unwrap_or(accent_argb),
        BgMode::Color => argb_from_hex(&appearance.bg_color),
        BgMode::Image => custom_bg_palette
            .map(|p| p.dominant)
            .unwrap_or_else(|| argb_from_hex(&appearance.bg_color)),
    };

    let effective_variant = if appearance.metallic {
        ColorVariant::Mono
    } else {
        appearance.variant
    };
    let base_scheme = build_scheme(accent_argb, bg_src, dark, effective_variant);
    let scheme = if appearance.metallic {
        build_metallic_scheme(
            accent_argb,
            bg_src,
            base_scheme,
            dark,
            appearance.bg_mode == BgMode::Color,
            appearance.metallic_neon,
            appearance.metallic_neon_intensity,
        )
    } else {
        base_scheme
    };

    let neon_argb = compute_neon_argb(accent_argb, dark);
    let neon_intensity = if appearance.metallic && appearance.metallic_neon {
        (appearance.metallic_neon_intensity / 100.0).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let surface_argb = scheme.get(ColorRole::SURFACE).to_argb();
    let dim_alpha = (appearance.bg_dim / 100.0).clamp(0.0, 1.0);

    let bg = if appearance.bg_mode == BgMode::Image {
        if let Some(img_ref) = custom_bg_image_path.filter(|s| !s.is_empty()) {
            BgSpec::Image {
                key: format!("img:{img_ref}"),
                image_ref: img_ref.to_string(),
                is_custom_file: true,
                base: surface_argb,
                blur: appearance.bg_blur,
                dim_alpha,
                dark,
            }
        } else {
            let (base, colors) = mesh_from_source(bg_src, dark, false);
            BgSpec::Mesh {
                key: format!("mesh:{base:08x}"),
                base,
                colors,
            }
        }
    } else if appearance.bg_mode == BgMode::Dynamic && appearance.bg_style == BgStyle::Artwork {
        if let Some(cover) = track_cover_url.filter(|s| !s.is_empty()) {
            BgSpec::Image {
                key: format!("art:{cover}"),
                image_ref: cover.to_string(),
                is_custom_file: false,
                base: surface_argb,
                blur: 56.0 + appearance.bg_blur,
                dim_alpha,
                dark,
            }
        } else {
            let (base, colors) = mesh_from_source(bg_src, dark, false);
            BgSpec::Mesh {
                key: format!("mesh:{base:08x}"),
                base,
                colors,
            }
        }
    } else if appearance.bg_mode == BgMode::Dynamic {
        if let Some(pal) = track_palette {
            let d = Hct::from_argb(pal.dominant);
            let base = hct_argb(d.hue(), d.chroma().min(30.0), if dark { 10.0 } else { 94.0 });
            let mut blob_list = Vec::with_capacity(4);
            for (i, &c) in pal.colors.iter().take(4).enumerate() {
                let h = Hct::from_argb(c);
                let tone = if dark {
                    h.tone().clamp(26.0, 46.0) - (i as f64) * 3.0
                } else {
                    h.tone().clamp(70.0, 88.0)
                };
                blob_list.push(hct_argb(h.hue(), (h.chroma() * 1.15).min(72.0), tone));
            }
            while blob_list.len() < 4 {
                blob_list.push(*blob_list.last().unwrap_or(&base));
            }
            BgSpec::Mesh {
                key: format!("mesh:{}", track_id.unwrap_or("dyn")),
                base,
                colors: [blob_list[0], blob_list[1], blob_list[2], blob_list[3]],
            }
        } else {
            let (base, colors) = mesh_from_source(bg_src, dark, false);
            BgSpec::Mesh {
                key: format!("mesh:{base:08x}"),
                base,
                colors,
            }
        }
    } else {
        let (base, colors) = mesh_from_source(bg_src, dark, appearance.bg_mode == BgMode::Color);
        BgSpec::Mesh {
            key: if appearance.bg_mode == BgMode::Color {
                "mesh:color".to_string()
            } else {
                format!("mesh:{base:08x}")
            },
            base,
            colors,
        }
    };

    ResolvedTheme {
        scheme,
        dark,
        accent_argb,
        neon_argb,
        neon_intensity,
        bg,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgba, RgbaImage};
    use std::io::Cursor;

    #[test]
    fn hex_and_argb_roundtrip() {
        assert_eq!(argb_from_hex("#a0a8b8"), 0xffa0_a8b8);
        assert_eq!(argb_from_hex("#000"), 0xff00_0000);
        assert_eq!(hex_from_argb(0xff7c_6cf0), "#7c6cf0");
    }

    #[test]
    fn achromatic_black_bg_keeps_surfaces_neutral() {
        let scheme = build_scheme(0xffff_4081, 0xff00_0000, true, ColorVariant::Vibrant);
        let surf = scheme.get(ColorRole::SURFACE);
        assert!((surf.r - surf.g).abs() < 0.02);
        assert!((surf.g - surf.b).abs() < 0.02);
    }

    #[test]
    fn metallic_pure_black_overrides_surface_to_black() {
        let base = build_scheme(0xff7c_6cf0, 0xff00_0000, true, ColorVariant::Mono);
        let met = build_metallic_scheme(0xff7c_6cf0, 0xff00_0000, base, true, true, true, 50.0);
        assert_eq!(met.get(ColorRole::SURFACE), Color::argb(0xff00_0000));
    }

    #[test]
    fn extracts_dominant_and_accent_from_png() {
        let mut img = RgbaImage::new(32, 32);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = if x < 24 && y < 24 {
                Rgba([220, 48, 84, 255])
            } else {
                Rgba([36, 120, 240, 255])
            };
        }
        let mut bytes = Vec::new();
        img.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        let pal = extract_palette_from_image_bytes(&bytes).expect("palette");
        assert!(pal.colors.len() >= 2);
        let dom_hct = Hct::from_argb(pal.dominant);
        assert!(dom_hct.chroma() > 20.0);
    }
}
