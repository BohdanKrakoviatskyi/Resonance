import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iosGenDir = path.resolve(__dirname, '../src-tauri/gen/apple');

if (!fs.existsSync(iosGenDir)) {
  console.error(`iOS project not found at ${iosGenDir}. Run "npx tauri ios init" first.`);
  process.exit(1);
}

function findInfoPlists(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findInfoPlists(full));
    } else if (entry.name === 'Info.plist') {
      results.push(full);
    }
  }
  return results;
}

for (const plistPath of findInfoPlists(iosGenDir)) {
  let xml = fs.readFileSync(plistPath, 'utf8');
  let changed = false;

  if (!xml.includes('<key>UIBackgroundModes</key>')) {
    xml = xml.replace(
      '</dict>\n</plist>',
      `\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>\n\t</array>\n</dict>\n</plist>`,
    );
    changed = true;
  }

  if (!xml.includes('<key>NSAllowsLocalNetworking</key>')) {
    xml = xml.replace(
      '</dict>\n</plist>',
      `\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>\n\t</dict>\n</dict>\n</plist>`,
    );
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(plistPath, xml, 'utf8');
    console.log(`Patched ${plistPath} with UIBackgroundModes=audio & NSAllowsLocalNetworking`);
  }
}
