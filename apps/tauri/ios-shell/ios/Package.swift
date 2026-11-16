// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "weblounge-ios-shell",
  platforms: [.iOS(.v17)],
  products: [
    .library(name: "weblounge-ios-shell", type: .static, targets: ["weblounge-ios-shell"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "weblounge-ios-shell",
      dependencies: [.byName(name: "Tauri")],
      path: "Sources")
  ]
)
