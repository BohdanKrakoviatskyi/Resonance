-keep class com.resonance.mobile.plugin.** { *; }
-keepclassmembers class * {
    @app.tauri.annotation.* <methods>;
}
