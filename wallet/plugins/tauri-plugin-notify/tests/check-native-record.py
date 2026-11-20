#!/usr/bin/env python3
"""Execute production native record transitions, without claiming SDK/device proof."""
import argparse, hashlib, json, pathlib, shutil, subprocess, tempfile, urllib.request
root=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('platform',choices=['kotlin','swift']);parser.add_argument('--cache',type=pathlib.Path);args=parser.parse_args()
# Guard the actual secure write callers as well as the pure transition corpus.
if args.platform=='kotlin':
    source=(root/'android/src/main/java/cash/free2z/notify/NotifyPlugin.kt').read_text()
    assert 'Vault.mutate(activity) { NotificationRecord.stop(it) }' in source
    assert 'NotificationRecord.save(it,args.revision,args.lease)' in source
else:
    source=(root/'ios/Sources/NotifyPlugin.swift').read_text()
    assert 'try NotificationRecord.stop(&state)' in source and 'guard self.write(state)' in source
    assert 'NotificationRecord.save(&state,expected:args.revision,text:args.lease)' in source
with tempfile.TemporaryDirectory(prefix='zuu384-native-record-') as tmp:
    tmp=pathlib.Path(tmp)
    if args.platform=='swift':
        subprocess.run(['swiftc',str(root/'ios/Sources/NotificationRecord.swift'),str(root/'tests/swift/main.swift'),'-o',str(tmp/'record')],check=True)
        subprocess.run([str(tmp/'record'),str(root/'tests/native-record.json')],check=True)
    else:
        cache=args.cache or tmp/'jars';cache.mkdir(parents=True,exist_ok=True)
        jars=[]
        for row in json.loads((root/'tests/jvm-artifacts.json').read_text()):
            path=cache/pathlib.PurePosixPath(row['path']).name
            if not path.exists():
                urllib.request.urlretrieve('https://repo.maven.apache.org/maven2/'+row['path'],path)
            assert hashlib.sha256(path.read_bytes()).hexdigest()==row['sha256'], 'artifact digest'
            jars.append(str(path))
        cp=':'.join(jars)
        subprocess.run(['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-reflect','-no-stdlib','-classpath',cp,'-d',str(tmp/'tests.jar'),str(root/'android/src/main/java/cash/free2z/notify/NotificationRecord.kt'),str(root/'tests/kotlin/NativeRecordMain.kt')],check=True)
        subprocess.run(['java','-cp',str(tmp/'tests.jar')+':'+cp,'cash.free2z.notify.NativeRecordMainKt',str(root/'tests/native-record.json')],check=True)
