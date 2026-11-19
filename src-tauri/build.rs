use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=LASTFM_API_KEY");
    println!("cargo:rerun-if-env-changed=LASTFM_API_SECRET");

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let env_path = manifest_dir.parent().unwrap().join(".env");
    println!("cargo:rerun-if-changed={}", env_path.display());
    if let Ok(contents) = fs::read_to_string(env_path) {
        for line in contents.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            if !matches!(key, "LASTFM_API_KEY" | "LASTFM_API_SECRET") || env::var_os(key).is_some()
            {
                continue;
            }
            let value = value.trim().trim_matches(['\"', '\'']);
            println!("cargo:rustc-env={key}={value}");
        }
    }

    tauri_build::build()
}
