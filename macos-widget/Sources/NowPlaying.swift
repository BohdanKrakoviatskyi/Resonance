import AppKit
import Darwin

/// Snapshot written by the main app; mirrors the JSON contract in docs/macos-widget.md.
struct NowPlayingState: Codable {
    let version: Int
    let title: String
    let artist: String
    let isPlaying: Bool
    let durationSec: Double
    let positionSec: Double
    let updatedAt: Double
    let artworkFile: String?
    let accentColor: String?

    var isIdle: Bool { title.isEmpty }
}

enum NowPlayingStore {
    /// Candidate data directories, most reliable first. The widget runs sandboxed, so
    /// `NSHomeDirectory()` is its own container (always readable). The app mirrors the
    /// snapshot there; the real-home path is a fallback for setups where the container
    /// mirror is unavailable.
    static func widgetDirectories() -> [URL] {
        var dirs: [URL] = []
        let home = NSHomeDirectory()
        if !home.isEmpty {
            dirs.append(URL(fileURLWithPath: home, isDirectory: true)
                .appendingPathComponent("Library/Application Support/Resonance/widget", isDirectory: true))
        }
        if let pw = getpwuid(getuid()), !String(cString: pw.pointee.pw_dir).isEmpty {
            let realHome = String(cString: pw.pointee.pw_dir)
            let url = URL(fileURLWithPath: realHome, isDirectory: true)
                .appendingPathComponent("Library/Application Support/Resonance/widget", isDirectory: true)
            if !dirs.contains(url) {
                dirs.append(url)
            }
        }
        return dirs
    }

    static func load() -> NowPlayingState {
        for dir in widgetDirectories() {
            let url = dir.appendingPathComponent("now_playing.json")
            guard let data = try? Data(contentsOf: url),
                  let state = try? JSONDecoder().decode(NowPlayingState.self, from: data),
                  state.version == 1
            else { continue }
            return state
        }
        return NowPlayingState(
            version: 1, title: "", artist: "", isPlaying: false,
            durationSec: 0, positionSec: 0, updatedAt: 0, artworkFile: nil, accentColor: nil
        )
    }

    static func artwork(named: String?) -> NSImage? {
        guard let named, !named.isEmpty else { return nil }
        // The file name comes from a JSON file the app wrote; still only ever take the
        // last path component and resolve it inside the widget directories.
        let name = (named as NSString).lastPathComponent
        for dir in widgetDirectories() {
            if let data = try? Data(contentsOf: dir.appendingPathComponent(name)) {
                return NSImage(data: data)
            }
        }
        return nil
    }
}
