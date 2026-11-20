import AVFoundation
import MediaPlayer
import SwiftRs
import Tauri
import UIKit
import WebKit

private struct QueueItemArg: Decodable {
    let id: String
    let title: String
    let artist: String
    let album: String?
    let artworkUrl: String?
    let streamUrl: String
    let durationMs: UInt64
}

private struct SetQueueArgs: Decodable {
    let items: [QueueItemArg]
    let startIndex: Int
    let autoPlay: Bool
    let startPositionMs: UInt64?
}

private struct SeekArgs: Decodable {
    let positionMs: UInt64
}

private struct SkipToArgs: Decodable {
    let index: Int
    let autoPlay: Bool
}

private struct SetEqArgs: Decodable {
    let enabled: Bool
    let gainsDb: [Float]
}

private struct SetAudioConfigArgs: Decodable {
    let normalizationEnabled: Bool
    let normalizationTarget: String
    let crossfadeEnabled: Bool
    let crossfadeDurationMs: UInt64
    let crossfadeCurve: String
}

private struct SetRepeatShuffleArgs: Decodable {
    let repeatMode: String
    let shuffleEnabled: Bool
}

private struct ClearAuthCookiesArgs: Decodable {
    let provider: String
}

private struct AudioStateOut: Encodable {
    let playing: Bool
    let buffering: Bool
    let currentIndex: Int
    let trackId: String?
    let positionMs: UInt64
    let durationMs: UInt64
    let repeatMode: String
    let shuffleEnabled: Bool
}

private struct EmptyOut: Encodable {}

private struct YtAuthOut: Encodable {
    let cookie: String
    let authUser: String
}

private struct ScAuthOut: Encodable {
    let clientId: String
    let token: String
    let datadome: String?
}

class ResonanceMobilePlugin: Plugin {
    private var primaryPlayer = AVPlayer()
    private var secondaryPlayer = AVPlayer()
    private var items: [QueueItemArg] = []
    private var currentIndex: Int = -1
    private var repeatMode: String = "off"
    private var shuffleEnabled: Bool = false

    // Audio DSP / Crossfade configuration
    private var eqEnabled: Bool = false
    private var eqGainsDb: [Float] = [0, 0, 0, 0, 0]
    private var normalizationEnabled: Bool = false
    private var normalizationTarget: String = "normal"
    private var crossfadeEnabled: Bool = false
    private var crossfadeDurationSec: Double = 4.0
    private var crossfadeCurve: String = "equalPower"

    // Crossfade & background runtime state
    private var preloadedIndex: Int = -1
    private var isCrossfading: Bool = false
    private var crossfadeStartTime: TimeInterval = 0
    private var monitorTimer: Timer?
    private var endObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private var routeObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var wasPlayingBeforeInterruption: Bool = false
    private var remoteConfigured = false

    #if os(iOS)
    private var bgTaskId: UIBackgroundTaskIdentifier = .invalid
    private var bgTaskTimeoutTimer: Timer?
    private var cachedArtworkUrl: String?
    private var cachedArtworkImage: UIImage?
    #endif

    override func load(webview: WKWebView) {
        super.load(webview: webview)
        primaryPlayer.automaticallyWaitsToMinimizeStalling = true
        secondaryPlayer.automaticallyWaitsToMinimizeStalling = true
        configureAudioSession()
        configureSystemNotifications()
        configureRemoteCommands()
        observePrimaryPlayerStatus()
    }

    private func configureAudioSession() {
        #if os(iOS)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.allowBluetoothA2DP, .allowAirPlay])
            try session.setActive(true)
        } catch {
            // Re-attempted when playback begins
        }
        #endif
    }

    private func configureSystemNotifications() {
        #if os(iOS)
        if interruptionObserver == nil {
            interruptionObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: AVAudioSession.sharedInstance(),
                queue: .main
            ) { [weak self] notification in
                self?.handleAudioInterruption(notification)
            }
        }
        if routeObserver == nil {
            routeObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: AVAudioSession.sharedInstance(),
                queue: .main
            ) { [weak self] notification in
                self?.handleRouteChange(notification)
            }
        }
        #endif
    }

    #if os(iOS)
    private func handleAudioInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeVal = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeVal) else { return }

        switch type {
        case .began:
            wasPlayingBeforeInterruption = primaryPlayer.timeControlStatus == .playing ||
                primaryPlayer.timeControlStatus == .waitingToPlayAtSpecifiedRate
            if isCrossfading {
                cancelCrossfade(keepPrimaryPlaying: false)
            }
            updateNowPlaying()
        case .ended:
            let optsVal = (info[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
            let opts = AVAudioSession.InterruptionOptions(rawValue: optsVal)
            if opts.contains(.shouldResume) || wasPlayingBeforeInterruption {
                wasPlayingBeforeInterruption = false
                configureAudioSession()
                primaryPlayer.volume = baseVolumeCeiling()
                primaryPlayer.play()
                ensureMonitorRunning()
                updateNowPlaying()
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ notification: Notification) {
        guard let info = notification.userInfo,
              let reasonVal = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonVal) else { return }
        if reason == .oldDeviceUnavailable {
            if isCrossfading {
                cancelCrossfade(keepPrimaryPlaying: false)
            } else {
                primaryPlayer.pause()
            }
            updateNowPlaying()
        }
    }

    private func beginTransitionBackgroundTask() {
        endTransitionBackgroundTask()
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ResonanceAudioTransition") { [weak self] in
            self?.endTransitionBackgroundTask()
        }
        bgTaskTimeoutTimer = Timer.scheduledTimer(withTimeInterval: 22.0, repeats: false) { [weak self] _ in
            self?.endTransitionBackgroundTask()
        }
    }

    private func endTransitionBackgroundTask() {
        bgTaskTimeoutTimer?.invalidate()
        bgTaskTimeoutTimer = nil
        if bgTaskId != .invalid {
            UIApplication.shared.endBackgroundTask(bgTaskId)
            bgTaskId = .invalid
        }
    }
    #endif

    private func observePrimaryPlayerStatus() {
        statusObservation?.invalidate()
        statusObservation = primaryPlayer.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                #if os(iOS)
                if player.timeControlStatus == .playing {
                    self.endTransitionBackgroundTask()
                }
                #endif
                self.updateNowPlaying()
                self.ensureMonitorRunning()
            }
        }
    }

    private func baseVolumeCeiling() -> Float {
        var gain: Float = 1.0
        if normalizationEnabled {
            switch normalizationTarget {
            case "quiet":
                gain = 0.64
            case "loud":
                gain = 1.0
            default:
                gain = 0.88
            }
        }
        if eqEnabled && !eqGainsDb.isEmpty {
            let avgDb = eqGainsDb.reduce(0, +) / Float(eqGainsDb.count)
            if avgDb < -0.5 {
                let factor = powf(10.0, avgDb / 40.0)
                gain = min(1.0, max(0.25, gain * factor))
            }
        }
        return min(1.0, max(0.1, gain))
    }

    private func computeCurveGains(_ progress: Double) -> (Float, Float) {
        let t = min(1.0, max(0.0, progress))
        switch crossfadeCurve {
        case "linear":
            return (Float(1.0 - t), Float(t))
        case "sCurve":
            let s = t * t * (3.0 - 2.0 * t)
            let angle = s * (.pi / 2.0)
            return (Float(cos(angle)), Float(sin(angle)))
        default:
            let angle = t * (.pi / 2.0)
            return (Float(cos(angle)), Float(sin(angle)))
        }
    }

    private func configureRemoteCommands() {
        guard !remoteConfigured else { return }
        remoteConfigured = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.configureAudioSession()
            self.primaryPlayer.volume = self.baseVolumeCeiling()
            self.primaryPlayer.play()
            self.ensureMonitorRunning()
            self.updateNowPlaying()
            return .success
        }
        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.isCrossfading {
                self.cancelCrossfade(keepPrimaryPlaying: false)
            } else {
                self.primaryPlayer.pause()
            }
            self.updateNowPlaying()
            return .success
        }
        center.nextTrackCommand.isEnabled = true
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.stepNext(autoPlay: true)
            return .success
        }
        center.previousTrackCommand.isEnabled = true
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.stepPrev(autoPlay: true)
            return .success
        }
        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self, let posEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            if self.isCrossfading || self.preloadedIndex >= 0 {
                self.cancelCrossfade(keepPrimaryPlaying: self.primaryPlayer.timeControlStatus == .playing)
            }
            let target = CMTime(seconds: posEvent.positionTime, preferredTimescale: 1000)
            self.primaryPlayer.seek(to: target) { _ in
                self.updateNowPlaying()
            }
            return .success
        }
    }

    private func nextQueueIndex() -> Int? {
        guard !items.isEmpty else { return nil }
        if shuffleEnabled && items.count > 1 {
            var candidate = Int.random(in: 0..<items.count)
            if candidate == currentIndex {
                candidate = (currentIndex + 1) % items.count
            }
            return candidate
        }
        if currentIndex + 1 < items.count {
            return currentIndex + 1
        }
        if repeatMode == "all" {
            return 0
        }
        return nil
    }

    private func cancelCrossfade(keepPrimaryPlaying: Bool) {
        isCrossfading = false
        preloadedIndex = -1
        secondaryPlayer.pause()
        secondaryPlayer.replaceCurrentItem(with: nil)
        secondaryPlayer.volume = 0
        primaryPlayer.volume = baseVolumeCeiling()
        if !keepPrimaryPlaying {
            primaryPlayer.pause()
        }
    }

    private func ensureMonitorRunning() {
        let shouldMonitor = isCrossfading ||
            (crossfadeEnabled && crossfadeDurationSec >= 1.0 &&
             (primaryPlayer.timeControlStatus == .playing || primaryPlayer.timeControlStatus == .waitingToPlayAtSpecifiedRate))

        if !shouldMonitor {
            monitorTimer?.invalidate()
            monitorTimer = nil
            return
        }

        let desiredInterval = isCrossfading ? 0.05 : 0.25
        if let existing = monitorTimer, existing.isValid, abs(existing.timeInterval - desiredInterval) < 0.01 {
            return
        }
        monitorTimer?.invalidate()
        monitorTimer = Timer.scheduledTimer(withTimeInterval: desiredInterval, repeats: true) { [weak self] _ in
            self?.tickCrossfadeMonitor()
        }
    }

    private func preloadStandby(at index: Int) {
        guard index >= 0 && index < items.count else { return }
        guard let url = URL(string: items[index].streamUrl) else { return }
        preloadedIndex = index
        let avItem = AVPlayerItem(url: url)
        avItem.preferredForwardBufferDuration = 30.0
        secondaryPlayer.pause()
        secondaryPlayer.volume = 0
        secondaryPlayer.replaceCurrentItem(with: avItem)
    }

    private func beginCrossfadeToStandby() {
        guard preloadedIndex >= 0 && preloadedIndex < items.count else { return }
        guard let incomingItem = secondaryPlayer.currentItem else { return }

        #if os(iOS)
        beginTransitionBackgroundTask()
        #endif
        configureAudioSession()

        let nextIdx = preloadedIndex
        preloadedIndex = -1
        isCrossfading = true
        crossfadeStartTime = ProcessInfo.processInfo.systemUptime

        // Detach end observer from outgoing item and attach to incoming item
        if let obs = endObserver {
            NotificationCenter.default.removeObserver(obs)
            endObserver = nil
        }

        let outgoing = primaryPlayer
        let incoming = secondaryPlayer
        primaryPlayer = incoming
        secondaryPlayer = outgoing
        currentIndex = nextIdx

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: incomingItem,
            queue: .main
        ) { [weak self] _ in
            self?.handleItemEnded()
        }

        observePrimaryPlayerStatus()
        incoming.volume = 0
        incoming.play()
        updateNowPlaying()
        fetchArtworkIfNeeded()
        ensureMonitorRunning()
    }

    private func tickCrossfadeMonitor() {
        if isCrossfading {
            let elapsed = max(0, ProcessInfo.processInfo.systemUptime - crossfadeStartTime)
            let progress = min(1.0, elapsed / max(0.5, crossfadeDurationSec))
            let (outGain, inGain) = computeCurveGains(progress)
            let ceiling = baseVolumeCeiling()
            secondaryPlayer.volume = outGain * ceiling
            primaryPlayer.volume = inGain * ceiling

            if progress >= 1.0 {
                secondaryPlayer.pause()
                secondaryPlayer.replaceCurrentItem(with: nil)
                secondaryPlayer.volume = 0
                primaryPlayer.volume = ceiling
                isCrossfading = false
                ensureMonitorRunning()
            }
            return
        }

        guard crossfadeEnabled, crossfadeDurationSec >= 1.0, repeatMode != "one", items.count > 1 else {
            return
        }
        guard primaryPlayer.timeControlStatus == .playing else { return }

        let rawDur = primaryPlayer.currentItem.map { CMTimeGetSeconds($0.duration) } ?? 0
        let fallbackDur = (currentIndex >= 0 && currentIndex < items.count) ? Double(items[currentIndex].durationMs) / 1000.0 : 0
        let durSec = (rawDur.isFinite && rawDur > 0) ? rawDur : fallbackDur
        let posSec = CMTimeGetSeconds(primaryPlayer.currentTime())
        guard durSec > crossfadeDurationSec + 3.5, posSec.isFinite else { return }

        let remaining = durSec - posSec
        guard let nextIdx = nextQueueIndex() else { return }

        if remaining <= crossfadeDurationSec + 3.5 && remaining > 0 && preloadedIndex != nextIdx {
            preloadStandby(at: nextIdx)
        }
        if remaining <= crossfadeDurationSec && preloadedIndex == nextIdx {
            beginCrossfadeToStandby()
        }
    }

    private func attachItem(at index: Int, autoPlay: Bool, seekMs: UInt64 = 0) {
        guard index >= 0 && index < items.count else { return }
        if isCrossfading || preloadedIndex >= 0 {
            cancelCrossfade(keepPrimaryPlaying: false)
        }
        currentIndex = index
        let tr = items[index]
        guard let url = URL(string: tr.streamUrl) else { return }
        if let obs = endObserver {
            NotificationCenter.default.removeObserver(obs)
            endObserver = nil
        }
        #if os(iOS)
        if autoPlay {
            beginTransitionBackgroundTask()
        }
        #endif
        configureAudioSession()
        let avItem = AVPlayerItem(url: url)
        avItem.preferredForwardBufferDuration = 45.0
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: avItem,
            queue: .main
        ) { [weak self] _ in
            self?.handleItemEnded()
        }
        primaryPlayer.volume = baseVolumeCeiling()
        primaryPlayer.replaceCurrentItem(with: avItem)
        if seekMs > 0 {
            let target = CMTime(value: CMTimeValue(seekMs), timescale: 1000)
            primaryPlayer.seek(to: target)
        }
        if autoPlay {
            primaryPlayer.play()
        } else {
            primaryPlayer.pause()
        }
        updateNowPlaying()
        fetchArtworkIfNeeded()
        ensureMonitorRunning()
    }

    private func handleItemEnded() {
        if repeatMode == "one" {
            primaryPlayer.seek(to: .zero)
            primaryPlayer.play()
            updateNowPlaying()
            return
        }
        stepNext(autoPlay: true)
    }

    private func stepNext(autoPlay: Bool) {
        guard !items.isEmpty else { return }
        if let nextIdx = nextQueueIndex() {
            attachItem(at: nextIdx, autoPlay: autoPlay)
        } else {
            primaryPlayer.pause()
            updateNowPlaying()
        }
    }

    private func stepPrev(autoPlay: Bool) {
        guard !items.isEmpty else { return }
        let posSec = CMTimeGetSeconds(primaryPlayer.currentTime())
        if posSec.isFinite && posSec > 3.5 {
            primaryPlayer.seek(to: .zero)
            if autoPlay { primaryPlayer.play() }
            updateNowPlaying()
            return
        }
        if currentIndex > 0 {
            attachItem(at: currentIndex - 1, autoPlay: autoPlay)
        } else {
            primaryPlayer.seek(to: .zero)
            if autoPlay { primaryPlayer.play() }
            updateNowPlaying()
        }
    }

    private func fetchArtworkIfNeeded() {
        #if os(iOS)
        guard currentIndex >= 0 && currentIndex < items.count else { return }
        guard let rawUrl = items[currentIndex].artworkUrl, !rawUrl.isEmpty, let url = URL(string: rawUrl) else {
            cachedArtworkUrl = nil
            cachedArtworkImage = nil
            return
        }
        if cachedArtworkUrl == rawUrl && cachedArtworkImage != nil {
            return
        }
        cachedArtworkUrl = rawUrl
        cachedArtworkImage = nil
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self, let data = data, let img = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard self.cachedArtworkUrl == rawUrl else { return }
                self.cachedArtworkImage = img
                self.updateNowPlaying()
            }
        }.resume()
        #endif
    }

    private func updateNowPlaying() {
        guard currentIndex >= 0 && currentIndex < items.count else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        let tr = items[currentIndex]
        let posSec = max(0, CMTimeGetSeconds(primaryPlayer.currentTime()))
        let itemDur = primaryPlayer.currentItem.map { CMTimeGetSeconds($0.duration) } ?? 0
        let durSec = (itemDur.isFinite && itemDur > 0) ? itemDur : Double(tr.durationMs) / 1000.0
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: tr.title,
            MPMediaItemPropertyArtist: tr.artist,
            MPMediaItemPropertyPlaybackDuration: durSec,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: posSec.isFinite ? posSec : 0,
            MPNowPlayingInfoPropertyPlaybackRate: primaryPlayer.timeControlStatus == .playing ? 1.0 : 0.0,
        ]
        if let album = tr.album, !album.isEmpty {
            info[MPMediaItemPropertyAlbumTitle] = album
        }
        #if os(iOS)
        if let img = cachedArtworkImage, cachedArtworkUrl == tr.artworkUrl {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        }
        #endif
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func snapshotState() -> AudioStateOut {
        let posSec = CMTimeGetSeconds(primaryPlayer.currentTime())
        let posMs = (posSec.isFinite && posSec > 0) ? UInt64(posSec * 1000.0) : 0
        let rawDur = primaryPlayer.currentItem.map { CMTimeGetSeconds($0.duration) } ?? 0
        let fallbackMs = (currentIndex >= 0 && currentIndex < items.count) ? items[currentIndex].durationMs : 0
        let durMs = (rawDur.isFinite && rawDur > 0) ? UInt64(rawDur * 1000.0) : fallbackMs
        let trackId = (currentIndex >= 0 && currentIndex < items.count) ? items[currentIndex].id : nil

        return AudioStateOut(
            playing: primaryPlayer.timeControlStatus == .playing || primaryPlayer.timeControlStatus == .waitingToPlayAtSpecifiedRate,
            buffering: primaryPlayer.timeControlStatus == .waitingToPlayAtSpecifiedRate,
            currentIndex: currentIndex,
            trackId: trackId,
            positionMs: posMs,
            durationMs: durMs,
            repeatMode: repeatMode,
            shuffleEnabled: shuffleEnabled
        )
    }

    @objc public func setQueue(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SetQueueArgs.self)
        DispatchQueue.main.async {
            if args.items.isEmpty {
                self.cancelCrossfade(keepPrimaryPlaying: false)
                self.primaryPlayer.pause()
                self.primaryPlayer.replaceCurrentItem(with: nil)
                self.items = []
                self.currentIndex = -1
                invoke.resolve(self.snapshotState())
                return
            }

            let safeIdx = min(max(0, args.startIndex), args.items.count - 1)
            // Seamless radio extension without restarting active item
            if self.currentIndex >= 0 &&
                self.currentIndex < self.items.count &&
                safeIdx == self.currentIndex &&
                args.items.count > self.items.count &&
                self.items[self.currentIndex].id == args.items[safeIdx].id {
                self.items = args.items
                invoke.resolve(self.snapshotState())
                return
            }

            self.items = args.items
            self.attachItem(at: safeIdx, autoPlay: args.autoPlay, seekMs: args.startPositionMs ?? 0)
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func installUpdate(_ invoke: Invoke) {
        invoke.reject("iOS installs app updates through the App Store")
    }

    @objc public func play(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.configureAudioSession()
            if !self.isCrossfading {
                self.primaryPlayer.volume = self.baseVolumeCeiling()
            }
            self.primaryPlayer.play()
            self.ensureMonitorRunning()
            self.updateNowPlaying()
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func pause(_ invoke: Invoke) {
        DispatchQueue.main.async {
            if self.isCrossfading {
                self.cancelCrossfade(keepPrimaryPlaying: false)
            } else {
                self.primaryPlayer.pause()
            }
            self.updateNowPlaying()
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func seek(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SeekArgs.self)
        DispatchQueue.main.async {
            if self.isCrossfading || self.preloadedIndex >= 0 {
                self.cancelCrossfade(keepPrimaryPlaying: self.primaryPlayer.timeControlStatus == .playing)
            }
            let target = CMTime(value: CMTimeValue(args.positionMs), timescale: 1000)
            self.primaryPlayer.seek(to: target) { _ in
                self.updateNowPlaying()
                invoke.resolve(self.snapshotState())
            }
        }
    }

    @objc public func skipTo(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SkipToArgs.self)
        DispatchQueue.main.async {
            self.attachItem(at: args.index, autoPlay: args.autoPlay)
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func next(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.stepNext(autoPlay: true)
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func prev(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.stepPrev(autoPlay: true)
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func getState(_ invoke: Invoke) {
        DispatchQueue.main.async {
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func setEq(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SetEqArgs.self)
        DispatchQueue.main.async {
            self.eqEnabled = args.enabled
            self.eqGainsDb = args.gainsDb
            if !self.isCrossfading {
                self.primaryPlayer.volume = self.baseVolumeCeiling()
            }
            invoke.resolve(EmptyOut())
        }
    }

    @objc public func setAudioConfig(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SetAudioConfigArgs.self)
        DispatchQueue.main.async {
            self.normalizationEnabled = args.normalizationEnabled
            self.normalizationTarget = args.normalizationTarget
            let nextXfade = args.crossfadeEnabled && args.crossfadeDurationMs >= 1000
            if self.crossfadeEnabled && !nextXfade && (self.isCrossfading || self.preloadedIndex >= 0) {
                self.cancelCrossfade(keepPrimaryPlaying: self.primaryPlayer.timeControlStatus == .playing)
            }
            self.crossfadeEnabled = nextXfade
            self.crossfadeDurationSec = min(12.0, max(0.0, Double(args.crossfadeDurationMs) / 1000.0))
            self.crossfadeCurve = args.crossfadeCurve
            if !self.isCrossfading {
                self.primaryPlayer.volume = self.baseVolumeCeiling()
            }
            self.ensureMonitorRunning()
            invoke.resolve(EmptyOut())
        }
    }

    @objc public func setRepeatShuffle(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SetRepeatShuffleArgs.self)
        DispatchQueue.main.async {
            self.repeatMode = args.repeatMode
            self.shuffleEnabled = args.shuffleEnabled
            if self.preloadedIndex >= 0 && !self.isCrossfading {
                self.preloadedIndex = -1
                self.secondaryPlayer.replaceCurrentItem(with: nil)
            }
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func clearAuthCookies(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ClearAuthCookiesArgs.self)
        #if os(iOS)
        DispatchQueue.main.async {
            let store = WKWebsiteDataStore.default().httpCookieStore
            store.getAllCookies { cookies in
                for cookie in cookies {
                    let dom = cookie.domain.lowercased()
                    if args.provider.lowercased() == "soundcloud" && dom.contains("soundcloud.com") && cookie.name == "oauth_token" {
                        store.delete(cookie)
                    } else if args.provider.lowercased() == "ytmusic" && dom.contains("youtube.com") {
                        store.delete(cookie)
                    }
                }
                invoke.resolve(EmptyOut())
            }
        }
        #else
        invoke.resolve(EmptyOut())
        #endif
    }

    @objc public func startYtMusicLogin(_ invoke: Invoke) {
        #if os(iOS)
        DispatchQueue.main.async {
            IosAuthSheet.presentYtMusic(invoke: invoke)
        }
        #else
        invoke.reject("Unsupported platform")
        #endif
    }

    @objc public func startSoundCloudLogin(_ invoke: Invoke) {
        #if os(iOS)
        DispatchQueue.main.async {
            IosAuthSheet.presentSoundCloud(invoke: invoke)
        }
        #else
        invoke.reject("Unsupported platform")
        #endif
    }
}

#if os(iOS)
private final class IosAuthSheet: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private let invoke: Invoke
    private let mode: String
    private var webView: WKWebView!
    private var timer: Timer?
    private var settled = false
    private var lastSeenClientId: String = ""

    private init(mode: String, invoke: Invoke) {
        self.mode = mode
        self.invoke = invoke
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var root = scenes.flatMap { $0.windows }.first(where: { $0.isKeyWindow })?.rootViewController
        while let presented = root?.presentedViewController {
            root = presented
        }
        return root
    }

    static func presentYtMusic(invoke: Invoke) {
        guard let host = topController() else {
            invoke.reject("Could not find active iOS view controller")
            return
        }
        let vc = IosAuthSheet(mode: "ytmusic", invoke: invoke)
        let nav = UINavigationController(rootViewController: vc)
        nav.modalPresentationStyle = .pageSheet
        host.present(nav, animated: true)
    }

    static func presentSoundCloud(invoke: Invoke) {
        guard let host = topController() else {
            invoke.reject("Could not find active iOS view controller")
            return
        }
        let vc = IosAuthSheet(mode: "soundcloud", invoke: invoke)
        let nav = UINavigationController(rootViewController: vc)
        nav.modalPresentationStyle = .pageSheet
        host.present(nav, animated: true)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = mode == "ytmusic" ? "YouTube Music" : "SoundCloud"
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .close,
            target: self,
            action: #selector(cancelTapped)
        )

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        if mode == "soundcloud" {
            let contentController = WKUserContentController()
            contentController.add(self, name: "scAuth")
            let script = """
            (function() {
              var seenCid = '';
              function post(cid, tok) {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.scAuth) {
                  window.webkit.messageHandlers.scAuth.postMessage({ clientId: cid || seenCid, token: tok || '' });
                }
              }
              function inspect(rawUrl, authHeader) {
                try {
                  var u = new URL(rawUrl, location.href);
                  if (u.hostname !== 'api-v2.soundcloud.com' && u.hostname !== 'api.soundcloud.com') return;
                  var cid = u.searchParams.get('client_id') || '';
                  if (cid) {
                    seenCid = cid;
                    post(cid, '');
                  }
                  var m = String(authHeader || '').match(/^(?:OAuth|Bearer)\\s+(.+)$/i);
                  var tok = m ? m[1].trim() : '';
                  if (tok) post(cid || seenCid, tok);
                } catch (_) {}
              }
              var origFetch = window.fetch;
              if (typeof origFetch === 'function') {
                window.fetch = function(input, init) {
                  try {
                    var rawUrl = input instanceof Request ? input.url : String(input);
                    var h = new Headers(input instanceof Request ? input.headers : undefined);
                    if (init && init.headers) new Headers(init.headers).forEach(function(v, k) { h.set(k, v); });
                    inspect(rawUrl, h.get('Authorization'));
                  } catch (_) {}
                  return origFetch.apply(this, arguments);
                };
              }
              var origOpen = XMLHttpRequest.prototype.open;
              var origSet = XMLHttpRequest.prototype.setRequestHeader;
              XMLHttpRequest.prototype.open = function(method, url) {
                this.__resUrl = url;
                return origOpen.apply(this, arguments);
              };
              XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                if (String(name).toLowerCase() === 'authorization') {
                  inspect(this.__resUrl, value);
                }
                return origSet.apply(this, arguments);
              };
            })();
            """
            contentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: false)
            )
            config.userContentController = contentController
        }

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
        view.addSubview(webView)

        let urlStr = mode == "ytmusic" ? "https://music.youtube.com/library" : "https://soundcloud.com/signin"
        if let url = URL(string: urlStr) {
            webView.load(URLRequest(url: url))
        }

        timer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if self.mode == "ytmusic" {
                self.checkYtCookies()
            } else {
                self.checkScCookies()
            }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !settled {
            settled = true
            timer?.invalidate()
            invoke.reject("Sign-in cancelled")
        }
    }

    @objc private func cancelTapped() {
        guard !settled else { return }
        settled = true
        timer?.invalidate()
        dismiss(animated: true) { [invoke] in
            invoke.reject("Sign-in cancelled")
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme != "http" && scheme != "https" && scheme != "about" {
            if mode == "soundcloud" {
                checkScCookies()
                if !settled, let discover = URL(string: "https://soundcloud.com/discover") {
                    webView.load(URLRequest(url: discover))
                }
            }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if mode == "ytmusic" {
            checkYtCookies()
        } else {
            checkScCookies()
        }
    }

    private func sanitizeScToken(_ raw: String) -> String {
        let decoded = raw.removingPercentEncoding ?? raw
        return decoded
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\"")))
            .replacingOccurrences(of: "^(?:OAuth|Bearer)\\s+", with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func deliverScCapture(clientId: String, token: String, datadome: String?) {
        guard !settled else { return }
        let cleanTok = sanitizeScToken(token)
        guard cleanTok.count >= 10 else { return }
        let cleanCid = clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? lastSeenClientId
            : clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        settled = true
        timer?.invalidate()
        dismiss(animated: true) { [invoke] in
            invoke.resolve(ScAuthOut(clientId: cleanCid, token: cleanTok, datadome: datadome))
        }
    }

    private func checkScCookies() {
        guard !settled else { return }
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self, !self.settled else { return }
            let scCookies = cookies.filter { $0.domain.lowercased().contains("soundcloud.com") }
            guard let oauthCookie = scCookies.first(where: { $0.name == "oauth_token" && !$0.value.isEmpty }) else {
                return
            }
            let datadome = scCookies.first(where: { $0.name == "datadome" && !$0.value.isEmpty })?.value
            self.deliverScCapture(clientId: self.lastSeenClientId, token: oauthCookie.value, datadome: datadome)
        }
    }

    private func checkYtCookies() {
        guard !settled else { return }
        guard webView.url?.host?.lowercased() == "music.youtube.com" else { return }
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self, !self.settled else { return }
            let relevant = cookies.filter {
                let d = $0.domain.lowercased()
                return d == "music.youtube.com" || d.hasSuffix(".youtube.com") || d == "youtube.com"
            }
            let hasPapisid = relevant.contains { $0.name == "__Secure-3PAPISID" && !$0.value.isEmpty }
            guard hasPapisid else { return }
            self.settled = true
            self.timer?.invalidate()
            let header = relevant.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
            self.dismiss(animated: true) { [invoke = self.invoke] in
                invoke.resolve(YtAuthOut(cookie: header, authUser: "0"))
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !settled, message.name == "scAuth", let dict = message.body as? [String: String] else { return }
        if let cid = dict["clientId"]?.trimmingCharacters(in: .whitespacesAndNewlines), !cid.isEmpty {
            lastSeenClientId = cid
        }
        guard let tok = dict["token"], !tok.isEmpty else { return }
        deliverScCapture(clientId: dict["clientId"] ?? lastSeenClientId, token: tok, datadome: nil)
    }
}
#endif

@_cdecl("init_plugin_resonance_mobile")
func initPlugin() -> Plugin {
    return ResonanceMobilePlugin()
}
