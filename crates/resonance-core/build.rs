use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rustc-check-cfg=cfg(resonance_no_swift_bridge)");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        println!("cargo:rustc-cfg=resonance_no_swift_bridge");
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let swift_file = manifest_dir.join("../../macos-widget/reload-bridge/Sources/ResonanceWidgetReloadBridge/WidgetReloadBridge.swift");
    println!("cargo:rerun-if-changed={}", swift_file.display());

    if !swift_file.exists() {
        println!("cargo:rustc-cfg=resonance_no_swift_bridge");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let lib_path = out_dir.join("libResonanceWidgetReloadBridge.a");

    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "arm64".into());
    let swift_target = match arch.as_str() {
        "aarch64" => "arm64-apple-macosx13.0",
        "x86_64" => "x86_64-apple-macosx13.0",
        _ => "arm64-apple-macosx13.0",
    };

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-emit-library",
            "-static",
            "-O",
            "-target",
            swift_target,
            "-module-name",
            "ResonanceWidgetReloadBridge",
        ])
        .arg(&swift_file)
        .arg("-o")
        .arg(&lib_path)
        .status();

    let Ok(st) = status else {
        println!("cargo:rustc-cfg=resonance_no_swift_bridge");
        return;
    };
    if !st.success() {
        println!("cargo:rustc-cfg=resonance_no_swift_bridge");
        return;
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=ResonanceWidgetReloadBridge");
    println!("cargo:rustc-link-lib=framework=WidgetKit");
    println!("cargo:rustc-link-lib=framework=Foundation");

    if let Ok(out) = Command::new("xcrun").args(["swiftc", "-print-target-info"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(idx) = text.find("\"runtimeLibraryPaths\"")
            && let Some(open) = text[idx..].find('[') {
                let rest = &text[idx + open + 1..];
                if let Some(close) = rest.find(']') {
                    for part in rest[..close].split('"').skip(1).step_by(2) {
                        if !part.is_empty() {
                            println!("cargo:rustc-link-search=native={part}");
                        }
                    }
                }
            }
    }
}
