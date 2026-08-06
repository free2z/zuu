// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-zcash",
    platforms: [.iOS(.v18)],
    products: [.library(name: "tauri-plugin-zcash", type: .static, targets: ["ZcashPlugin"])],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.0")
    ],
    targets: [
        .target(
            name: "ZcashPlugin",
            dependencies: [
                .byName(name: "Tauri"),
                .product(name: "SwiftRs", package: "swift-rs")
            ],
            path: "Sources"
        )
    ]
)
