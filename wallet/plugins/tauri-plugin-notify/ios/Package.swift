// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "tauri-plugin-notify", defaultLocalization: "en", platforms: [.iOS("18.0")],
    products: [.library(name: "tauri-plugin-notify", type: .static, targets: ["NotifyPlugin"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api"), .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.0")],
    targets: [.target(name: "NotifyPlugin", dependencies: [.byName(name: "Tauri"), .product(name: "SwiftRs", package: "swift-rs")], path: "Sources", resources: [.process("Resources")])]
)
