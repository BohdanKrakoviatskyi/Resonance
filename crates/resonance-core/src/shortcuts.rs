use serde::{Deserialize, Serialize};

use crate::i18n::Key;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutId {
    PlayPause,
    SeekBack,
    SeekForward,
    Previous,
    Next,
    Like,
    Lyrics,
    Search,
    Mute,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShortcutScope {
    Window,
    Global,
}

#[derive(Clone, Copy, Debug)]
pub struct ShortcutDefinition {
    pub id: ShortcutId,
    pub label: Key,
    pub scope: ShortcutScope,
    pub default_binding: &'static str,
}

pub const SHORTCUTS: [ShortcutDefinition; 9] = [
    ShortcutDefinition { id: ShortcutId::PlayPause, label: Key::KbPlay, scope: ShortcutScope::Window, default_binding: "Space" },
    ShortcutDefinition { id: ShortcutId::SeekBack, label: Key::KbSeekBack, scope: ShortcutScope::Window, default_binding: "ArrowLeft" },
    ShortcutDefinition { id: ShortcutId::SeekForward, label: Key::KbSeekForward, scope: ShortcutScope::Window, default_binding: "ArrowRight" },
    ShortcutDefinition { id: ShortcutId::Previous, label: Key::KbPrevious, scope: ShortcutScope::Window, default_binding: "Shift+ArrowLeft" },
    ShortcutDefinition { id: ShortcutId::Next, label: Key::KbNext, scope: ShortcutScope::Window, default_binding: "Shift+ArrowRight" },
    ShortcutDefinition { id: ShortcutId::Like, label: Key::KbLike, scope: ShortcutScope::Window, default_binding: "L" },
    ShortcutDefinition { id: ShortcutId::Lyrics, label: Key::KbLyrics, scope: ShortcutScope::Window, default_binding: "F" },
    ShortcutDefinition { id: ShortcutId::Search, label: Key::KbSearch, scope: ShortcutScope::Window, default_binding: "/" },
    ShortcutDefinition { id: ShortcutId::Mute, label: Key::KbMute, scope: ShortcutScope::Global, default_binding: "Shift+M" },
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortcutBindings {
    pub play_pause: String,
    pub seek_back: String,
    pub seek_forward: String,
    pub previous: String,
    pub next: String,
    pub like: String,
    pub lyrics: String,
    pub search: String,
    pub mute: String,
}

impl Default for ShortcutBindings {
    fn default() -> Self {
        Self {
            play_pause: "Space".into(),
            seek_back: "ArrowLeft".into(),
            seek_forward: "ArrowRight".into(),
            previous: "Shift+ArrowLeft".into(),
            next: "Shift+ArrowRight".into(),
            like: "L".into(),
            lyrics: "F".into(),
            search: "/".into(),
            mute: "Shift+M".into(),
        }
    }
}

impl ShortcutBindings {
    pub fn get(&self, id: ShortcutId) -> &str {
        match id {
            ShortcutId::PlayPause => &self.play_pause,
            ShortcutId::SeekBack => &self.seek_back,
            ShortcutId::SeekForward => &self.seek_forward,
            ShortcutId::Previous => &self.previous,
            ShortcutId::Next => &self.next,
            ShortcutId::Like => &self.like,
            ShortcutId::Lyrics => &self.lyrics,
            ShortcutId::Search => &self.search,
            ShortcutId::Mute => &self.mute,
        }
    }

    pub fn set(&mut self, id: ShortcutId, value: String) {
        let slot = match id {
            ShortcutId::PlayPause => &mut self.play_pause,
            ShortcutId::SeekBack => &mut self.seek_back,
            ShortcutId::SeekForward => &mut self.seek_forward,
            ShortcutId::Previous => &mut self.previous,
            ShortcutId::Next => &mut self.next,
            ShortcutId::Like => &mut self.like,
            ShortcutId::Lyrics => &mut self.lyrics,
            ShortcutId::Search => &mut self.search,
            ShortcutId::Mute => &mut self.mute,
        };
        *slot = normalize_shortcut(&value);
    }

    pub fn has_duplicate(&self, id: ShortcutId, normalized: &str) -> bool {
        SHORTCUTS
            .iter()
            .any(|def| def.id != id && normalize_shortcut(self.get(def.id)) == normalized)
    }

    pub fn sanitize(&mut self) {
        for def in SHORTCUTS {
            let v = self.get(def.id).to_string();
            if is_valid_shortcut(&v) {
                self.set(def.id, v);
            } else {
                self.set(def.id, def.default_binding.to_string());
            }
        }
    }
}

pub fn cyrillic_to_latin(ch: char) -> Option<&'static str> {
    match ch.to_uppercase().next()? {
        'Й' => Some("Q"), 'Ц' => Some("W"), 'У' => Some("E"), 'К' => Some("R"), 'Е' => Some("T"),
        'Н' => Some("Y"), 'Г' => Some("U"), 'Ш' => Some("I"), 'Щ' => Some("O"), 'З' => Some("P"),
        'Х' => Some("["), 'Ъ' => Some("]"),
        'Ф' => Some("A"), 'Ы' => Some("S"), 'В' => Some("D"), 'А' => Some("F"), 'П' => Some("G"),
        'Р' => Some("H"), 'О' => Some("J"), 'Л' => Some("K"), 'Д' => Some("L"), 'Ж' => Some(";"),
        'Э' => Some("'"),
        'Я' => Some("Z"), 'Ч' => Some("X"), 'С' => Some("C"), 'М' => Some("V"), 'И' => Some("B"),
        'Т' => Some("N"), 'Ь' => Some("M"), 'Б' => Some(","), 'Ю' => Some("."), 'Ё' => Some("`"),
        'І' => Some("S"), 'Ї' => Some("]"), 'Є' => Some("'"), 'Ґ' => Some("\\"),
        _ => None,
    }
}

pub fn normalize_shortcut(value: &str) -> String {
    value
        .split('+')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|part| match part.to_lowercase().as_str() {
            "control" | "ctrl" => "Ctrl".to_string(),
            "alt" | "option" => "Alt".to_string(),
            "shift" => "Shift".to_string(),
            "meta" | "command" | "cmd" | "super" | "win" => "Meta".to_string(),
            "space" | "spacebar" | " " => "Space".to_string(),
            "left" | "arrowleft" => "ArrowLeft".to_string(),
            "right" | "arrowright" => "ArrowRight".to_string(),
            "up" | "arrowup" => "ArrowUp".to_string(),
            "down" | "arrowdown" => "ArrowDown".to_string(),
            _ if part.chars().count() == 1 => {
                let ch = part.chars().next().unwrap();
                cyrillic_to_latin(ch)
                    .map(str::to_string)
                    .unwrap_or_else(|| ch.to_uppercase().collect())
            }
            _ => part.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

pub fn is_valid_shortcut(value: &str) -> bool {
    let normalized = normalize_shortcut(value);
    if normalized.is_empty() {
        return false;
    }
    let parts: Vec<&str> = normalized.split('+').collect();
    if parts.is_empty() || parts.iter().any(|p| p.trim().is_empty()) {
        return false;
    }
    let is_mod = |p: &str| matches!(p, "Ctrl" | "Alt" | "Shift" | "Meta");
    let key = parts[parts.len() - 1];
    if is_mod(key) {
        return false;
    }
    let used = &parts[..parts.len() - 1];
    let mut seen = std::collections::HashSet::new();
    used.iter().all(|m| is_mod(m) && seen.insert(*m))
}

pub fn display_shortcut(value: &str) -> Vec<String> {
    let is_mac = cfg!(target_os = "macos");
    normalize_shortcut(value)
        .split('+')
        .filter(|p| !p.is_empty())
        .map(|part| match part {
            "Meta" => if is_mac { "⌘" } else { "Win" }.to_string(),
            "Ctrl" => if is_mac { "⌃" } else { "Ctrl" }.to_string(),
            "Alt" => if is_mac { "⌥" } else { "Alt" }.to_string(),
            "Shift" => if is_mac { "⇧" } else { "Shift" }.to_string(),
            "ArrowLeft" => "←".to_string(),
            "ArrowRight" => "→".to_string(),
            "ArrowUp" => "↑".to_string(),
            "ArrowDown" => "↓".to_string(),
            other => other.to_string(),
        })
        .collect()
}

pub fn shortcut_from_keystroke(
    key: &str,
    control: bool,
    alt: bool,
    shift: bool,
    platform: bool,
) -> Option<String> {
    let norm_key = match key {
        "" | "control" | "alt" | "shift" | "platform" | "meta" | "super" => return None,
        " " | "space" => "Space".to_string(),
        "left" => "ArrowLeft".to_string(),
        "right" => "ArrowRight".to_string(),
        "up" => "ArrowUp".to_string(),
        "down" => "ArrowDown".to_string(),
        "escape" => "Escape".to_string(),
        "enter" => "Enter".to_string(),
        "tab" => "Tab".to_string(),
        "backspace" => "Backspace".to_string(),
        "delete" => "Delete".to_string(),
        other if other.chars().count() == 1 => {
            let ch = other.chars().next().unwrap();
            cyrillic_to_latin(ch)
                .map(str::to_string)
                .unwrap_or_else(|| ch.to_uppercase().collect())
        }
        other => {
            let lower = other.to_lowercase();
            if let Some(rest) = lower.strip_prefix('f').filter(|r| r.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n))) {
                format!("F{rest}")
            } else {
                other.to_string()
            }
        }
    };

    let mut mods = Vec::new();
    if control {
        mods.push("Ctrl".to_string());
    }
    if alt {
        mods.push("Alt".to_string());
    }
    if shift && norm_key != "/" {
        mods.push("Shift".to_string());
    }
    if platform {
        mods.push("Meta".to_string());
    }
    mods.push(norm_key);
    Some(normalize_shortcut(&mods.join("+")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_cyrillic_and_modifiers() {
        assert_eq!(normalize_shortcut("command+shift+д"), "Meta+Shift+L");
        assert_eq!(normalize_shortcut("а"), "F");
        assert!(is_valid_shortcut("Shift+M"));
        assert!(!is_valid_shortcut("Ctrl+Shift"));
    }

    #[test]
    fn keystroke_maps_gpui_keys() {
        assert_eq!(
            shortcut_from_keystroke("m", false, false, true, false),
            Some("Shift+M".into())
        );
        assert_eq!(
            shortcut_from_keystroke("/", false, false, true, false),
            Some("/".into())
        );
    }
}
