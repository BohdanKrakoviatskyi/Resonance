import Foundation
import WidgetKit

/// Called from Rust (src-tauri/src/macos_widget.rs) after now_playing.json changes.
/// WidgetCenter is only reachable from Swift, hence this tiny bridge.
@_cdecl("resonance_widget_reload")
public func resonance_widget_reload() -> Int32 {
    WidgetCenter.shared.reloadAllTimelines()
    return 0
}
