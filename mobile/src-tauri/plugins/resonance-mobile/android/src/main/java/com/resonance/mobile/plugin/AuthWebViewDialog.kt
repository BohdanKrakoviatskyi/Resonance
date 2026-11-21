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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

object AuthWebViewDialog {
    private val mainHandler = Handler(Looper.getMainLooper())

    private const val SC_INJECT_JS = """
        (function() {
          if (window !== window.top) return; // api-v2 calls are captured in the top frame only
          if (window.__RESONANCE_SC_HOOKED__) return;
          window.__RESONANCE_SC_HOOKED__ = true;
          var seenCid = '';
          function check(rawUrl, authHeader) {
            try {
              var u = new URL(rawUrl, location.href);
              if (u.hostname !== 'api-v2.soundcloud.com' && u.hostname !== 'api.soundcloud.com') return;
              var cid = u.searchParams.get('client_id') || '';
              if (cid) {
                seenCid = cid;
                if (window.ResonanceAuthBridge && window.ResonanceAuthBridge.onClientIdSeen) {
                  window.ResonanceAuthBridge.onClientIdSeen(cid);
                }
              }
              var m = String(authHeader || '').match(/^(?:OAuth|Bearer)\s+(.+)$/i);
              var tok = m ? m[1].trim() : '';
              if (tok && window.ResonanceAuthBridge) {
                window.ResonanceAuthBridge.onSoundCloudCaptured(cid || seenCid, tok);
              }
            } catch (_) {}
          }
          function checkCookies() {
            try {
              var parts = String(document.cookie || '').split(';');
              for (var i = 0; i < parts.length; i++) {
                var kv = parts[i].trim().split('=');
                if (kv.length >= 2 && kv[0].trim() === 'oauth_token') {
                  var raw = decodeURIComponent(kv.slice(1).join('=').trim());
                  if (raw && raw.length >= 10 && window.ResonanceAuthBridge) {
                    window.ResonanceAuthBridge.onSoundCloudCaptured(seenCid, raw);
                    return;
                  }
                }
              }
            } catch (_) {}
          }
          var origFetch = window.fetch;
          if (typeof origFetch === 'function') {
            window.fetch = function(input, init) {
              try {
                var rawUrl = input instanceof Request ? input.url : String(input);
                var h = new Headers(input instanceof Request ? input.headers : undefined);
                if (init && init.headers) new Headers(init.headers).forEach(function(v, k) { h.set(k, v); });
                check(rawUrl, h.get('Authorization'));
              } catch (_) {}
              return origFetch.apply(this, arguments);
            };
          }
          var origOpen = XMLHttpRequest.prototype.open;
          var origSet = XMLHttpRequest.prototype.setRequestHeader;
          XMLHttpRequest.prototype.open = function(method, url) {
            this.__resUrl = url;
            this.__resHeaders = {};
            return origOpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            try {
              if (String(name).toLowerCase() === 'authorization') {
                check(this.__resUrl, value);
              }
            } catch (_) {}
            return origSet.apply(this, arguments);
          };
          setInterval(checkCookies, 700);
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

    fun clearCookiesForProvider(provider: String) {
        mainHandler.post {
            val cm = CookieManager.getInstance()
            when (provider.lowercase()) {
                "soundcloud" -> {
                    val urls = listOf(
                        "https://soundcloud.com",
                        "https://m.soundcloud.com",
                        "https://secure.soundcloud.com",
                        "https://api-v2.soundcloud.com"
                    )
                    for (u in urls) {
                        cm.setCookie(u, "oauth_token=; Path=/; Max-Age=0")
                        cm.setCookie(u, "oauth_token=; Domain=.soundcloud.com; Path=/; Max-Age=0")
                    }
                    cm.flush()
                }
                "ytmusic" -> {
                    val names = listOf("__Secure-3PAPISID", "SAPISID", "APISID", "SID", "HSID", "SSID")
                    for (name in names) {
                        cm.setCookie("https://music.youtube.com", "$name=; Domain=.youtube.com; Path=/; Max-Age=0")
                        cm.setCookie("https://www.youtube.com", "$name=; Domain=.youtube.com; Path=/; Max-Age=0")
                    }
                    cm.flush()
                }
            }
        }
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
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val u = request?.url ?: return false
                    val scheme = u.scheme?.lowercase().orEmpty()
                    if (scheme != "http" && scheme != "https") {
                        return true
                    }
                    return false
                }

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

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface", "RequiresFeature")
    fun openSoundCloudLogin(activity: Activity, invoke: Invoke) {
        mainHandler.post {
            if (activity.isFinishing || activity.isDestroyed) {
                invoke.reject("Activity is not available")
                return@post
            }
            val settled = AtomicBoolean(false)
            val lastSeenClientId = AtomicReference("")
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

            fun sanitizeToken(raw: String): String {
                val decoded = runCatching { Uri.decode(raw) }.getOrDefault(raw)
                return decoded
                    .trim()
                    .trim('"')
                    .replace(Regex("^(?:OAuth|Bearer)\\s+", RegexOption.IGNORE_CASE), "")
                    .trim()
            }

            fun deliverCapture(clientId: String, token: String) {
                val cleanTok = sanitizeToken(token)
                if (cleanTok.length < 10) return
                val cleanId = clientId.trim().ifEmpty { lastSeenClientId.get().trim() }
                if (!settled.compareAndSet(false, true)) return
                mainHandler.post {
                    val cm = CookieManager.getInstance()
                    cm.flush()
                    val scCookies = mergeCookieStrings(
                        cm.getCookie("https://soundcloud.com").orEmpty(),
                        cm.getCookie("https://m.soundcloud.com").orEmpty()
                    )
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

            fun tryCaptureScCookies(): Boolean {
                if (settled.get()) return true
                val cm = CookieManager.getInstance()
                val cookieSources = listOf(
                    cm.getCookie("https://soundcloud.com").orEmpty(),
                    cm.getCookie("https://m.soundcloud.com").orEmpty(),
                    cm.getCookie("https://secure.soundcloud.com").orEmpty(),
                    cm.getCookie("https://api-v2.soundcloud.com").orEmpty()
                )
                for (rawHeader in cookieSources) {
                    val tok = extractCookieValue(rawHeader, "oauth_token")
                    if (!tok.isNullOrBlank()) {
                        val clean = sanitizeToken(tok)
                        if (clean.length >= 10) {
                            deliverCapture(lastSeenClientId.get(), clean)
                            return true
                        }
                    }
                }
                return false
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
                fun onClientIdSeen(clientId: String) {
                    val clean = clientId.trim()
                    if (clean.isNotEmpty()) {
                        lastSeenClientId.set(clean)
                    }
                }

                @JavascriptInterface
                fun onSoundCloudCaptured(clientId: String, token: String) {
                    if (clientId.isNotBlank()) {
                        lastSeenClientId.set(clientId.trim())
                    }
                    deliverCapture(clientId, token)
                }
            }, "ResonanceAuthBridge")

            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                runCatching {
                    WebViewCompat.addDocumentStartJavaScript(
                        webView,
                        SC_INJECT_JS,
                        setOf(
                            "https://soundcloud.com",
                            "https://m.soundcloud.com",
                            "https://secure.soundcloud.com"
                        )
                    )
                }
            }

            webView.webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    progressBar.progress = newProgress
                    progressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.INVISIBLE
                }
            }

            webView.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val u = request?.url ?: return false
                    val scheme = u.scheme?.lowercase().orEmpty()
                    if (scheme != "http" && scheme != "https") {
                        // Mobile SoundCloud often triggers soundcloud:// or intent:// right after login
                        if (!tryCaptureScCookies()) {
                            view?.loadUrl("https://soundcloud.com/discover")
                        }
                        return true
                    }
                    return false
                }

                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    view?.evaluateJavascript(SC_INJECT_JS, null)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    view?.evaluateJavascript(SC_INJECT_JS, null)
                    tryCaptureScCookies()
                }

                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    if (request != null && !settled.get()) {
                        val u = request.url
                        val host = u?.host?.lowercase().orEmpty()
                        if (host == "api-v2.soundcloud.com" || host == "api.soundcloud.com") {
                            val clientId = u?.getQueryParameter("client_id").orEmpty().trim()
                            if (clientId.isNotEmpty()) {
                                lastSeenClientId.set(clientId)
                            }
                            val authHeader = request.requestHeaders?.entries
                                ?.firstOrNull { it.key.equals("Authorization", ignoreCase = true) }
                                ?.value.orEmpty()
                            val match = Regex("^(?:OAuth|Bearer)\\s+(.+)$", RegexOption.IGNORE_CASE).find(authHeader.trim())
                            val token = match?.groupValues?.getOrNull(1).orEmpty()
                            if (token.isNotEmpty()) {
                                deliverCapture(clientId, token)
                            }
                        }
                    }
                    return super.shouldInterceptRequest(view, request)
                }
            }

            val pollTask = object : Runnable {
                override fun run() {
                    if (settled.get()) return
                    if (tryCaptureScCookies()) return
                    mainHandler.postDelayed(this, 600L)
                }
            }

            dialog.show()
            dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            webView.loadUrl("https://soundcloud.com/signin")
            mainHandler.postDelayed(pollTask, 900L)
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
