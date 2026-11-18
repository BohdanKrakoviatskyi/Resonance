package com.resonance.mobile.plugin

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.audiofx.DynamicsProcessing
import android.media.audiofx.Equalizer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import app.tauri.plugin.JSObject
import org.json.JSONArray
import kotlin.math.roundToInt

data class NativeQueueTrack(
    val id: String,
    val title: String,
    val artist: String,
    val album: String?,
    val artworkUrl: String?,
    val streamUrl: String,
    val durationMs: Long
)

object ResonanceAudioController {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var appContext: Context? = null
    private var exoPlayer: ExoPlayer? = null
    private var mediaSession: MediaSession? = null

    private var queueTracks: List<NativeQueueTrack> = emptyList()
    private var lastError: String? = null
    private var consecutiveErrors: Int = 0

    private var eqEnabled: Boolean = false
    private var eqGainsDb: FloatArray = floatArrayOf(0f, 0f, 0f, 0f, 0f)
    private var dynamicsProcessing: DynamicsProcessing? = null
    private var legacyEqualizer: Equalizer? = null
    private var boundAudioSessionId: Int = C.AUDIO_SESSION_ID_UNSET

    private val eqCutoffHz = floatArrayOf(120f, 500f, 1800f, 7500f, 20000f)

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

    private fun ensureInitialized(context: Context): ExoPlayer {
        val ctx = context.applicationContext
        appContext = ctx
        exoPlayer?.let { return it }

        val httpFactory = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(8_000)
            .setReadTimeoutMs(16_000)
            .setUserAgent("ResonanceMobile/0.1")

        val mediaSourceFactory = DefaultMediaSourceFactory(ctx)
            .setDataSourceFactory(httpFactory)

        val audioAttrs = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        val player = ExoPlayer.Builder(ctx)
            .setMediaSourceFactory(mediaSourceFactory)
            .setAudioAttributes(audioAttrs, true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()

        player.addListener(object : Player.Listener {
            override fun onAudioSessionIdChanged(audioSessionId: Int) {
                attachEqualizerIfNeeded(audioSessionId)
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) {
                    lastError = null
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) {
                    consecutiveErrors = 0
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                lastError = error.localizedMessage ?: "Audio stream failed (${error.errorCodeName})"
                consecutiveErrors += 1
                if (consecutiveErrors <= 3 && player.mediaItemCount > 1 && player.hasNextMediaItem()) {
                    player.seekToNextMediaItem()
                    player.prepare()
                    player.play()
                }
            }
        })

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

        val sessionBuilder = MediaSession.Builder(ctx, player)
            .setId("resonance_mobile_media_session")
        if (sessionActivity != null) {
            sessionBuilder.setSessionActivity(sessionActivity)
        }

        exoPlayer = player
        mediaSession = sessionBuilder.build()
        if (player.audioSessionId != C.AUDIO_SESSION_ID_UNSET) {
            attachEqualizerIfNeeded(player.audioSessionId)
        }
        return player
    }

    private fun ensureServiceStarted(context: Context) {
        try {
            val intent = Intent(context.applicationContext, ResonancePlaybackService::class.java)
            context.applicationContext.startService(intent)
        } catch (_: Exception) {
            try {
                val intent = Intent(context.applicationContext, ResonancePlaybackService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.applicationContext.startForegroundService(intent)
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun releaseDsp() {
        try {
            dynamicsProcessing?.release()
        } catch (_: Exception) {
        }
        dynamicsProcessing = null
        try {
            legacyEqualizer?.release()
        } catch (_: Exception) {
        }
        legacyEqualizer = null
        boundAudioSessionId = C.AUDIO_SESSION_ID_UNSET
    }

    private fun attachEqualizerIfNeeded(sessionId: Int) {
        if (sessionId == C.AUDIO_SESSION_ID_UNSET || sessionId <= 0) return
        if (sessionId != boundAudioSessionId) {
            releaseDsp()
            boundAudioSessionId = sessionId
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                try {
                    val config = DynamicsProcessing.Config.Builder(
                        DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
                        1,
                        false,
                        0,
                        false,
                        0,
                        true,
                        5,
                        true
                    ).build()
                    val dp = DynamicsProcessing(0, sessionId, config)
                    val limiter = DynamicsProcessing.Limiter(
                        true,
                        true,
                        0,
                        1.0f,
                        60.0f,
                        10.0f,
                        -1.0f,
                        0.0f
                    )
                    dp.setLimiterAllChannelsTo(limiter)
                    dynamicsProcessing = dp
                } catch (_: Exception) {
                    dynamicsProcessing = null
                }
            }
            if (dynamicsProcessing == null) {
                try {
                    legacyEqualizer = Equalizer(0, sessionId)
                } catch (_: Exception) {
                    legacyEqualizer = null
                }
            }
        }
        applyCurrentEqToDsp()
    }

    private fun applyCurrentEqToDsp() {
        val active = eqEnabled && eqGainsDb.any { kotlin.math.abs(it) > 0.05f }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            dynamicsProcessing?.let { dp ->
                try {
                    for (i in 0 until 5) {
                        val gain = if (active) eqGainsDb.getOrElse(i) { 0f }.coerceIn(-12f, 12f) else 0f
                        val band = DynamicsProcessing.EqBand(true, eqCutoffHz[i], gain)
                        dp.setPostEqBandAllChannelsTo(i, band)
                    }
                    dp.enabled = active
                    return
                } catch (_: Exception) {
                }
            }
        }
        legacyEqualizer?.let { eq ->
            try {
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
                        val dist = kotlin.math.abs(centerHz - targetCentersHz[i])
                        if (dist < bestDist) {
                            bestDist = dist
                            nearestIdx = i
                        }
                    }
                    val db = if (active) eqGainsDb.getOrElse(nearestIdx) { 0f }.coerceIn(-12f, 12f) else 0f
                    val mb = (db * 100f).roundToInt().coerceIn(minMb, maxMb).toShort()
                    eq.setBandLevel(b.toShort(), mb)
                }
                eq.enabled = active
            } catch (_: Exception) {
            }
        }
    }

    fun setQueue(
        context: Context,
        tracks: List<NativeQueueTrack>,
        startIndex: Int,
        autoPlay: Boolean,
        startPositionMs: Long
    ): JSObject {
        val player = ensureInitialized(context)
        lastError = null
        consecutiveErrors = 0
        queueTracks = tracks

        if (tracks.isEmpty()) {
            player.stop()
            player.clearMediaItems()
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
                try {
                    metaBuilder.setArtworkUri(Uri.parse(tr.artworkUrl))
                } catch (_: Exception) {
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

        val safeIndex = startIndex.coerceIn(0, mediaItems.size - 1)
        ensureServiceStarted(context)
        player.setMediaItems(mediaItems, safeIndex, startPositionMs.coerceAtLeast(0L))
        player.prepare()
        player.playWhenReady = autoPlay
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
        return snapshotState(player)
    }

    fun pause(context: Context): JSObject {
        val player = ensureInitialized(context)
        player.pause()
        return snapshotState(player)
    }

    fun seek(context: Context, positionMs: Long): JSObject {
        val player = ensureInitialized(context)
        player.seekTo(positionMs.coerceAtLeast(0L))
        return snapshotState(player)
    }

    fun skipTo(context: Context, index: Int, autoPlay: Boolean): JSObject {
        val player = ensureInitialized(context)
        if (index in 0 until player.mediaItemCount) {
            lastError = null
            ensureServiceStarted(context)
            player.seekTo(index, 0L)
            if (player.playbackState == Player.STATE_IDLE) {
                player.prepare()
            }
            player.playWhenReady = autoPlay
        }
        return snapshotState(player)
    }

    fun next(context: Context): JSObject {
        val player = ensureInitialized(context)
        if (player.mediaItemCount > 0) {
            lastError = null
            if (player.hasNextMediaItem()) {
                player.seekToNextMediaItem()
            } else if (player.repeatMode != Player.REPEAT_MODE_OFF) {
                player.seekTo(0, 0L)
            }
            if (player.playbackState == Player.STATE_IDLE) player.prepare()
            player.play()
        }
        return snapshotState(player)
    }

    fun prev(context: Context): JSObject {
        val player = ensureInitialized(context)
        if (player.mediaItemCount > 0) {
            lastError = null
            if (player.currentPosition > 3_500L) {
                player.seekTo(0L)
            } else if (player.hasPreviousMediaItem()) {
                player.seekToPreviousMediaItem()
            } else {
                player.seekTo(0L)
            }
            if (player.playbackState == Player.STATE_IDLE) player.prepare()
            player.play()
        }
        return snapshotState(player)
    }

    fun setRepeatShuffle(context: Context, repeatMode: String, shuffleEnabled: Boolean): JSObject {
        val player = ensureInitialized(context)
        player.repeatMode = when (repeatMode.lowercase()) {
            "one" -> Player.REPEAT_MODE_ONE
            "all" -> Player.REPEAT_MODE_ALL
            else -> Player.REPEAT_MODE_OFF
        }
        player.shuffleModeEnabled = shuffleEnabled
        return snapshotState(player)
    }

    fun setEq(context: Context, enabled: Boolean, gains: FloatArray) {
        ensureInitialized(context)
        eqEnabled = enabled
        eqGainsDb = FloatArray(5) { idx -> gains.getOrElse(idx) { 0f }.coerceIn(-12f, 12f) }
        if (exoPlayer?.audioSessionId != null && exoPlayer!!.audioSessionId != C.AUDIO_SESSION_ID_UNSET) {
            attachEqualizerIfNeeded(exoPlayer!!.audioSessionId)
        }
    }

    fun getState(context: Context): JSObject {
        val player = exoPlayer ?: return JSObject().apply {
            put("playing", false)
            put("buffering", false)
            put("currentIndex", -1)
            put("positionMs", 0L)
            put("durationMs", 0L)
            put("repeatMode", "off")
            put("shuffleEnabled", false)
        }
        return snapshotState(player)
    }

    private fun snapshotState(player: ExoPlayer): JSObject {
        val idx = if (player.mediaItemCount > 0) player.currentMediaItemIndex else -1
        val currentItem = player.currentMediaItem
        val fallbackDuration = queueTracks.getOrNull(idx)?.durationMs ?: 0L
        val rawDuration = player.duration
        val durationMs = if (rawDuration != C.TIME_UNSET && rawDuration > 0L) rawDuration else fallbackDuration
        val positionMs = player.currentPosition.coerceAtLeast(0L)
        val repeatStr = when (player.repeatMode) {
            Player.REPEAT_MODE_ONE -> "one"
            Player.REPEAT_MODE_ALL -> "all"
            else -> "off"
        }

        return JSObject().apply {
            put("playing", player.isPlaying || (player.playWhenReady && player.playbackState == Player.STATE_BUFFERING))
            put("buffering", player.playbackState == Player.STATE_BUFFERING)
            put("currentIndex", idx)
            if (currentItem != null && currentItem.mediaId.isNotEmpty()) {
                put("trackId", currentItem.mediaId)
            }
            put("positionMs", positionMs)
            put("durationMs", durationMs)
            put("repeatMode", repeatStr)
            put("shuffleEnabled", player.shuffleModeEnabled)
            if (!lastError.isNullOrBlank()) {
                put("error", lastError)
            }
        }
    }

    fun parseTracksJson(arr: JSONArray?): List<NativeQueueTrack> {
        if (arr == null) return emptyList()
        val list = ArrayList<NativeQueueTrack>(arr.length())
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val id = obj.optString("id", "")
            val streamUrl = obj.optString("streamUrl", "")
            if (id.isEmpty() || streamUrl.isEmpty()) continue
            list.add(
                NativeQueueTrack(
                    id = id,
                    title = obj.optString("title", "Unknown"),
                    artist = obj.optString("artist", ""),
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
