package com.resonance.mobile.plugin

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.audiofx.DynamicsProcessing
import android.media.audiofx.Equalizer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionToken
import app.tauri.plugin.JSObject
import org.json.JSONArray
import java.util.concurrent.Future
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

data class NativeQueueTrack(
    val id: String,
    val title: String,
    val artist: String,
    val album: String?,
    val artworkUrl: String?,
    val streamUrl: String,
    val durationMs: Long
)

private class DeckDsp {
    var sessionId: Int = C.AUDIO_SESSION_ID_UNSET
    var dynamicsProcessing: DynamicsProcessing? = null
    var legacyEqualizer: Equalizer? = null

    fun release() {
        runCatching { dynamicsProcessing?.release() }
        dynamicsProcessing = null
        runCatching { legacyEqualizer?.release() }
        legacyEqualizer = null
        sessionId = C.AUDIO_SESSION_ID_UNSET
    }
}

object ResonanceAudioController {
    private const val MIN_BUFFER_MS = 15_000
    private const val MAX_BUFFER_MS = 45_000
    private const val BUFFER_FOR_PLAYBACK_MS = 1_200
    private const val BUFFER_FOR_REBUFFER_MS = 2_500
    private const val BACK_BUFFER_MS = 10_000

    private val mainHandler = Handler(Looper.getMainLooper())
    private var appContext: Context? = null

    private var primaryPlayer: ExoPlayer? = null
    private var secondaryPlayer: ExoPlayer? = null
    private val primaryDsp = DeckDsp()
    private val secondaryDsp = DeckDsp()
    private var primaryIsDeckA = true

    private var mediaSession: MediaSession? = null
    private var controllerFuture: Future<MediaController>? = null

    private var wakeLock: PowerManager.WakeLock? = null

    private var queueTracks: List<NativeQueueTrack> = emptyList()
    private var currentMediaItems: List<MediaItem> = emptyList()
    private var repeatModeState: Int = Player.REPEAT_MODE_OFF
    private var shuffleState: Boolean = false
    private var lastError: String? = null
    private var consecutiveErrors: Int = 0

    // DSP & Audio Settings
    private var eqEnabled: Boolean = false
    private var eqGainsDb: FloatArray = floatArrayOf(0f, 0f, 0f, 0f, 0f)
    private var normalizationEnabled: Boolean = false
    private var normalizationTarget: String = "normal" // quiet | normal | loud
    private var crossfadeEnabled: Boolean = false
    private var crossfadeDurationMs: Long = 4_000L
    private var crossfadeCurve: String = "equalPower" // linear | equalPower | sCurve

    // Dual-deck crossfade runtime state
    private var preloadedIndex: Int = C.INDEX_UNSET
    private var isCrossfading: Boolean = false
    private var crossfadeStartRealtimeMs: Long = 0L
    private var outgoingPlayer: ExoPlayer? = null
    private var incomingPlayer: ExoPlayer? = null
    private var monitorScheduled: Boolean = false

    private val eqCutoffHz = floatArrayOf(120f, 500f, 1800f, 7500f, 20000f)

    private val crossfadeMonitorRunnable = object : Runnable {
        override fun run() {
            monitorScheduled = false
            tickCrossfadeMonitor()
        }
    }

    fun runOnMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action()
        } else {
            mainHandler.post(action)
        }
    }

    fun getMediaSession(context: Context): MediaSession {
        ensureInitialized(context.applicationContext)
        return mediaSession!!
    }

    private fun dspForDeck(isDeckA: Boolean): DeckDsp =
        if (isDeckA) primaryDsp else secondaryDsp

    private fun secondaryDeck(): ExoPlayer? {
        secondaryPlayer?.let { return it }
        val ctx = appContext ?: return null
        val deck = buildDeck(ctx, isDeckA = !primaryIsDeckA)
        secondaryPlayer = deck
        return deck
    }

    private fun buildDeck(ctx: Context, isDeckA: Boolean): ExoPlayer {
        val httpFactory = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(10_000)
            .setReadTimeoutMs(20_000)
            .setUserAgent("ResonanceMobile/0.1")

        val mediaSourceFactory = DefaultMediaSourceFactory(ctx)
            .setDataSourceFactory(httpFactory)

        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                MIN_BUFFER_MS,
                MAX_BUFFER_MS,
                BUFFER_FOR_PLAYBACK_MS,
                BUFFER_FOR_REBUFFER_MS
            )
            .setBackBuffer(BACK_BUFFER_MS, true)
            .build()

        val audioAttrs = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        // Only primary audio focus should pause on noisy; we keep audio focus managed on active deck.
        val player = ExoPlayer.Builder(ctx)
            .setMediaSourceFactory(mediaSourceFactory)
            .setLoadControl(loadControl)
            .setAudioAttributes(audioAttrs, false)
            .setHandleAudioBecomingNoisy(true)
            .build()

        val deckDsp = dspForDeck(isDeckA)

        player.addListener(object : Player.Listener {
            override fun onAudioSessionIdChanged(audioSessionId: Int) {
                attachDspIfNeeded(deckDsp, audioSessionId)
                if (!isCrossfading && player === primaryPlayer) {
                    player.volume = fallbackVolumeCeiling(deckDsp)
                }
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                if (player === primaryPlayer) {
                    if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) {
                        lastError = null
                    }
                    preloadedIndex = C.INDEX_UNSET
                    syncWakeLocks()
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (player === primaryPlayer) {
                    syncWakeLocks()
                    scheduleMonitorIfNeeded()
                }
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (player === primaryPlayer) {
                    if (!playWhenReady && isCrossfading) {
                        cancelCrossfade(keepPrimaryPlaying = false)
                    }
                    syncWakeLocks()
                    scheduleMonitorIfNeeded()
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (player === primaryPlayer) {
                    if (isPlaying) {
                        consecutiveErrors = 0
                    }
                    syncWakeLocks()
                    scheduleMonitorIfNeeded()
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (player !== primaryPlayer) {
                    // Preloaded standby deck failed: just reset preload so normal transition handles it.
                    preloadedIndex = C.INDEX_UNSET
                    runCatching {
                        player.stop()
                        player.clearMediaItems()
                    }
                    return
                }
                if (isCrossfading) {
                    cancelCrossfade(keepPrimaryPlaying = false)
                }
                lastError = error.localizedMessage ?: "Audio stream failed (${error.errorCodeName})"
                consecutiveErrors += 1
                if (consecutiveErrors <= 3 && player.mediaItemCount > 1 && player.hasNextMediaItem()) {
                    player.seekToNextMediaItem()
                    player.prepare()
                    player.play()
                }
                syncWakeLocks()
            }
        })

        if (player.audioSessionId != C.AUDIO_SESSION_ID_UNSET) {
            attachDspIfNeeded(deckDsp, player.audioSessionId)
        }
        return player
    }

    private fun ensureInitialized(context: Context): ExoPlayer {
        val ctx = context.applicationContext
        appContext = ctx
        primaryPlayer?.let {
            ensureControllerBound(ctx)
            return it
        }

        initWakeLocks(ctx)

        val deckA = buildDeck(ctx, isDeckA = true)
        primaryPlayer = deckA
        primaryIsDeckA = true

        // Enable automatic audio focus handling on active primary player
        val focusAttrs = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()
        deckA.setAudioAttributes(focusAttrs, true)

        val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val sessionActivity = launchIntent?.let {
            PendingIntent.getActivity(
                ctx,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        val sessionBuilder = MediaSession.Builder(ctx, deckA)
            .setId("resonance_mobile_media_session")
        if (sessionActivity != null) {
            sessionBuilder.setSessionActivity(sessionActivity)
        }

        mediaSession = sessionBuilder.build()
        ensureControllerBound(ctx)
        return deckA
    }

    private fun initWakeLocks(ctx: Context) {
        if (wakeLock == null) {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ResonanceMobile::AudioPlayback")?.apply {
                setReferenceCounted(false)
            }
        }
    }

    private fun isActivelyPlayingOrBuffering(): Boolean {
        val p = primaryPlayer ?: return false
        if (isCrossfading) return true
        return p.playWhenReady && (p.playbackState == Player.STATE_BUFFERING || p.playbackState == Player.STATE_READY)
    }

    private fun syncWakeLocks() {
        if (isActivelyPlayingOrBuffering()) {
            runCatching {
                if (wakeLock?.isHeld == false) {
                    wakeLock?.acquire()
                }
            }
        } else {
            runCatching {
                if (wakeLock?.isHeld == true) {
                    wakeLock?.release()
                }
            }
        }
    }

    /**
     * Connects a Media3 MediaController to ResonancePlaybackService.
     * In Media3, binding a MediaController to the MediaSessionService's SessionToken is what
     * triggers MediaNotificationManager to post the MediaStyle notification and promote the
     * service via startForeground(..., FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK).
     */
    private fun ensureControllerBound(context: Context) {
        val existing = controllerFuture
        if (existing != null && !existing.isCancelled) {
            if (!existing.isDone) return
            val ok = runCatching { existing.get()?.isConnected == true }.getOrDefault(false)
            if (ok) return
        }
        runCatching {
            val token = SessionToken(
                context.applicationContext,
                ComponentName(context.applicationContext, ResonancePlaybackService::class.java)
            )
            controllerFuture = MediaController.Builder(context.applicationContext, token).buildAsync()
        }
    }

    private fun ensureServiceStarted(context: Context) {
        val ctx = context.applicationContext
        ensureControllerBound(ctx)
        runCatching {
            val intent = Intent(ctx, ResonancePlaybackService::class.java)
            ctx.startService(intent)
        }
        syncWakeLocks()
    }

    /* ---------------- DSP: 5-Band Equalizer + Loudness Normalization ---------------- */

    private fun fallbackVolumeCeiling(dsp: DeckDsp): Float {
        if (!normalizationEnabled || dsp.dynamicsProcessing != null) return 1.0f
        return when (normalizationTarget) {
            "quiet" -> 0.65f
            "loud" -> 1.0f
            else -> 0.88f
        }
    }

    private fun attachDspIfNeeded(dsp: DeckDsp, sessionId: Int) {
        if (sessionId == C.AUDIO_SESSION_ID_UNSET || sessionId <= 0) return
        if (sessionId != dsp.sessionId) {
            dsp.release()
            dsp.sessionId = sessionId
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                runCatching {
                    val config = DynamicsProcessing.Config.Builder(
                        DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
                        1,
                        false,
                        0,
                        true,
                        1,
                        true,
                        5,
                        true
                    ).build()
                    val dp = DynamicsProcessing(0, sessionId, config)
                    dsp.dynamicsProcessing = dp
                }.onFailure {
                    dsp.dynamicsProcessing = null
                }
            }
            if (dsp.dynamicsProcessing == null) {
                runCatching {
                    dsp.legacyEqualizer = Equalizer(0, sessionId)
                }.onFailure {
                    dsp.legacyEqualizer = null
                }
            }
        }
        applyDspConfig(dsp)
    }

    private fun applyDspToAllDecks() {
        if (primaryDsp.sessionId != C.AUDIO_SESSION_ID_UNSET) {
            applyDspConfig(primaryDsp)
        }
        if (secondaryDsp.sessionId != C.AUDIO_SESSION_ID_UNSET) {
            applyDspConfig(secondaryDsp)
        }
        if (!isCrossfading) {
            val activeDsp = dspForDeck(primaryIsDeckA)
            primaryPlayer?.volume = fallbackVolumeCeiling(activeDsp)
        }
    }

    private fun applyDspConfig(dsp: DeckDsp) {
        val eqActive = eqEnabled && eqGainsDb.any { abs(it) > 0.05f }
        val normActive = normalizationEnabled
        val anyDspActive = eqActive || normActive

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            dsp.dynamicsProcessing?.let { dp ->
                runCatching {
                    // 1. Input gain + Multi-Band Compressor for LUFS target
                    val inputGainDb: Float
                    val mbcRatio: Float
                    val mbcThresholdDb: Float
                    val mbcPostGainDb: Float
                    val limiterCeilingDb: Float

                    when {
                        !normActive -> {
                            inputGainDb = 0f
                            mbcRatio = 1.0f
                            mbcThresholdDb = -6.0f
                            mbcPostGainDb = 0f
                            limiterCeilingDb = -0.8f
                        }
                        normalizationTarget == "quiet" -> {
                            // -18 LUFS target: gentle attenuation + soft peak control
                            inputGainDb = -4.2f
                            mbcRatio = 1.6f
                            mbcThresholdDb = -16.0f
                            mbcPostGainDb = -0.5f
                            limiterCeilingDb = -1.5f
                        }
                        normalizationTarget == "loud" -> {
                            // -11 LUFS target: upward makeup + firm dynamic leveling + brickwall limiter
                            inputGainDb = 3.8f
                            mbcRatio = 2.8f
                            mbcThresholdDb = -18.0f
                            mbcPostGainDb = 1.6f
                            limiterCeilingDb = -0.8f
                        }
                        else -> {
                            // "normal" (-14 LUFS target): balanced streaming loudness
                            inputGainDb = 1.2f
                            mbcRatio = 2.0f
                            mbcThresholdDb = -16.5f
                            mbcPostGainDb = 0.6f
                            limiterCeilingDb = -1.0f
                        }
                    }

                    dp.setInputGainAllChannelsTo(inputGainDb)

                    val mbcBand = DynamicsProcessing.MbcBand(
                        normActive,
                        20000f,
                        8.0f,
                        120.0f,
                        mbcRatio,
                        mbcThresholdDb,
                        6.0f,
                        -75.0f,
                        1.0f,
                        0.0f,
                        mbcPostGainDb
                    )
                    dp.setMbcBandAllChannelsTo(0, mbcBand)

                    // 2. 5-Band Post-EQ
                    for (i in 0 until 5) {
                        val gain = if (eqActive) eqGainsDb.getOrElse(i) { 0f }.coerceIn(-12f, 12f) else 0f
                        val band = DynamicsProcessing.EqBand(true, eqCutoffHz[i], gain)
                        dp.setPostEqBandAllChannelsTo(i, band)
                    }

                    // 3. Brickwall Limiter
                    val limiter = DynamicsProcessing.Limiter(
                        true,
                        anyDspActive,
                        0,
                        1.0f,
                        60.0f,
                        10.0f,
                        limiterCeilingDb,
                        0.0f
                    )
                    dp.setLimiterAllChannelsTo(limiter)
                    dp.enabled = anyDspActive
                    return
                }
            }
        }

        dsp.legacyEqualizer?.let { eq ->
            runCatching {
                val range = eq.bandLevelRange
                val minMb = range.getOrElse(0) { -1200 }.toInt()
                val maxMb = range.getOrElse(1) { 1200 }.toInt()
                val count = eq.numberOfBands.toInt()
                val targetCentersHz = intArrayOf(60, 230, 910, 3600, 14000)
                for (b in 0 until count) {
                    val centerHz = (eq.getCenterFreq(b.toShort()) / 1000).coerceAtLeast(20)
                    var nearestIdx = 0
                    var bestDist = Int.MAX_VALUE
                    for (i in targetCentersHz.indices) {
                        val dist = abs(centerHz - targetCentersHz[i])
                        if (dist < bestDist) {
                            bestDist = dist
                            nearestIdx = i
                        }
                    }
                    val db = if (eqActive) eqGainsDb.getOrElse(nearestIdx) { 0f }.coerceIn(-12f, 12f) else 0f
                    val mb = (db * 100f).roundToInt().coerceIn(minMb, maxMb).toShort()
                    eq.setBandLevel(b.toShort(), mb)
                }
                eq.enabled = eqActive
            }
        }
    }

    /* ---------------- Dual-Deck Crossfade Engine ---------------- */

    private fun computeCurveGains(progress: Float): Pair<Float, Float> {
        val t = progress.coerceIn(0f, 1f)
        return when (crossfadeCurve) {
            "linear" -> Pair(1f - t, t)
            "sCurve" -> {
                val s = t * t * (3f - 2f * t)
                val angle = (s * (PI / 2.0)).toFloat()
                Pair(cos(angle), sin(angle))
            }
            else -> {
                val angle = (t * (PI / 2.0)).toFloat()
                Pair(cos(angle), sin(angle))
            }
        }
    }

    private fun scheduleMonitorIfNeeded() {
        if (monitorScheduled) return
        val p = primaryPlayer ?: return
        val shouldRun = isCrossfading || (crossfadeEnabled && crossfadeDurationMs >= 1000L && p.isPlaying)
        if (!shouldRun) return
        monitorScheduled = true
        val delayMs = if (isCrossfading) 40L else 220L
        mainHandler.postDelayed(crossfadeMonitorRunnable, delayMs)
    }

    private fun cancelCrossfade(keepPrimaryPlaying: Boolean) {
        mainHandler.removeCallbacks(crossfadeMonitorRunnable)
        monitorScheduled = false
        val out = outgoingPlayer
        isCrossfading = false
        outgoingPlayer = null
        incomingPlayer = null
        preloadedIndex = C.INDEX_UNSET

        out?.let {
            runCatching {
                it.playWhenReady = false
                it.pause()
                it.stop()
                it.clearMediaItems()
                it.volume = 0f
            }
        }

        secondaryPlayer?.let {
            if (it !== primaryPlayer) {
                runCatching {
                    it.playWhenReady = false
                    it.stop()
                    it.clearMediaItems()
                    it.volume = 0f
                }
            }
        }

        primaryPlayer?.let { p ->
            val ceiling = fallbackVolumeCeiling(dspForDeck(primaryIsDeckA))
            p.volume = ceiling
            p.repeatMode = repeatModeState
            p.shuffleModeEnabled = shuffleState
            if (!keepPrimaryPlaying) {
                p.pause()
            }
        }
    }

    private fun preloadStandbyDeck(nextIdx: Int) {
        val standby = secondaryDeck() ?: return
        if (currentMediaItems.isEmpty() || nextIdx !in currentMediaItems.indices) return
        preloadedIndex = nextIdx
        runCatching {
            standby.stop()
            standby.volume = 0f
            standby.repeatMode = repeatModeState
            standby.shuffleModeEnabled = shuffleState
            standby.setMediaItems(currentMediaItems, nextIdx, 0L)
            standby.playWhenReady = false
            standby.prepare()
        }.onFailure {
            preloadedIndex = C.INDEX_UNSET
        }
    }

    private fun beginCrossfadeToPreloaded() {
        val outDeck = primaryPlayer ?: return
        val inDeck = secondaryDeck() ?: return
        if (preloadedIndex == C.INDEX_UNSET) return

        isCrossfading = true
        crossfadeStartRealtimeMs = SystemClock.elapsedRealtime()
        outgoingPlayer = outDeck
        incomingPlayer = inDeck

        // Swap roles so primaryPlayer (and MediaSession) immediately point to incoming track
        primaryPlayer = inDeck
        secondaryPlayer = outDeck
        primaryIsDeckA = !primaryIsDeckA
        preloadedIndex = C.INDEX_UNSET

        val focusAttrs = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()
        // Transfer audio focus ownership cleanly without interrupting output
        outDeck.setAudioAttributes(focusAttrs, false)
        inDeck.setAudioAttributes(focusAttrs, true)

        // Prevent outgoing deck from advancing to N+1 on its own before fade finishes
        outDeck.repeatMode = Player.REPEAT_MODE_OFF
        inDeck.repeatMode = repeatModeState
        inDeck.shuffleModeEnabled = shuffleState

        inDeck.volume = 0f
        if (inDeck.playbackState == Player.STATE_IDLE) {
            inDeck.prepare()
        }
        inDeck.play()

        mediaSession?.player = inDeck
        syncWakeLocks()
        scheduleMonitorIfNeeded()
    }

    private fun tickCrossfadeMonitor() {
        val p = primaryPlayer ?: return

        if (isCrossfading) {
            val outDeck = outgoingPlayer
            val inDeck = incomingPlayer
            if (outDeck == null || inDeck == null) {
                cancelCrossfade(keepPrimaryPlaying = p.playWhenReady)
                return
            }
            val elapsed = (SystemClock.elapsedRealtime() - crossfadeStartRealtimeMs).coerceAtLeast(0L)
            val progress = (elapsed.toFloat() / crossfadeDurationMs.coerceAtLeast(500L).toFloat()).coerceIn(0f, 1f)
            val (rawOut, rawIn) = computeCurveGains(progress)
            val outCeiling = fallbackVolumeCeiling(dspForDeck(!primaryIsDeckA))
            val inCeiling = fallbackVolumeCeiling(dspForDeck(primaryIsDeckA))

            outDeck.volume = (rawOut * outCeiling).coerceIn(0f, 1f)
            inDeck.volume = (rawIn * inCeiling).coerceIn(0f, 1f)

            if (progress >= 1f || outDeck.playbackState == Player.STATE_ENDED) {
                runCatching {
                    outDeck.playWhenReady = false
                    outDeck.pause()
                    outDeck.stop()
                    outDeck.clearMediaItems()
                    outDeck.volume = 0f
                }
                inDeck.volume = inCeiling
                isCrossfading = false
                outgoingPlayer = null
                incomingPlayer = null
                syncWakeLocks()
                scheduleMonitorIfNeeded()
                return
            }
            scheduleMonitorIfNeeded()
            return
        }

        if (!crossfadeEnabled || crossfadeDurationMs < 1000L || !p.isPlaying) {
            return
        }

        if (repeatModeState == Player.REPEAT_MODE_ONE || p.mediaItemCount <= 1) {
            scheduleMonitorIfNeeded()
            return
        }

        val dur = p.duration
        val pos = p.currentPosition
        if (dur == C.TIME_UNSET || dur <= crossfadeDurationMs + 3_500L) {
            scheduleMonitorIfNeeded()
            return
        }

        val remainingMs = dur - pos
        val nextIdx = p.nextMediaItemIndex
        if (nextIdx == C.INDEX_UNSET) {
            scheduleMonitorIfNeeded()
            return
        }

        val preloadWindowMs = crossfadeDurationMs + 3_500L
        if (remainingMs in 1..preloadWindowMs && preloadedIndex != nextIdx) {
            preloadStandbyDeck(nextIdx)
        }

        if (remainingMs <= crossfadeDurationMs && preloadedIndex == nextIdx) {
            beginCrossfadeToPreloaded()
            return
        }

        scheduleMonitorIfNeeded()
    }

    /* ---------------- Public Commands ---------------- */

    fun setQueue(
        context: Context,
        tracks: List<NativeQueueTrack>,
        startIndex: Int,
        autoPlay: Boolean,
        startPositionMs: Long
    ): JSObject {
        ensureInitialized(context)
        if (isCrossfading || preloadedIndex != C.INDEX_UNSET) {
            cancelCrossfade(keepPrimaryPlaying = false)
        }
        val player = primaryPlayer!!
        lastError = null
        consecutiveErrors = 0
        queueTracks = tracks

        if (tracks.isEmpty()) {
            player.stop()
            player.clearMediaItems()
            currentMediaItems = emptyList()
            syncWakeLocks()
            return snapshotState(player)
        }

        val mediaItems = tracks.map { tr ->
            val metaBuilder = MediaMetadata.Builder()
                .setTitle(tr.title)
                .setArtist(tr.artist)
            if (!tr.album.isNullOrBlank()) {
                metaBuilder.setAlbumTitle(tr.album)
            }
            if (!tr.artworkUrl.isNullOrBlank()) {
                runCatching {
                    metaBuilder.setArtworkUri(Uri.parse(tr.artworkUrl))
                }
            }
            val builder = MediaItem.Builder()
                .setMediaId(tr.id)
                .setUri(tr.streamUrl)
                .setMediaMetadata(metaBuilder.build())
            if (tr.streamUrl.contains(".m3u8")) {
                builder.setMimeType("application/x-mpegURL")
            }
            builder.build()
        }

        currentMediaItems = mediaItems
        val safeIndex = startIndex.coerceIn(0, mediaItems.size - 1)

        // Seamless queue extension (e.g. radio recommendations appended while playing same track)
        val curId = player.currentMediaItem?.mediaId
        val targetId = mediaItems[safeIndex].mediaId
        if (player.mediaItemCount > 0 &&
            curId != null &&
            curId == targetId &&
            safeIndex == player.currentMediaItemIndex &&
            mediaItems.size > player.mediaItemCount
        ) {
            val existingIds = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
            val prefixMatches = existingIds.indices.all { idx -> existingIds[idx] == mediaItems[idx].mediaId }
            if (prefixMatches) {
                player.addMediaItems(mediaItems.subList(player.mediaItemCount, mediaItems.size))
                return snapshotState(player)
            }
        }

        ensureServiceStarted(context)
        player.volume = fallbackVolumeCeiling(dspForDeck(primaryIsDeckA))
        player.repeatMode = repeatModeState
        player.shuffleModeEnabled = shuffleState
        player.setMediaItems(mediaItems, safeIndex, startPositionMs.coerceAtLeast(0L))
        player.prepare()
        player.playWhenReady = autoPlay
        syncWakeLocks()
        scheduleMonitorIfNeeded()
        return snapshotState(player)
    }

    fun play(context: Context): JSObject {
        val player = ensureInitialized(context)
        ensureServiceStarted(context)
        if (player.playbackState == Player.STATE_IDLE && player.mediaItemCount > 0) {
            player.prepare()
        } else if (player.playbackState == Player.STATE_ENDED && player.mediaItemCount > 0) {
            player.seekTo(player.currentMediaItemIndex, 0L)
        }
        player.play()
        syncWakeLocks()
        scheduleMonitorIfNeeded()
        return snapshotState(player)
    }

    fun pause(context: Context): JSObject {
        ensureInitialized(context)
        if (isCrossfading) {
            cancelCrossfade(keepPrimaryPlaying = false)
        }
        val player = primaryPlayer!!
        player.pause()
        syncWakeLocks()
        return snapshotState(player)
    }

    fun seek(context: Context, positionMs: Long): JSObject {
        ensureInitialized(context)
        if (isCrossfading || preloadedIndex != C.INDEX_UNSET) {
            cancelCrossfade(keepPrimaryPlaying = primaryPlayer?.playWhenReady == true)
        }
        val player = primaryPlayer!!
        player.seekTo(positionMs.coerceAtLeast(0L))
        scheduleMonitorIfNeeded()
        return snapshotState(player)
    }

    fun skipTo(context: Context, index: Int, autoPlay: Boolean): JSObject {
        ensureInitialized(context)
        if (isCrossfading || preloadedIndex != C.INDEX_UNSET) {
            cancelCrossfade(keepPrimaryPlaying = autoPlay)
        }
        val player = primaryPlayer!!
        if (index in 0 until player.mediaItemCount) {
            lastError = null
            ensureServiceStarted(context)
            player.seekTo(index, 0L)
            if (player.playbackState == Player.STATE_IDLE) {
                player.prepare()
            }
            player.playWhenReady = autoPlay
            syncWakeLocks()
            scheduleMonitorIfNeeded()
        }
        return snapshotState(player)
    }

    fun next(context: Context): JSObject {
        ensureInitialized(context)
        if (isCrossfading || preloadedIndex != C.INDEX_UNSET) {
            cancelCrossfade(keepPrimaryPlaying = true)
        }
        val player = primaryPlayer!!
        if (player.mediaItemCount > 0) {
            lastError = null
            ensureServiceStarted(context)
            if (player.hasNextMediaItem()) {
                player.seekToNextMediaItem()
            } else if (player.repeatMode != Player.REPEAT_MODE_OFF) {
                player.seekTo(0, 0L)
            }
            if (player.playbackState == Player.STATE_IDLE) player.prepare()
            player.play()
            syncWakeLocks()
            scheduleMonitorIfNeeded()
        }
        return snapshotState(player)
    }

    fun prev(context: Context): JSObject {
        ensureInitialized(context)
        if (isCrossfading || preloadedIndex != C.INDEX_UNSET) {
            cancelCrossfade(keepPrimaryPlaying = true)
        }
        val player = primaryPlayer!!
        if (player.mediaItemCount > 0) {
            lastError = null
            ensureServiceStarted(context)
            if (player.currentPosition > 3_500L) {
                player.seekTo(0L)
            } else if (player.hasPreviousMediaItem()) {
                player.seekToPreviousMediaItem()
            } else {
                player.seekTo(0L)
            }
            if (player.playbackState == Player.STATE_IDLE) player.prepare()
            player.play()
            syncWakeLocks()
            scheduleMonitorIfNeeded()
        }
        return snapshotState(player)
    }

    fun setRepeatShuffle(context: Context, repeatMode: String, shuffleEnabled: Boolean): JSObject {
        val player = ensureInitialized(context)
        repeatModeState = when (repeatMode.lowercase()) {
            "one" -> Player.REPEAT_MODE_ONE
            "all" -> Player.REPEAT_MODE_ALL
            else -> Player.REPEAT_MODE_OFF
        }
        shuffleState = shuffleEnabled
        player.repeatMode = repeatModeState
        player.shuffleModeEnabled = shuffleState
        if (preloadedIndex != C.INDEX_UNSET && !isCrossfading) {
            cancelCrossfade(keepPrimaryPlaying = player.playWhenReady)
        }
        scheduleMonitorIfNeeded()
        return snapshotState(player)
    }

    fun setEq(context: Context, enabled: Boolean, gains: FloatArray) {
        ensureInitialized(context)
        eqEnabled = enabled
        eqGainsDb = FloatArray(5) { idx -> gains.getOrElse(idx) { 0f }.coerceIn(-12f, 12f) }
        applyDspToAllDecks()
    }

    fun setAudioConfig(
        context: Context,
        normEnabled: Boolean,
        normTarget: String,
        xfadeEnabled: Boolean,
        xfadeDurationMs: Long,
        xfadeCurve: String
    ) {
        ensureInitialized(context)
        normalizationEnabled = normEnabled
        normalizationTarget = when (normTarget) {
            "quiet", "loud", "normal" -> normTarget
            else -> "normal"
        }
        val prevXfade = crossfadeEnabled
        crossfadeEnabled = xfadeEnabled && xfadeDurationMs >= 1000L
        crossfadeDurationMs = xfadeDurationMs.coerceIn(0L, 12_000L)
        crossfadeCurve = when (xfadeCurve) {
            "linear", "equalPower", "sCurve" -> xfadeCurve
            else -> "equalPower"
        }

        if (prevXfade && !crossfadeEnabled && (isCrossfading || preloadedIndex != C.INDEX_UNSET)) {
            cancelCrossfade(keepPrimaryPlaying = primaryPlayer?.playWhenReady == true)
        }
        applyDspToAllDecks()
        scheduleMonitorIfNeeded()
    }

    fun getState(context: Context): JSObject {
        val player = ensureInitialized(context)
        return snapshotState(player)
    }

    private fun snapshotState(player: ExoPlayer): JSObject {
        val idx = if (player.mediaItemCount > 0) player.currentMediaItemIndex else -1
        val currentId = player.currentMediaItem?.mediaId ?: queueTracks.getOrNull(idx)?.id
        val fallbackDuration = queueTracks.getOrNull(idx)?.durationMs ?: 0L
        val rawDuration = player.duration
        val durationMs = if (rawDuration != C.TIME_UNSET && rawDuration > 0L) rawDuration else fallbackDuration
        val positionMs = player.currentPosition.coerceAtLeast(0L)
        val isBuffering = player.playbackState == Player.STATE_BUFFERING
        val isPlaying = player.isPlaying || (player.playWhenReady && isBuffering)

        val repeatStr = when (player.repeatMode) {
            Player.REPEAT_MODE_ONE -> "one"
            Player.REPEAT_MODE_ALL -> "all"
            else -> "off"
        }

        val out = JSObject()
        out.put("playing", isPlaying)
        out.put("buffering", isBuffering)
        out.put("currentIndex", idx)
        if (currentId != null) {
            out.put("trackId", currentId)
        }
        out.put("positionMs", positionMs)
        out.put("durationMs", durationMs)
        out.put("repeatMode", repeatStr)
        out.put("shuffleEnabled", player.shuffleModeEnabled)
        lastError?.let { out.put("error", it) }
        return out
    }

    fun parseTracksJson(arr: JSONArray?): List<NativeQueueTrack> {
        if (arr == null) return emptyList()
        val list = ArrayList<NativeQueueTrack>(arr.length())
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val id = obj.optString("id", "").trim()
            val streamUrl = obj.optString("streamUrl", "").trim()
            if (id.isEmpty() || streamUrl.isEmpty()) continue
            list.add(
                NativeQueueTrack(
                    id = id,
                    title = obj.optString("title", "Unknown"),
                    artist = obj.optString("artist", "Unknown"),
                    album = obj.optString("album", "").takeIf { it.isNotBlank() },
                    artworkUrl = obj.optString("artworkUrl", "").takeIf { it.isNotBlank() },
                    streamUrl = streamUrl,
                    durationMs = obj.optLong("durationMs", 0L).coerceAtLeast(0L)
                )
            )
        }
        return list
    }
}
