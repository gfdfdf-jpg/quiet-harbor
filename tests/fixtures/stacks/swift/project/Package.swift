// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "Orders", targets: [.target(name: "Orders"), .target(name: "Partners"), .testTarget(name: "OrdersTests", dependencies: ["Orders"])])
