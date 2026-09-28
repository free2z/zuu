#!/usr/bin/env python3
"""Compile SDK native adapters against the Tauri version in the plugin lockfile.

No app credentials, signing identity, simulator boot, or provider account needed.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'wallet/plugins/tauri-plugin-f2z'


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('ios', 'android'):
        raise SystemExit('usage: check-f2z-sdk-mobile.py ios|android')
    os.environ['RUSTUP_TOOLCHAIN'] = subprocess.check_output([str(ROOT / 'scripts/check-rust-toolchain.sh'), '--print-channel'], text=True).strip()
    metadata = json.loads(subprocess.check_output([
        'cargo', 'metadata', '--locked', '--format-version', '1',
        '--manifest-path', str(PLUGIN / 'Cargo.toml')], text=True))
    tauri = next(Path(p['manifest_path']).parent for p in metadata['packages'] if p['name'] == 'tauri')
    if sys.argv[1] == 'ios':
        with tempfile.TemporaryDirectory(prefix='f2z-swift-test-') as output:
            binary = str(Path(output) / 'callback-tests')
            run('swiftc', str(PLUGIN / 'ios/Sources/CallbackPolicy.swift'), str(PLUGIN / 'ios/Tests/main.swift'), '-o', binary)
            run(binary)
        run('rustup', 'target', 'add', 'aarch64-apple-ios-sim')
        run('cargo', 'check', '--locked', '--target', 'aarch64-apple-ios-sim', '--manifest-path', str(PLUGIN / 'Cargo.toml'))
        native = PLUGIN / '.tauri/tauri-api'
        native.parent.mkdir(exist_ok=True)
        if not native.exists():
            native.symlink_to(tauri / 'mobile/ios-api', target_is_directory=True)
        with tempfile.TemporaryDirectory(prefix='f2z-ios-') as output:
            run('xcodebuild', '-scheme', 'tauri-plugin-f2z', '-destination', 'generic/platform=iOS Simulator',
                '-derivedDataPath', output, 'CODE_SIGNING_ALLOWED=NO', 'build', cwd=PLUGIN / 'ios')
    else:
        sdk = Path(os.environ['ANDROID_HOME'])
        ndk = Path(os.environ['ANDROID_NDK_HOME']) if 'ANDROID_NDK_HOME' in os.environ else sorted((sdk / 'ndk').iterdir())[-1]
        host = 'darwin-x86_64' if sys.platform == 'darwin' else 'linux-x86_64'
        compiler = ndk / 'toolchains/llvm/prebuilt' / host / 'bin/aarch64-linux-android29-clang'
        env = dict(os.environ, ANDROID_NDK_HOME=str(ndk), CC_aarch64_linux_android=str(compiler),
                   AR_aarch64_linux_android=str(compiler.parent / 'llvm-ar'),
                   CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=str(compiler))
        run('rustup', 'target', 'add', 'aarch64-linux-android')
        run('cargo', 'check', '--locked', '--target', 'aarch64-linux-android', '--manifest-path', str(PLUGIN / 'Cargo.toml'), env=env)
        with tempfile.TemporaryDirectory(prefix='f2z-android-') as directory:
            output = Path(directory)
            (output / 'settings.gradle.kts').write_text('''pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
rootProject.name = "f2z-native-check"
include(":tauri-android", ":f2z")
project(":tauri-android").projectDir = file(%s)
project(":f2z").projectDir = file(%s)
''' % (json.dumps(str(tauri / 'mobile/android')), json.dumps(str(PLUGIN / 'android'))))
            (output / 'build.gradle.kts').write_text('''plugins {
    id("com.android.library") version "8.11.0" apply false
    id("org.jetbrains.kotlin.android") version "2.1.21" apply false
}
allprojects { repositories { google(); mavenCentral() } }
''')
            (output / 'gradle.properties').write_text('android.useAndroidX=true\norg.gradle.jvmargs=-Xmx3g\n')
            wrapper = ROOT / 'wallet/zuuli/src-tauri/gen/android/gradlew'
            run(str(wrapper), '-p', directory, '--no-daemon', ':f2z:assembleDebug', ':f2z:testDebugUnitTest', env=env)


if __name__ == '__main__':
    main()
