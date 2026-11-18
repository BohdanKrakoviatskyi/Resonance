package com.resonance.mobile.plugin

import android.content.Intent
import androidx.media3.common.Player
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class ResonancePlaybackService : MediaSessionService() {
    override fun onCreate() {
        super.onCreate()
        val notificationProvider = DefaultMediaNotificationProvider.Builder(applicationContext)
            .setChannelId("resonance_playback_channel")
            .build()
        setMediaNotificationProvider(notificationProvider)

        val session = ResonanceAudioController.getMediaSession(applicationContext)
        if (!sessions.contains(session)) {
            addSession(session)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val session = ResonanceAudioController.getMediaSession(applicationContext)
        if (!sessions.contains(session)) {
            addSession(session)
        }
        return super.onStartCommand(intent, flags, startId)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession {
        val session = ResonanceAudioController.getMediaSession(applicationContext)
        if (!sessions.contains(session)) {
            addSession(session)
        }
        return session
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val session = ResonanceAudioController.getMediaSession(applicationContext)
        val player = session.player
        if (!player.playWhenReady || player.mediaItemCount == 0 || player.playbackState == Player.STATE_ENDED) {
            pauseAllPlayersAndStopSelf()
        }
    }
}
