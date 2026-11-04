// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "tauri-plugin-f2z",
    platforms: [.iOS(.v14)],
    products: [.library(name: "tauri-plugin-f2z", type: .static, targets: ["F2zPlugin"])],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.0")
    ],
    targets: [.target(name: "F2zPlugin", dependencies: [.byName(name: "Tauri"), .product(name: "SwiftRs", package: "swift-rs")], path: "Sources")]
)
