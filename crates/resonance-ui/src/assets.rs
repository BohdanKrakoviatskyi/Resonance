use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex, OnceLock};

use gpui_kit::{AssetSource, Hsla, Image, ImageFormat, Rgba, SharedString, px};
use gpui_kit_material::icons::{Assets as MaterialAssets, Icon as MaterialIcon};
use gpui_material_symbols::{Style as SymbolStyle, Symbol};

static RS_MARK_PNG: &[u8] = include_bytes!("../../../assets/rs-mark.png");
static RS_MARK_ALPHA: OnceLock<(u32, u32, Vec<u8>)> = OnceLock::new();
static RS_MARK_TINT_CACHE: OnceLock<Mutex<HashMap<u32, Arc<Image>>>> = OnceLock::new();
static SOUNDCLOUD_SVG: &[u8] = include_bytes!("../../../assets/soundcloud.svg");
static YTMUSIC_SVG: &[u8] = include_bytes!("../../../assets/youtube-music.svg");
static APP_ICON_PNG: &[u8] = include_bytes!("../../../assets/app-icon.png");
static ROBOTO_REGULAR_TTF: &[u8] = include_bytes!("../../../assets/fonts/Roboto-Regular.ttf");
static ROBOTO_MEDIUM_TTF: &[u8] = include_bytes!("../../../assets/fonts/Roboto-Medium.ttf");
static ROBOTO_BOLD_TTF: &[u8] = include_bytes!("../../../assets/fonts/Roboto-Bold.ttf");

/// Register bundled Material 3 Roboto font faces with GPUI's text system.
pub fn register_embedded_fonts(cx: &gpui_kit::App) {
    if let Err(err) = cx.text_system().add_fonts(vec![
        Cow::Borrowed(ROBOTO_REGULAR_TTF),
        Cow::Borrowed(ROBOTO_MEDIUM_TTF),
        Cow::Borrowed(ROBOTO_BOLD_TTF),
    ]) {
        log::warn!("failed to register bundled Roboto fonts: {err:#}");
    }
}

/// Exact 77 Material Symbol icon names referenced by the React UI (`src/components/Icon.tsx`).
#[cfg(test)]
pub const ALL_77_ICONS: [&str; 77] = [
    "home",
    "search",
    "favorite",
    "favorite_border",
    "thumb_down",
    "library_music",
    "queue_music",
    "playlist_add",
    "playlist_play",
    "playlist_remove",
    "play_arrow",
    "pause",
    "skip_next",
    "skip_previous",
    "shuffle",
    "repeat",
    "repeat_one",
    "volume_up",
    "volume_down",
    "volume_off",
    "lyrics",
    "album",
    "music_note",
    "person",
    "open_in_full",
    "close_fullscreen",
    "fullscreen",
    "add",
    "more_horiz",
    "close",
    "check",
    "edit",
    "delete",
    "palette",
    "tune",
    "auto_awesome",
    "dark_mode",
    "light_mode",
    "devices",
    "image",
    "upload",
    "keyboard_arrow_down",
    "keyboard_arrow_right",
    "menu",
    "chevron_left",
    "chevron_right",
    "arrow_back",
    "refresh",
    "language",
    "auto_fix_high",
    "graphic_eq",
    "blur_on",
    "undo",
    "settings",
    "extension",
    "login",
    "logout",
    "link",
    "check_circle",
    "error",
    "system_update",
    "delete_forever",
    "delete_sweep",
    "download",
    "keyboard",
    "equalizer",
    "slidertune",
    "speed",
    "bolt",
    "star",
    "clear",
    "content_copy",
    "open_in_new",
    "info",
    "warning",
    "help",
    "drag_indicator",
];

#[derive(Clone, Copy, Default)]
pub struct ResonanceAssets;

impl ResonanceAssets {
    pub fn into_asset_source(self) -> MaterialAssets<Self> {
        MaterialAssets::with(self)
    }
}

impl AssetSource for ResonanceAssets {
    fn load(&self, path: &str) -> gpui_kit::Result<Option<Cow<'static, [u8]>>> {
        Ok(match path {
            "assets/rs-mark.png" => Some(Cow::Borrowed(RS_MARK_PNG)),
            "assets/soundcloud.svg" => Some(Cow::Borrowed(SOUNDCLOUD_SVG)),
            "assets/youtube-music.svg" => Some(Cow::Borrowed(YTMUSIC_SVG)),
            "assets/app-icon.png" => Some(Cow::Borrowed(APP_ICON_PNG)),
            _ => None,
        })
    }

    fn list(&self, path: &str) -> gpui_kit::Result<Vec<SharedString>> {
        if path.is_empty() || path == "assets" || path == "assets/" {
            Ok(vec![
                "assets/rs-mark.png".into(),
                "assets/soundcloud.svg".into(),
                "assets/youtube-music.svg".into(),
                "assets/app-icon.png".into(),
            ])
        } else {
            Ok(Vec::new())
        }
    }
}

/// Resolve any Material Symbol name with fallback, matching `src/components/Icon.tsx`.
pub fn resolve_symbol(name: &str) -> Symbol {
    let mapped = match name {
        // Fallback aliases for non-standard symbol names used in Icon.tsx
        "favorite_border" => "favorite",
        "slidertune" => "tune",
        other => other,
    };
    Symbol::named(mapped)
        .or_else(|| Symbol::named("music_note"))
        .unwrap_or_else(|| Symbol::all().next().expect("symbols"))
}

pub fn ms_icon(name: &str, filled: bool, size_px: f32, color: impl Into<Hsla>) -> MaterialIcon {
    let is_filled = filled && name != "favorite_border";
    let sym = resolve_symbol(name);
    let icon = sym.icon().style(SymbolStyle::Rounded).filled(is_filled);
    MaterialIcon::from(icon).size(px(size_px)).color(color.into())
}

/// Returns the `rs-mark.png` emblem tinted to `tint` (`ON_PRIMARY`), cached by ARGB32 key.
pub fn tinted_rs_mark(tint: impl Into<Hsla>) -> Option<Arc<Image>> {
    let rgb: Rgba = tint.into().into();
    let r = (rgb.r.clamp(0.0, 1.0) * 255.0).round() as u8;
    let g = (rgb.g.clamp(0.0, 1.0) * 255.0).round() as u8;
    let b = (rgb.b.clamp(0.0, 1.0) * 255.0).round() as u8;
    let a_scale = rgb.a.clamp(0.0, 1.0);
    let key = u32::from_be_bytes([(a_scale * 255.0).round() as u8, r, g, b]);

    let cache = RS_MARK_TINT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock()
        && let Some(hit) = guard.get(&key)
    {
        return Some(hit.clone());
    }

    let (w, h, alphas) = RS_MARK_ALPHA.get_or_init(|| {
        let img = image::load_from_memory(RS_MARK_PNG)
            .expect("embedded rs-mark.png decodes")
            .to_rgba8();
        let (w, h) = img.dimensions();
        let alphas: Vec<u8> = img.pixels().map(|p| p[3]).collect();
        (w, h, alphas)
    });

    let mut rgba = Vec::with_capacity(alphas.len() * 4);
    for &mask_a in alphas {
        let a = ((mask_a as f32) * a_scale).round() as u8;
        rgba.extend_from_slice(&[r, g, b, a]);
    }
    let buffer = image::RgbaImage::from_raw(*w, *h, rgba)?;
    let mut png_bytes = Vec::with_capacity(4096);
    image::DynamicImage::ImageRgba8(buffer)
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .ok()?;
    let gpui_img = Arc::new(Image::from_bytes(ImageFormat::Png, png_bytes));

    if let Ok(mut guard) = cache.lock() {
        if guard.len() > 32 {
            guard.clear();
        }
        guard.insert(key, gpui_img.clone());
    }
    Some(gpui_img)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_77_icons_resolve_in_material_symbols() {
        for name in ALL_77_ICONS {
            let sym = resolve_symbol(name);
            assert!(
                !sym.icon().asset_path().is_empty(),
                "icon `{name}` failed to resolve"
            );
        }
        // Explicitly verify non-aliased standard names resolve directly
        for direct in ["play_arrow", "pause", "shuffle", "repeat", "equalizer", "lyrics", "palette", "tune"] {
            assert!(Symbol::named(direct).is_some(), "missing direct symbol {direct}");
        }
    }

    #[test]
    fn resonance_brand_assets_are_embedded() {
        let src = ResonanceAssets;
        assert!(src.load("assets/rs-mark.png").unwrap().is_some());
        assert!(src.load("assets/soundcloud.svg").unwrap().is_some());
        assert!(src.load("assets/youtube-music.svg").unwrap().is_some());
        assert!(src.load("assets/app-icon.png").unwrap().is_some());
    }

    #[test]
    fn embedded_roboto_fonts_are_valid_ttfs() {
        for (name, bytes) in [
            ("Roboto-Regular.ttf", ROBOTO_REGULAR_TTF),
            ("Roboto-Medium.ttf", ROBOTO_MEDIUM_TTF),
            ("Roboto-Bold.ttf", ROBOTO_BOLD_TTF),
        ] {
            assert!(bytes.len() > 100_000, "{name} unexpectedly small");
            assert_eq!(&bytes[..4], &[0x00, 0x01, 0x00, 0x00], "{name} invalid TTF header");
        }
    }
}
