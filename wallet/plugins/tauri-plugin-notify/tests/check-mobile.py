#!/usr/bin/env python3
"""Compile real platform sources against SDKs, without signing/provider enrollment.

This is compile/fixture proof only, never device/background-delivery acceptance.
"""
import json,os,pathlib,subprocess,sys,tempfile
plugin=pathlib.Path(__file__).resolve().parents[1];root=plugin.parents[2]
def run(*args,**kwargs):subprocess.run(args,check=True,**kwargs)
platform=sys.argv[1]
assert platform in ('ios','android')
metadata=json.loads(subprocess.check_output(['cargo','metadata','--locked','--format-version','1','--manifest-path',str(plugin/'Cargo.toml')],text=True))
tauri=next(pathlib.Path(p['manifest_path']).parent for p in metadata['packages'] if p['name']=='tauri')
if platform=='ios':
    run('python3',str(plugin/'tests/check-native-record.py'),'swift')
    run('rustup','target','add','aarch64-apple-ios-sim')
    run('cargo','check','--locked','--target','aarch64-apple-ios-sim','--manifest-path',str(plugin/'Cargo.toml'))
    native=plugin/'.tauri/tauri-api';native.parent.mkdir(exist_ok=True)
    if not native.exists():native.symlink_to(tauri/'mobile/ios-api',target_is_directory=True)
    with tempfile.TemporaryDirectory(prefix='zuu384-ios-') as tmp:
        run('xcodebuild','-scheme','tauri-plugin-notify','-destination','generic/platform=iOS Simulator','-derivedDataPath',tmp,'CODE_SIGNING_ALLOWED=NO','build',cwd=plugin/'ios')
else:
    assert 'ANDROID_HOME' in os.environ,'Android SDK required; no stubs'
    with tempfile.TemporaryDirectory(prefix='zuu384-android-') as tmp:
        out=pathlib.Path(tmp)
        (out/'settings.gradle.kts').write_text('pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\nrootProject.name="notification-native-check"\ninclude(":tauri-android",":notify")\nproject(":tauri-android").projectDir=file('+json.dumps(str(tauri/'mobile/android'))+')\nproject(":notify").projectDir=file('+json.dumps(str(plugin/'android'))+')\n')
        (out/'build.gradle.kts').write_text('plugins { id("com.android.library") version "8.11.0" apply false; id("org.jetbrains.kotlin.android") version "2.1.21" apply false }\nallprojects { repositories { google(); mavenCentral() } }\n')
        (out/'gradle.properties').write_text('android.useAndroidX=true\norg.gradle.jvmargs=-Xmx3g\n')
        run(str(root/'wallet/zuuli/src-tauri/gen/android/gradlew'),'-p',tmp,'--no-daemon',':notify:assembleDebug')
