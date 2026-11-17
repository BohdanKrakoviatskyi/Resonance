// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ResonanceWidgetReloadBridge",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ResonanceWidgetReloadBridge", type: .static, targets: ["ResonanceWidgetReloadBridge"])
    ],
    targets: [
        .target(name: "ResonanceWidgetReloadBridge", path: "Sources/ResonanceWidgetReloadBridge")
    ]
)
