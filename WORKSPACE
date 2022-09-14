load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

# To find additional information on this release or newer ones visit:
# https://github.com/bazelbuild/rules_rust/releases
http_archive(
    name = "rules_rust",
    sha256 = "6bfe75125e74155955d8a9854a8811365e6c0f3d33ed700bc17f39e32522c822",
    urls = [
        "https://mirror.bazel.build/github.com/bazelbuild/rules_rust/releases/download/0.9.0/rules_rust-v0.9.0.tar.gz",
        "https://github.com/bazelbuild/rules_rust/releases/download/0.9.0/rules_rust-v0.9.0.tar.gz",
    ],
)

load("@rules_rust//rust:repositories.bzl", "rules_rust_dependencies", "rust_register_toolchains")

rules_rust_dependencies()

rust_register_toolchains(
    edition = "2021",
)
