package com.resonance.mobile.plugin

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads a release APK and hands it to the system installer. Android never lets an app install
 * silently, so the final step is the installer dialog the person confirms.
 */
object ApkUpdater {
    private const val USER_AGENT = "Resonance-Mobile-Updater"

    fun download(context: Context, apkUrl: String): File {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { if (it.isFile) it.delete() }
        val target = File(dir, "resonance-update.apk")
        val connection = (URL(apkUrl).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 20_000
            readTimeout = 120_000
            setRequestProperty("User-Agent", USER_AGENT)
            setRequestProperty("Accept", "application/vnd.android.package-archive")
        }
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code from the release download")
            connection.inputStream.use { input -> target.outputStream().use { output -> input.copyTo(output) } }
        } finally {
            connection.disconnect()
        }
        if (target.length() <= 0L) throw IllegalStateException("Downloaded APK is empty")
        return target
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
