// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-resonance-mobile",
    platforms: [
        .macOS(.v10_15),
        .iOS(.v15),
    ],
    products: [
        .library(
            name: "tauri-plugin-resonance-mobile",
            type: .static,
            targets: ["tauri-plugin-resonance-mobile"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-resonance-mobile",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources"
        ),
    ]
)
