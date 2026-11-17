use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Window, div, point, px,
};
use gpui_kit_material::color::ColorRole;
use gpui_kit_material::prelude::{LoadingIndicator, SearchField, SearchFieldStyle};
use gpui_kit_material::theme::color;
use resonance_core::i18n::{Key, pick, t};

use crate::assets::ms_icon;
use crate::store::AppStore;
use crate::ui::controls::{
    M3ButtonSize, M3ButtonVariant, M3IconBtnSize, M3IconBtnVariant, m3_button, m3_card, m3_chip,
    m3_icon_button,
};
use crate::ui::track_list::{TrackListProps, render_track_list};
use crate::ui::{argb_to_hsla, rgba_alpha};

/// Inline Search view + results matching `src/pages/Search.tsx` and `.search-bar` in `src/index.css`.
pub fn render_search_page(store: &Entity<AppStore>, window: &mut Window, cx: &mut App) -> AnyElement {
    let (lang, dark, q, inp, loading, sc_results, yt_results, suggestions, err, appearance, lib_hits) = {
        let s = store.read(cx);
        let q = s.search_q.trim().to_string();
        let ql = q.to_lowercase();
        let lib_hits: Vec<_> = if ql.is_empty() {
            Vec::new()
        } else {
            s.library
                .catalog
                .values()
                .filter(|tr| {
                    tr.title.to_lowercase().contains(&ql)
                        || tr.artist.to_lowercase().contains(&ql)
                })
                .take(8)
                .cloned()
                .collect()
        };
        (
            s.lang(),
            s.resolved_theme.dark,
            q,
            s.search_input.clone(),
            s.search_loading,
            s.search_sc_tracks.clone(),
            s.search_yt_tracks.clone(),
            s.search_suggestions.clone(),
            s.search_error.clone(),
            s.appearance.clone(),
            lib_hits,
        )
    };
    let yt_empty = yt_results.is_empty();
    let sc_empty = sc_results.is_empty();

    let ink = color(ColorRole::ON_SURFACE);
    let muted = color(ColorRole::ON_SURFACE_VARIANT);
    let st_close = store.clone();
    let st_retry = store.clone();
    let q_retry = q.clone();

    let header = div()
        .h(px(60.0))
        .pl(px(14.0))
        .pr(px(10.0))
        .rounded(px(30.0))
        .bg(color(ColorRole::SURFACE_CONTAINER_HIGH))
        .shadow(vec![BoxShadow {
            color: rgba_alpha(gpui_kit::rgb(0x000000), 0.42),
            offset: point(px(0.0), px(8.0)),
            blur_radius: px(26.0),
            spread_radius: px(-14.0),
            inset: false,
        }])
        .flex()
        .items_center()
        .gap(px(10.0))
        .child(
            div().flex_1().child(
                SearchField::new(&inp)
                    .id("global-search-field")
                    .field_style(SearchFieldStyle::Tonal),
            ),
        )
        .child(m3_icon_button(
            "search-close",
            "close",
            false,
            M3IconBtnVariant::Standard,
            M3IconBtnSize::Md,
            false,
            false,
            false,
            move |_, cx| {
                st_close.update(cx, |s, cx| s.close_search(cx));
            },
        ));

    let mut page = div().flex().flex_col().gap(px(20.0)).child(header);

    if q.is_empty() {
        let moods = [
            ("Focus & Ambient", "ambient focus instrumental", "#7c6cf0", "spa"),
            ("Late Night Synth", "synthwave night drive", "#e056fd", "nightlight"),
            ("Lo-Fi Study", "lofi chill beats", "#1dd1a1", "headphones"),
            ("Indie Rock", "indie rock alternative", "#ff9f43", "music_note"),
            ("Electronic Club", "electronic house techno", "#48dbfb", "equalizer"),
            ("Acoustic", "acoustic unplugged", "#ff6b6b", "library_music"),
        ];
        let mut grid = div().flex().flex_wrap().gap(px(12.0));
        for (idx, (title, seed_q, hex, ico)) in moods.iter().enumerate() {
            let st_m = store.clone();
            let q_m = (*seed_q).to_string();
            let tint = argb_to_hsla(resonance_core::color_engine::argb_from_hex(hex));
            grid = grid.child(
                div()
                    .id(SharedString::from(format!("browse-card-{idx}")))
                    .relative()
                    .w(px(210.0))
                    .h(px(112.0))
                    .p(px(18.0))
                    .rounded(px(26.0))
                    .overflow_hidden()
                    .bg(rgba_alpha(tint, if dark { 0.28 } else { 0.22 }))
                    .cursor_pointer()
                    .hover(move |st| {
                        st.bg(rgba_alpha(tint, if dark { 0.38 } else { 0.30 }))
                            .rounded(px(32.0))
                    })
                    .on_click(move |_, w, cx| {
                        let q_c = q_m.clone();
                        st_m.update(cx, |s, cx| s.open_search(Some(&q_c), w, cx));
                    })
                    .child(
                        div()
                            .text_size(px(17.0))
                            .font_weight(gpui_kit::FontWeight::BOLD)
                            .text_color(ink)
                            .child(*title),
                    )
                    .child(
                        div()
                            .absolute()
                            .right(px(-6.0))
                            .bottom(px(-10.0))
                            .opacity(0.65)
                            .child(ms_icon(ico, true, 72.0, tint)),
                    ),
            );
        }
        return page
            .child(
                div()
                    .text_size(px(20.0))
                    .font_weight(gpui_kit::FontWeight::BOLD)
                    .text_color(ink)
                    .child(t(lang, Key::Browse)),
            )
            .child(grid)
            .into_any_element();
    }

    // Autocomplete suggestion chips (.chip)
    if !suggestions.is_empty() {
        let mut chips = div().flex().flex_wrap().gap(px(8.0));
        for (i, sug) in suggestions.iter().take(6).enumerate() {
            let st_sug = store.clone();
            let sug_q = sug.clone();
            chips = chips.child(m3_chip(
                SharedString::from(format!("srch-sug-{i}")),
                sug.clone(),
                Some("search"),
                false,
                move |w, cx| {
                    let q_c = sug_q.clone();
                    st_sug.update(cx, |s, cx| s.open_search(Some(&q_c), w, cx));
                },
            ));
        }
        page = page.child(chips);
    }

    // Instant Library Matches
    if !lib_hits.is_empty() {
        let el = render_track_list(
            store,
            TrackListProps {
                id_prefix: "srch-lib".into(),
                tracks: lib_hits,
                context_id: Some("search-lib".into()),
                removable_playlist_id: None,
            },
            window,
            cx,
        );
        page = page
            .child(
                div()
                    .text_size(px(18.0))
                    .font_weight(gpui_kit::FontWeight::BOLD)
                    .text_color(ink)
                    .child(t(lang, Key::InLibrary)),
            )
            .child(el);
    }

    if loading {
        page = page.child(
            div()
                .py(px(36.0))
                .flex()
                .justify_center()
                .child(LoadingIndicator::new("search-spin", "Searching")),
        );
    } else if let Some(msg) = err {
        page = page.child(
            m3_card(&appearance, dark)
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .child(ms_icon("error", true, 22.0, color(ColorRole::ERROR)))
                .child(div().flex_1().text_size(px(14.0)).text_color(muted).child(msg))
                .child(m3_button(
                    "srch-retry",
                    t(lang, Key::Retry),
                    Some("refresh"),
                    M3ButtonVariant::Tonal,
                    M3ButtonSize::Default,
                    false,
                    move |_, cx| {
                        let qc = q_retry.clone();
                        st_retry.update(cx, |s, cx| s.run_search_now(&qc, cx));
                    },
                )),
        );
    } else {
        if !yt_results.is_empty() {
            let el = render_track_list(
                store,
                TrackListProps {
                    id_prefix: "srch-yt".into(),
                    tracks: yt_results,
                    context_id: Some("search-yt".into()),
                    removable_playlist_id: None,
                },
                window,
                cx,
            );
            page = page
                .child(
                    div()
                        .text_size(px(18.0))
                        .font_weight(gpui_kit::FontWeight::BOLD)
                        .text_color(ink)
                        .child("YouTube Music"),
                )
                .child(el);
        }

        if !sc_results.is_empty() {
            let el = render_track_list(
                store,
                TrackListProps {
                    id_prefix: "srch-sc".into(),
                    tracks: sc_results,
                    context_id: Some("search-sc".into()),
                    removable_playlist_id: None,
                },
                window,
                cx,
            );
            page = page
                .child(
                    div()
                        .text_size(px(18.0))
                        .font_weight(gpui_kit::FontWeight::BOLD)
                        .text_color(ink)
                        .child(t(lang, Key::FullTracks)),
                )
                .child(el);
        }

        if yt_empty && sc_empty {
            page = page.child(
                m3_card(&appearance, dark)
                    .p(px(32.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(8.0))
                    .child(ms_icon("search", false, 36.0, muted))
                    .child(
                        div()
                            .text_size(px(17.0))
                            .font_weight(gpui_kit::FontWeight::BOLD)
                            .text_color(ink)
                            .child(t(lang, Key::NoResults)),
                    )
                    .child(
                        div()
                            .text_size(px(14.0))
                            .text_color(muted)
                            .child(pick(
                                lang,
                                "Попробуйте другой запрос",
                                "Try a different search",
                            )),
                    ),
            );
        }
    }

    page.into_any_element()
}
