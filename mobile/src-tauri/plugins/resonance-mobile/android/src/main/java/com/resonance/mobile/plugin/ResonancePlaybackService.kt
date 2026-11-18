package com.resonance.mobile.plugin

import android.content.Intent
import androidx.media3.common.Player
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class ResonancePlaybackService : MediaSessionService() {
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession {
        return ResonanceAudioController.getMediaSession(this)
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val session = ResonanceAudioController.getMediaSession(this)
        val player = session.player
        if (!player.playWhenReady || player.mediaItemCount == 0 || player.playbackState == Player.STATE_ENDED) {
            stopSelf()
        }
    }
}
