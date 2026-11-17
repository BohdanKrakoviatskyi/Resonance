import SwiftUI
import WidgetKit

struct NowPlayingEntry: TimelineEntry {
    let date: Date
    let state: NowPlayingState
    let artwork: NSImage?
}

struct ResonanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> NowPlayingEntry {
        entry()
    }

    func getSnapshot(in context: Context, completion: @escaping (NowPlayingEntry) -> Void) {
        completion(entry())
    }

    /// The app pushes fresh state via WidgetCenter.reloadAllTimelines(); the timeline is a
    /// static snapshot with a modest fallback refresh for when the app has been closed.
    /// Elapsed time and the progress bar animate on their own via timerInterval views.
    func getTimeline(in context: Context, completion: @escaping (Timeline<NowPlayingEntry>) -> Void) {
        let refresh = Calendar.current.date(byAdding: .minute, value: 15, to: Date())
            ?? Date().addingTimeInterval(900)
        completion(Timeline(entries: [entry()], policy: .after(refresh)))
    }

    private func entry() -> NowPlayingEntry {
        let state = NowPlayingStore.load()
        return NowPlayingEntry(date: Date(), state: state, artwork: NowPlayingStore.artwork(named: state.artworkFile))
    }
}

// MARK: - Localization (the app ships ru/en only)

private func localized(_ ru: String, _ en: String) -> String {
    let lang = Locale.preferredLanguages.first ?? "en"
    return lang.hasPrefix("ru") ? ru : en
}

// MARK: - Theme

private extension Color {
    init(widgetHex hex: String?) {
        if let hex, hex.count == 7, hex.hasPrefix("#"), let value = Int(hex.dropFirst(), radix: 16) {
            self.init(
                red: Double((value >> 16) & 0xFF) / 255,
                green: Double((value >> 8) & 0xFF) / 255,
                blue: Double(value & 0xFF) / 255
            )
        } else {
            // M3 default primary #6750A4
            self.init(red: 0.404, green: 0.314, blue: 0.643)
        }
    }
}

// MARK: - Progress helpers

private func progressFraction(_ state: NowPlayingState) -> Double {
    guard state.durationSec > 0 else { return 0 }
    return min(1, max(0, state.positionSec / state.durationSec))
}

private func format(seconds: Double) -> String {
    let total = Int(max(0, seconds.rounded()))
    return String(format: "%d:%02d", total / 60, total % 60)
}

// MARK: - Background (full-bleed artwork with a bottom scrim)

private struct ArtworkBackground: View {
    let artwork: NSImage?
    let accent: Color

    var body: some View {
        GeometryReader { geo in
            if let artwork, let cg = artwork.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                Image(decorative: cg, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
            } else {
                ZStack {
                    LinearGradient(
                        colors: [Color(white: 0.16), Color(white: 0.07)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                    Image(systemName: "music.note")
                        .font(.system(size: geo.size.height * 0.4, weight: .light))
                        .foregroundStyle(.white.opacity(0.10))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                        .padding(12)
                }
            }
        }
        .overlay(
            LinearGradient(
                colors: [.black.opacity(0.02), .black.opacity(0.34), .black.opacity(0.72)],
                startPoint: .top, endPoint: .bottom
            )
        )
    }
}

// MARK: - Overlay pieces

private struct TrackText: View {
    let title: String
    let artist: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.headline)
                .lineLimit(1)
            Text(artist)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.72))
                .lineLimit(1)
        }
        .foregroundStyle(.white)
        .shadow(color: .black.opacity(0.55), radius: 3, y: 1)
    }
}

private struct PlayStateIcon: View {
    let isPlaying: Bool

    var body: some View {
        Image(systemName: isPlaying ? "pause.fill" : "play.fill")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(.white.opacity(0.92))
            .shadow(color: .black.opacity(0.5), radius: 2, y: 1)
    }
}

/// Live while playing (system-driven), frozen at the snapshot while paused.
private struct ProgressRow: View {
    let state: NowPlayingState
    let accent: Color
    let showsTimes: Bool

    var body: some View {
        HStack(spacing: 8) {
            if showsTimes, state.durationSec > 0 {
                elapsedText
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.85))
                    .shadow(color: .black.opacity(0.5), radius: 2, y: 1)
            }

            progressBar
                .frame(height: 4)

            if showsTimes, state.durationSec > 0 {
                Text(format(seconds: state.durationSec))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.85))
                    .shadow(color: .black.opacity(0.5), radius: 2, y: 1)
            }
        }
    }

    @ViewBuilder
    private var progressBar: some View {
        if state.durationSec <= 0 {
            Capsule().fill(.white.opacity(0.25))
        } else if state.isPlaying, let interval = playingInterval {
            ProgressView(timerInterval: interval, countsDown: false) { }
                .progressViewStyle(.linear)
                .tint(accent)
        } else {
            ProgressView(value: progressFraction(state)) { }
                .progressViewStyle(.linear)
                .tint(accent)
        }
    }

    /// While playing, anchor the interval to wall clock so the bar keeps moving
    /// between timeline reloads; clamp so a stale snapshot never overruns the track.
    private var playingInterval: ClosedRange<Date>? {
        let duration = max(0, state.durationSec)
        guard duration > 0 else { return nil }
        let position = min(max(0, state.positionSec), duration)
        let anchor = Date(timeIntervalSince1970: state.updatedAt > 0 ? state.updatedAt : Date().timeIntervalSince1970)
        let start = anchor.addingTimeInterval(-position)
        let end = start.addingTimeInterval(duration)
        let now = Date()
        guard end > now else { return nil }
        return start...max(start.addingTimeInterval(1), min(end, now.addingTimeInterval(duration)))
    }

    private var elapsedText: Text {
        if state.isPlaying, let interval = playingInterval {
            return Text(timerInterval: interval, countsDown: false)
        }
        return Text(format(seconds: state.positionSec))
    }
}

// MARK: - Layouts

private struct CompactOverlay: View {
    let entry: NowPlayingEntry
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Spacer(minLength: 0)
            TrackText(title: entry.state.title, artist: entry.state.artist)
            HStack(spacing: 8) {
                ProgressRow(state: entry.state, accent: accent, showsTimes: false)
                PlayStateIcon(isPlaying: entry.state.isPlaying)
            }
        }
    }
}

private struct RoomyOverlay: View {
    let entry: NowPlayingEntry
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Spacer(minLength: 0)
            HStack(alignment: .top) {
                TrackText(title: entry.state.title, artist: entry.state.artist)
                Spacer(minLength: 12)
                PlayStateIcon(isPlaying: entry.state.isPlaying)
                    .padding(.top, 3)
            }
            ProgressRow(state: entry.state, accent: accent, showsTimes: true)
        }
    }
}

private struct IdleView: View {
    var body: some View {
        VStack(spacing: 6) {
            Spacer(minLength: 0)
            Image(systemName: "music.note")
                .font(.system(size: 24, weight: .medium))
            Text("Resonance")
                .font(.headline)
            Text(localized("Музыка не играет", "Nothing playing"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct NowPlayingContentView: View {
    let entry: NowPlayingEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let accent = Color(widgetHex: entry.state.accentColor)
        Group {
            if entry.state.isIdle {
                IdleView()
            } else {
                switch family {
                case .systemSmall:
                    CompactOverlay(entry: entry, accent: accent)
                        .padding(12)
                default:
                    RoomyOverlay(entry: entry, accent: accent)
                        .padding(14)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .containerBackground(for: .widget) {
            if entry.state.isIdle {
                ZStack {
                    LinearGradient(
                        colors: [Color(white: 0.14), Color(white: 0.08)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                    IdleView()
                        .foregroundStyle(.white)
                }
            } else {
                ArtworkBackground(artwork: entry.artwork, accent: accent)
            }
        }
    }
}

struct ResonanceWidget: Widget {
    let kind = "ResonanceNowPlaying"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ResonanceProvider()) { entry in
            NowPlayingContentView(entry: entry)
        }
        .configurationDisplayName("Resonance")
        .description(localized(
            "Текущий трек Resonance",
            "The track currently playing in Resonance"
        ))
        .supportedFamilies([.systemSmall])
    }
}
