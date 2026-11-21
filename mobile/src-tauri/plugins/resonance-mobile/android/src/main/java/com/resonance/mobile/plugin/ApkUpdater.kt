package com.resonance.mobile.plugin

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads a release APK and hands it to the system installer. Android never lets an app install
 * silently, so the final step is the installer dialog the person confirms.
 */
object ApkUpdater {
    private const val USER_AGENT = "Resonance-Mobile-Updater"
    private const val MAX_REDIRECTS = 5
    private const val MAX_BYTES = 200L * 1024L * 1024L
    private val ALLOWED_HOSTS = setOf("github.com", "api.github.com", "objects.githubusercontent.com")

    fun download(context: Context, apkUrl: String): File {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { if (it.isFile) it.delete() }
        val target = File(dir, "resonance-update.apk")
        val connection = openValidated(apkUrl)
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code from the release download")
            connection.inputStream.use { input -> target.outputStream().use { output -> copyLimited(input, output) } }
        } finally {
            connection.disconnect()
        }
        if (target.length() <= 0L) throw IllegalStateException("Downloaded APK is empty")
        return target
    }

    /** Opens the first non-redirect response, refusing any hop that leaves https on a release host. */
    private fun openValidated(apkUrl: String): HttpURLConnection {
        var url: URL = URL(apkUrl)
        var hops = 0
        while (true) {
            checkUrl(url)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 20_000
                readTimeout = 120_000
                setRequestProperty("User-Agent", USER_AGENT)
                setRequestProperty("Accept", "application/vnd.android.package-archive")
            }
            val code = try {
                connection.responseCode
            } catch (e: IOException) {
                connection.disconnect()
                throw e
            }
            if (code !in 300..399) return connection
            val location = connection.getHeaderField("Location")
            connection.disconnect()
            if (location.isNullOrBlank()) {
                throw IllegalStateException("HTTP $code without a redirect target from the release download")
            }
            hops += 1
            if (hops > MAX_REDIRECTS) {
                throw IllegalStateException("More than $MAX_REDIRECTS redirects from the release download")
            }
            url = URL(url, location)
        }
    }

    private fun checkUrl(url: URL) {
        if (url.protocol != "https") {
            throw IllegalStateException("Refusing update download over ${url.protocol} from ${url.host}")
        }
        val host = url.host?.lowercase().orEmpty()
        if (host !in ALLOWED_HOSTS) {
            throw IllegalStateException("Refusing update download from ${url.host}")
        }
    }

    private fun copyLimited(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return
            total += read
            if (total > MAX_BYTES) throw IllegalStateException("Update download exceeded the 200 MB limit")
            output.write(buffer, 0, read)
        }
    }

    /** The Tauri template owns the FileProvider; take whichever authority it registered. */
    private fun authority(context: Context): String {
        val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PROVIDERS)
        val provider = info.providers?.firstOrNull { it.name == FileProvider::class.java.name }
            ?: info.providers?.firstOrNull { it.authority?.endsWith(".fileprovider") == true }
        return provider?.authority ?: "${context.packageName}.fileprovider"
    }

    fun install(activity: Activity, apk: File) {
        val uri = FileProvider.getUriForFile(activity, authority(activity), apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
    }
}
