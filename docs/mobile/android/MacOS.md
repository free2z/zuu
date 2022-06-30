## Android on MacOS

Notes for building mobile apps in the devcontainer with a MacOS host.

### zingolabs/zingo-mobile

Run `rust/android/build.sh` on the host machine.

> TODO! make it work from the devcontainer

```
docker: Error response from daemon: Mounts denied:
The path /workspaces/free2z/zingolabs/zingo-mobile/rust is not shared from the host and is not known to Docker.
You can configure shared paths from Docker -> Preferences... -> Resources -> File Sharing.
See https://docs.docker.com/desktop/mac for more info.
```

Install the android SDK with:

```
brew install android-sdk
```
