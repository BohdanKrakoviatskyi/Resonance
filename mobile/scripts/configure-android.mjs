import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const androidAppDir = path.resolve(__dirname, '../src-tauri/gen/android/app');

if (!fs.existsSync(androidAppDir)) {
  console.error(`Android project not found at ${androidAppDir}. Run "npx tauri android init" first.`);
  process.exit(1);
}

// 1. Write network_security_config.xml allowing cleartext ONLY to local loopback & Tauri IPC origins.
const xmlDir = path.join(androidAppDir, 'src/main/res/xml');
fs.mkdirSync(xmlDir, { recursive: true });
const netSecPath = path.join(xmlDir, 'network_security_config.xml');
const netSecXml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">tauri.localhost</domain>
        <domain includeSubdomains="false">ipc.localhost</domain>
    </domain-config>
</network-security-config>
`;
fs.writeFileSync(netSecPath, netSecXml, 'utf8');
console.log('Wrote network_security_config.xml');

// 2. Patch AndroidManifest.xml to reference @xml/network_security_config.
const manifestPath = path.join(androidAppDir, 'src/main/AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('android:networkSecurityConfig=')) {
  manifest = manifest.replace(
    '<application',
    '<application\n        android:networkSecurityConfig="@xml/network_security_config"',
  );
  fs.writeFileSync(manifestPath, manifest, 'utf8');
  console.log('Patched AndroidManifest.xml with networkSecurityConfig');
}

// 3. Append ProGuard / R8 keep rules for Tauri plugin annotations, Media3, and WebView JS bridge.
const proguardPath = path.join(androidAppDir, 'proguard-rules.pro');
const extraRules = `
# Resonance Mobile keep rules
-keep class com.resonance.mobile.** { *; }
-keep class app.tauri.** { *; }
-keepclassmembers class * {
    @app.tauri.annotation.* <methods>;
    @android.webkit.JavascriptInterface <methods>;
}
-dontwarn androidx.media3.**
`;
const existingProguard = fs.existsSync(proguardPath) ? fs.readFileSync(proguardPath, 'utf8') : '';
if (!existingProguard.includes('Resonance Mobile keep rules')) {
  fs.writeFileSync(proguardPath, existingProguard + '\n' + extraRules, 'utf8');
  console.log('Updated proguard-rules.pro');
}
