package com.resonance.mobile.plugin

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.util.concurrent.atomic.AtomicBoolean

object AuthWebViewDialog {
    private val mainHandler = Handler(Looper.getMainLooper())

    private const val SC_INJECT_JS = """
        (function() {
          if (window.__RESONANCE_SC_HOOKED__) return;
          window.__RESONANCE_SC_HOOKED__ = true;
          function check(rawUrl, authHeader) {
            try {
              var u = new URL(rawUrl, location.href);
              if (u.hostname !== 'api-v2.soundcloud.com') return;
              var cid = u.searchParams.get('client_id') || '';
              var m = String(authHeader || '').match(/^(?:OAuth|Bearer)\s+(.+)$/i);
              var tok = m ? m[1] : '';
              if (cid && tok && window.ResonanceAuthBridge) {
                window.ResonanceAuthBridge.onSoundCloudCaptured(cid, tok);
              }
            } catch (_) {}
          }
          var origFetch = window.fetch;
          window.fetch = function(input, init) {
            try {
              var rawUrl = input instanceof Request ? input.url : String(input);
              var h = new Headers(input instanceof Request ? input.headers : undefined);
              if (init && init.headers) new Headers(init.headers).forEach(function(v, k) { h.set(k, v); });
              check(rawUrl, h.get('Authorization'));
            } catch (_) {}
            return origFetch.apply(this, arguments);
          };
          var origOpen = XMLHttpRequest.prototype.open;
          var origSet = XMLHttpRequest.prototype.setRequestHeader;
          XMLHttpRequest.prototype.open = function(method, url) {
            this.__resUrl = url;
            return origOpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            if (String(name).toLowerCase() === 'authorization') {
              check(this.__resUrl, value);
            }
            return origSet.apply(this, arguments);
          };
        })();
    """

    private fun cleanChromeUserAgent(rawUa: String): String {
        val cleaned = rawUa
            .replace("; wv)", ")")
            .replace("; wv;", ";")
            .replace(Regex("Version/\\d+\\.\\d+\\s*"), "")
            .trim()
        return if (cleaned.isNotEmpty()) cleaned else
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    }

    private fun dp(activity: Activity, value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            activity.resources.displayMetrics
        ).toInt()
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun openYtMusicLogin(activity: Activity, invoke: Invoke) {
        mainHandler.post {
            if (activity.isFinishing || activity.isDestroyed) {
                invoke.reject("Activity is not available")
                return@post
            }
            val settled = AtomicBoolean(false)
            val dialog = Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar)
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)

            val webView = WebView(activity)
            val progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
                max = 100
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(activity, 3))
            }

            fun finishCancel() {
                if (!settled.compareAndSet(false, true)) return
                cleanupWebView(dialog, webView)
                invoke.reject("YouTube Music sign-in cancelled")
            }

            fun tryCaptureCookies(): Boolean {
                if (settled.get()) return true
                val cm = CookieManager.getInstance()
                val musicCookies = cm.getCookie("https://music.youtube.com").orEmpty()
                val ytCookies = cm.getCookie("https://www.youtube.com").orEmpty()
                val merged = mergeCookieStrings(musicCookies, ytCookies)
                val hasPapisid = merged.split(';').any { part ->
                    val kv = part.trim().split('=', limit = 2)
                    kv.size == 2 && kv[0].trim().equals("__Secure-3PAPISID", ignoreCase = true) && kv[1].trim().isNotEmpty()
                }
                if (!hasPapisid) return false
                if (!settled.compareAndSet(false, true)) return true
                cm.flush()
                cleanupWebView(dialog, webView)
                invoke.resolve(JSObject().apply {
                    put("cookie", merged)
                    put("authUser", "0")
                })
                return true
            }

            val root = buildModalLayout(activity, "Sign in to YouTube Music", progressBar, webView) {
                finishCancel()
            }
            dialog.setContentView(root)
            dialog.setOnCancelListener { finishCancel() }

            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setAcceptThirdPartyCookies(webView, true)

            webView.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                userAgentString = cleanChromeUserAgent(userAgentString)
            }

            webView.webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    progressBar.progress = newProgress
                    progressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.INVISIBLE
                }
            }

            webView.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    val host = url?.let { runCatching { Uri.parse(it).host }.getOrNull() }.orEmpty()
                    if (host.equals("music.youtube.com", ignoreCase = true)) {
                        tryCaptureCookies()
                    }
                }
            }

            val pollTask = object : Runnable {
                override fun run() {
                    if (settled.get()) return
                    val currentHost = runCatching { Uri.parse(webView.url ?: "").host.orEmpty() }.getOrDefault("")
                    if (currentHost.equals("music.youtube.com", ignoreCase = true)) {
                        if (tryCaptureCookies()) return
                    }
                    mainHandler.postDelayed(this, 750L)
                }
            }

            dialog.show()
            dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            webView.loadUrl("https://music.youtube.com/library")
            mainHandler.postDelayed(pollTask, 1000L)
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    fun openSoundCloudLogin(activity: Activity, invoke: Invoke) {
        mainHandler.post {
            if (activity.isFinishing || activity.isDestroyed) {
                invoke.reject("Activity is not available")
                return@post
            }
            val settled = AtomicBoolean(false)
            val dialog = Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar)
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)

            val webView = WebView(activity)
            val progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
                max = 100
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(activity, 3))
            }

            fun finishCancel() {
                if (!settled.compareAndSet(false, true)) return
                cleanupWebView(dialog, webView)
                invoke.reject("SoundCloud sign-in cancelled")
            }

            fun deliverCapture(clientId: String, token: String) {
                val cleanId = clientId.trim()
                val cleanTok = token.trim()
                if (cleanId.isEmpty() || cleanTok.isEmpty()) return
                if (!settled.compareAndSet(false, true)) return
                mainHandler.post {
                    val cm = CookieManager.getInstance()
                    cm.flush()
                    val scCookies = cm.getCookie("https://soundcloud.com").orEmpty()
                    val datadome = extractCookieValue(scCookies, "datadome")
                    cleanupWebView(dialog, webView)
                    invoke.resolve(JSObject().apply {
                        put("clientId", cleanId)
                        put("token", cleanTok)
                        if (!datadome.isNullOrBlank()) {
                            put("datadome", datadome)
                        }
                    })
                }
            }

            val root = buildModalLayout(activity, "Sign in to SoundCloud", progressBar, webView) {
                finishCancel()
            }
            dialog.setContentView(root)
            dialog.setOnCancelListener { finishCancel() }

            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setAcceptThirdPartyCookies(webView, true)

            webView.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                userAgentString = cleanChromeUserAgent(userAgentString)
            }

            webView.addJavascriptInterface(object {
                @JavascriptInterface
                fun onSoundCloudCaptured(clientId: String, token: String) {
                    deliverCapture(clientId, token)
                }
            }, "ResonanceAuthBridge")

            webView.webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    progressBar.progress = newProgress
                    progressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.INVISIBLE
                }
            }

            webView.webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    view?.evaluateJavascript(SC_INJECT_JS, null)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    view?.evaluateJavascript(SC_INJECT_JS, null)
                }

                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    if (request != null && !settled.get()) {
                        val u = request.url
                        if (u != null && u.host.equals("api-v2.soundcloud.com", ignoreCase = true)) {
                            val clientId = u.getQueryParameter("client_id").orEmpty()
                            val authHeader = request.requestHeaders?.entries
                                ?.firstOrNull { it.key.equals("Authorization", ignoreCase = true) }
                                ?.value.orEmpty()
                            val match = Regex("^(?:OAuth|Bearer)\\s+(.+)$", RegexOption.IGNORE_CASE).find(authHeader.trim())
                            val token = match?.groupValues?.getOrNull(1).orEmpty()
                            if (clientId.isNotEmpty() && token.isNotEmpty()) {
                                deliverCapture(clientId, token)
                            }
                        }
                    }
                    return super.shouldInterceptRequest(view, request)
                }
            }

            dialog.show()
            dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            webView.loadUrl("https://soundcloud.com/signin")
        }
    }

    private fun buildModalLayout(
        activity: Activity,
        titleText: String,
        progressBar: ProgressBar,
        webView: WebView,
        onClose: () -> Unit
    ): LinearLayout {
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#14121A"))
            fitsSystemWindows = true
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        val header = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#1D1B24"))
            setPadding(dp(activity, 16), dp(activity, 12), dp(activity, 12), dp(activity, 12))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        val titleView = TextView(activity).apply {
            text = titleText
            setTextColor(Color.parseColor("#ECE6F0"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }

        val closeBtn = TextView(activity).apply {
            text = "Close"
            setTextColor(Color.parseColor("#D0BCFF"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(activity, 14), dp(activity, 8), dp(activity, 14), dp(activity, 8))
            setOnClickListener { onClose() }
        }

        header.addView(titleView)
        header.addView(closeBtn)
        container.addView(header)
        container.addView(progressBar)

        webView.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f
        )
        container.addView(webView)
        return container
    }

    private fun cleanupWebView(dialog: Dialog, webView: WebView) {
        try {
            webView.stopLoading()
            webView.loadUrl("about:blank")
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        } catch (_: Exception) {
        }
        try {
            if (dialog.isShowing) dialog.dismiss()
        } catch (_: Exception) {
        }
    }

    private fun mergeCookieStrings(primary: String, secondary: String): String {
        val map = LinkedHashMap<String, String>()
        for (source in listOf(secondary, primary)) {
            for (part in source.split(';')) {
                val trimmed = part.trim()
                if (trimmed.isEmpty()) continue
                val idx = trimmed.indexOf('=')
                if (idx <= 0) continue
                val k = trimmed.substring(0, idx).trim()
                val v = trimmed.substring(idx + 1).trim()
                if (k.isNotEmpty() && v.isNotEmpty()) {
                    map[k] = v
                }
            }
        }
        return map.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    private fun extractCookieValue(cookieHeader: String, targetName: String): String? {
        for (part in cookieHeader.split(';')) {
            val idx = part.indexOf('=')
            if (idx <= 0) continue
            val name = part.substring(0, idx).trim()
            val value = part.substring(idx + 1).trim()
            if (name.equals(targetName, ignoreCase = true) && value.isNotEmpty()) {
                return value
            }
        }
        return null
    }
}
