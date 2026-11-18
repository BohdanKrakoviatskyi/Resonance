package com.resonance.mobile.plugin

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class ResonanceMobilePlugin(private val activity: Activity) : Plugin(activity) {
    private var notificationPrompted = false

    override fun load(webView: WebView) {
        super.load(webView)
        ResonanceAudioController.runOnMain {
            ResonanceAudioController.getMediaSession(activity.applicationContext)
        }
    }

    private fun maybeRequestNotificationPermission() {
        if (notificationPrompted) return
        notificationPrompted = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                ActivityCompat.requestPermissions(
                    activity,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    9101
                )
            }
        }
    }

    @Command
    fun setQueue(invoke: Invoke) {
        val args = invoke.getArgs()
        val itemsArr = args.optJSONArray("items")
        val tracks = ResonanceAudioController.parseTracksJson(itemsArr)
        val startIndex = args.optInt("startIndex", 0)
        val autoPlay = args.optBoolean("autoPlay", true)
        val startPos = args.optLong("startPositionMs", 0L)
        maybeRequestNotificationPermission()

        ResonanceAudioController.runOnMain {
            try {
                val st = ResonanceAudioController.setQueue(
                    activity.applicationContext,
                    tracks,
                    startIndex,
                    autoPlay,
                    startPos
                )
                invoke.resolve(st)
            } catch (ex: Exception) {
                invoke.reject("Failed to set native audio queue: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun play(invoke: Invoke) {
        maybeRequestNotificationPermission()
        ResonanceAudioController.runOnMain {
            try {
                invoke.resolve(ResonanceAudioController.play(activity.applicationContext))
            } catch (ex: Exception) {
                invoke.reject("Failed to start playback: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun pause(invoke: Invoke) {
        ResonanceAudioController.runOnMain {
            try {
                invoke.resolve(ResonanceAudioController.pause(activity.applicationContext))
            } catch (ex: Exception) {
                invoke.reject("Failed to pause playback: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun seek(invoke: Invoke) {
        val args = invoke.getArgs()
        val pos = args.optLong("positionMs", 0L)
        ResonanceAudioController.runOnMain {
            try {
                invoke.resolve(ResonanceAudioController.seek(activity.applicationContext, pos))
            } catch (ex: Exception) {
                invoke.reject("Failed to seek playback: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun skipTo(invoke: Invoke) {
        val args = invoke.getArgs()
        val index = args.optInt("index", 0)
        val autoPlay = args.optBoolean("autoPlay", true)
        ResonanceAudioController.runOnMain {
            try {
                invoke.resolve(ResonanceAudioController.skipTo(activity.applicationContext, index, autoPlay))
            } catch (ex: Exception) {
                invoke.reject("Failed to skip to track: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun next(invoke: Invoke) {
        ResonanceAudioController.runOnMain {
            try {
                invoke.resolve(ResonanceAudioController.next(activity.applicationContext))
            } catch (ex: Exception) {
                invoke.reject("Failed to skip next: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun prev(invoke: Invoke) {
        ResonanceAudioController.runOnMain {
            try {
                invoke.resolve(ResonanceAudioController.prev(activity.applicationContext))
            } catch (ex: Exception) {
                invoke.reject("Failed to skip previous: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun getState(invoke: Invoke) {
        ResonanceAudioController.runOnMain {
            try {
                invoke.resolve(ResonanceAudioController.getState(activity.applicationContext))
            } catch (ex: Exception) {
                invoke.reject("Failed to read audio state: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun setEq(invoke: Invoke) {
        val args = invoke.getArgs()
        val enabled = args.optBoolean("enabled", false)
        val arr = args.optJSONArray("gainsDb")
        val gains = FloatArray(5) { idx ->
            if (arr != null && idx < arr.length()) arr.optDouble(idx, 0.0).toFloat() else 0f
        }
        ResonanceAudioController.runOnMain {
            try {
                ResonanceAudioController.setEq(activity.applicationContext, enabled, gains)
                invoke.resolve(JSObject())
            } catch (ex: Exception) {
                invoke.reject("Failed to apply equalizer: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun setAudioConfig(invoke: Invoke) {
        val args = invoke.getArgs()
        val normEnabled = args.optBoolean("normalizationEnabled", false)
        val normTarget = args.optString("normalizationTarget", "normal")
        val xfadeEnabled = args.optBoolean("crossfadeEnabled", false)
        val xfadeDurationMs = args.optLong("crossfadeDurationMs", 4_000L)
        val xfadeCurve = args.optString("crossfadeCurve", "equalPower")
        ResonanceAudioController.runOnMain {
            try {
                ResonanceAudioController.setAudioConfig(
                    activity.applicationContext,
                    normEnabled,
                    normTarget,
                    xfadeEnabled,
                    xfadeDurationMs,
                    xfadeCurve
                )
                invoke.resolve(JSObject())
            } catch (ex: Exception) {
                invoke.reject("Failed to apply audio config: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun setRepeatShuffle(invoke: Invoke) {
        val args = invoke.getArgs()
        val repeatMode = args.optString("repeatMode", "off")
        val shuffleEnabled = args.optBoolean("shuffleEnabled", false)
        ResonanceAudioController.runOnMain {
            try {
                invoke.resolve(
                    ResonanceAudioController.setRepeatShuffle(
                        activity.applicationContext,
                        repeatMode,
                        shuffleEnabled
                    )
                )
            } catch (ex: Exception) {
                invoke.reject("Failed to update repeat/shuffle: ${ex.message}", ex)
            }
        }
    }

    @Command
    fun clearAuthCookies(invoke: Invoke) {
        val args = invoke.getArgs()
        val provider = args.optString("provider", "")
        AuthWebViewDialog.clearCookiesForProvider(provider)
        invoke.resolve(JSObject())
    }

    @Command
    fun startYtMusicLogin(invoke: Invoke) {
        AuthWebViewDialog.openYtMusicLogin(activity, invoke)
    }

    @Command
    fun startSoundCloudLogin(invoke: Invoke) {
        AuthWebViewDialog.openSoundCloudLogin(activity, invoke)
    }
}
