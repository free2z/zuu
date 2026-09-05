// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "tauri-plugin-f2zmsg",
    platforms: [.iOS(.v18)],
    products: [.library(name: "tauri-plugin-f2zmsg", type: .static, targets: ["F2zMsgPlugin"])],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.0")
    ],
    targets: [
        .target(
            name: "F2zMsgPlugin",
            dependencies: [
                .byName(name: "Tauri"),
                .product(name: "SwiftRs", package: "swift-rs")
            ],
            path: "Sources"
        )
    ]
)
