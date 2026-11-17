pub mod appearance;
pub mod audio_settings;
pub mod collection;
pub mod home;
pub mod providers;
pub mod search;
pub mod settings;
pub mod shortcuts;

use gpui_kit::{
    AnyElement, App, Entity, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, Window, div, px,
};
use resonance_core::models::Route;

use crate::store::AppStore;

pub fn render_center_page(store: &Entity<AppStore>, window: &mut Window, cx: &mut App) -> AnyElement {
    let s = store.read(cx);
    let search_open = s.search_open;
    let route = s.route.clone();
    let vw = f32::from(window.viewport_size().width);
    let compact = vw < 768.0;
    let side_pad = (vw * 0.03).clamp(16.0, 40.0);

    let inner = if search_open {
        search::render_search_page(store, window, cx)
    } else {
        match route {
            Route::Home => home::render_home_page(store, window, cx),
            Route::Favorites => collection::render_favorites_page(store, window, cx),
            Route::Playlist(id) => collection::render_playlist_page(store, &id, window, cx),
            Route::Settings => settings::render_settings_page(store, window, cx),
            Route::Appearance => appearance::render_appearance_page(store, window, cx),
            Route::Providers => providers::render_providers_page(store, window, cx),
            Route::Audio => audio_settings::render_audio_page(store, window, cx),
            Route::Shortcuts => shortcuts::render_shortcuts_page(store, window, cx),
        }
    };

    div()
        .id("center-scroll")
        .size_full()
        .overflow_y_scroll()
        .pt(px(if compact { 56.0 } else { 16.0 }))
        .pb(px(150.0))
        .child(
            div()
                .w_full()
                .max_w(px(1280.0))
                .mx_auto()
                .pt(px(8.0))
                .px(px(side_pad))
                .child(inner),
        )
        .into_any_element()
}
