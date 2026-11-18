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

private struct SetRepeatShuffleArgs: Decodable {
    let repeatMode: String
    let shuffleEnabled: Bool
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
}

class ResonanceMobilePlugin: Plugin {
    private var player = AVPlayer()
    private var items: [QueueItemArg] = []
    private var currentIndex: Int = -1
    private var repeatMode: String = "off"
    private var shuffleEnabled: Bool = false
    private var endObserver: NSObjectProtocol?
    private var remoteConfigured = false

    override func load(webview: WKWebView) {
        super.load(webview: webview)
        configureAudioSession()
        configureRemoteCommands()
    }

    private func configureAudioSession() {
        #if os(iOS)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            // Re-attempted when playback begins
        }
        #endif
    }

    private func configureRemoteCommands() {
        guard !remoteConfigured else { return }
        remoteConfigured = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.configureAudioSession()
            self.player.play()
            self.updateNowPlaying()
            return .success
        }
        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.player.pause()
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
            let target = CMTime(seconds: posEvent.positionTime, preferredTimescale: 1000)
            self.player.seek(to: target) { _ in
                self.updateNowPlaying()
            }
            return .success
        }
    }

    private func attachItem(at index: Int, autoPlay: Bool, seekMs: UInt64 = 0) {
        guard index >= 0 && index < items.count else { return }
        currentIndex = index
        let tr = items[index]
        guard let url = URL(string: tr.streamUrl) else { return }
        if let obs = endObserver {
            NotificationCenter.default.removeObserver(obs)
            endObserver = nil
        }
        configureAudioSession()
        let avItem = AVPlayerItem(url: url)
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: avItem,
            queue: .main
        ) { [weak self] _ in
            self?.handleItemEnded()
        }
        player.replaceCurrentItem(with: avItem)
        if seekMs > 0 {
            let target = CMTime(value: CMTimeValue(seekMs), timescale: 1000)
            player.seek(to: target)
        }
        if autoPlay {
            player.play()
        } else {
            player.pause()
        }
        updateNowPlaying()
    }

    private func handleItemEnded() {
        if repeatMode == "one" {
            player.seek(to: .zero)
            player.play()
            updateNowPlaying()
            return
        }
        stepNext(autoPlay: true)
    }

    private func stepNext(autoPlay: Bool) {
        guard !items.isEmpty else { return }
        if shuffleEnabled && items.count > 1 {
            let nextIdx = Int.random(in: 0..<items.count)
            attachItem(at: nextIdx, autoPlay: autoPlay)
            return
        }
        if currentIndex + 1 < items.count {
            attachItem(at: currentIndex + 1, autoPlay: autoPlay)
        } else if repeatMode == "all" {
            attachItem(at: 0, autoPlay: autoPlay)
        } else {
            player.pause()
            updateNowPlaying()
        }
    }

    private func stepPrev(autoPlay: Bool) {
        guard !items.isEmpty else { return }
        let posSec = CMTimeGetSeconds(player.currentTime())
        if posSec.isFinite && posSec > 3.5 {
            player.seek(to: .zero)
            if autoPlay { player.play() }
            updateNowPlaying()
            return
        }
        if currentIndex > 0 {
            attachItem(at: currentIndex - 1, autoPlay: autoPlay)
        } else {
            player.seek(to: .zero)
            if autoPlay { player.play() }
            updateNowPlaying()
        }
    }

    private func updateNowPlaying() {
        guard currentIndex >= 0 && currentIndex < items.count else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        let tr = items[currentIndex]
        let posSec = max(0, CMTimeGetSeconds(player.currentTime()))
        let itemDur = player.currentItem.map { CMTimeGetSeconds($0.duration) } ?? 0
        let durSec = (itemDur.isFinite && itemDur > 0) ? itemDur : Double(tr.durationMs) / 1000.0
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: tr.title,
            MPMediaItemPropertyArtist: tr.artist,
            MPMediaItemPropertyPlaybackDuration: durSec,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: posSec.isFinite ? posSec : 0,
            MPNowPlayingInfoPropertyPlaybackRate: player.timeControlStatus == .playing ? 1.0 : 0.0,
        ]
        if let album = tr.album, !album.isEmpty {
            info[MPMediaItemPropertyAlbumTitle] = album
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func snapshotState() -> AudioStateOut {
        let posSec = CMTimeGetSeconds(player.currentTime())
        let posMs = (posSec.isFinite && posSec > 0) ? UInt64(posSec * 1000.0) : 0
        let rawDur = player.currentItem.map { CMTimeGetSeconds($0.duration) } ?? 0
        let fallbackMs = (currentIndex >= 0 && currentIndex < items.count) ? items[currentIndex].durationMs : 0
        let durMs = (rawDur.isFinite && rawDur > 0) ? UInt64(rawDur * 1000.0) : fallbackMs
        let trackId = (currentIndex >= 0 && currentIndex < items.count) ? items[currentIndex].id : nil

        return AudioStateOut(
            playing: player.timeControlStatus == .playing || player.timeControlStatus == .waitingToPlayAtSpecifiedRate,
            buffering: player.timeControlStatus == .waitingToPlayAtSpecifiedRate,
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
            self.items = args.items
            if args.items.isEmpty {
                self.player.pause()
                self.player.replaceCurrentItem(with: nil)
                self.currentIndex = -1
                invoke.resolve(self.snapshotState())
                return
            }
            let safeIdx = min(max(0, args.startIndex), args.items.count - 1)
            self.attachItem(at: safeIdx, autoPlay: args.autoPlay, seekMs: args.startPositionMs ?? 0)
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func play(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.configureAudioSession()
            self.player.play()
            self.updateNowPlaying()
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func pause(_ invoke: Invoke) {
        DispatchQueue.main.async {
            self.player.pause()
            self.updateNowPlaying()
            invoke.resolve(self.snapshotState())
        }
    }

    @objc public func seek(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SeekArgs.self)
        DispatchQueue.main.async {
            let target = CMTime(value: CMTimeValue(args.positionMs), timescale: 1000)
            self.player.seek(to: target) { _ in
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
        _ = try invoke.parseArgs(SetEqArgs.self)
        invoke.resolve(EmptyOut())
    }

    @objc public func setRepeatShuffle(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SetRepeatShuffleArgs.self)
        DispatchQueue.main.async {
            self.repeatMode = args.repeatMode
            self.shuffleEnabled = args.shuffleEnabled
            invoke.resolve(self.snapshotState())
        }
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
              function inspect(rawUrl, authHeader) {
                try {
                  var u = new URL(rawUrl, location.href);
                  if (u.hostname !== 'api-v2.soundcloud.com') return;
                  var cid = u.searchParams.get('client_id') || '';
                  var m = String(authHeader || '').match(/^(?:OAuth|Bearer)\\s+(.+)$/i);
                  var tok = m ? m[1] : '';
                  if (cid && tok && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.scAuth) {
                    window.webkit.messageHandlers.scAuth.postMessage({ clientId: cid, token: tok });
                  }
                } catch (_) {}
              }
              var origFetch = window.fetch;
              window.fetch = function(input, init) {
                try {
                  var rawUrl = input instanceof Request ? input.url : String(input);
                  var h = new Headers(input instanceof Request ? input.headers : undefined);
                  if (init && init.headers) new Headers(init.headers).forEach(function(v, k) { h.set(k, v); });
                  inspect(rawUrl, h.get('Authorization'));
                } catch (_) {}
                return origFetch.apply(this, arguments);
              };
            })();
            """
            contentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
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

        if mode == "ytmusic" {
            timer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
                self?.checkYtCookies()
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
        guard let cid = dict["clientId"], let tok = dict["token"], !cid.isEmpty, !tok.isEmpty else { return }
        settled = true
        timer?.invalidate()
        dismiss(animated: true) { [invoke] in
            invoke.resolve(ScAuthOut(clientId: cid, token: tok))
        }
    }
}
#endif

@_cdecl("init_plugin_resonance_mobile")
func initPlugin() -> Plugin {
    return ResonanceMobilePlugin()
}
