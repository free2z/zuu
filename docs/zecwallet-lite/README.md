# Developing zecwallet-lite in The ZUU devcontainer

Notes on working with zecwallet-lite within the metarepo/devcontainer.

## Forwarding X11

On Mac, you must install and run XQuartz and run on the Mac host:

```
xhost +$(hostname)
```

This will allow the devcontainer to forward the $DISPLAY to the host.

---

## SUID sandbox helper

It is recommended that you run as a non-root user, even in a container.
However, there is a small quirk in chrome-sandbox that it should be owned
by `root`. Because you install with `yarn` as a non-root user,
you are likely to experience this error:

```
[69610:0604/063542.193055:FATAL:setuid_sandbox_host.cc(158)] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that /workspaces/free2z/zingolabs/zecwallet-lite/node_modules/electron/dist/chrome-sandbox is owned by root and has mode 4755.
```

To fix this error, run the following:

```
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Chromium sandbox namespaces

If running in the container you get:

```
Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted
```

You need to either run the container as `--privileged`
or run electron with `--no-sandbox`.
See https://github.com/jessfraz/dockerfiles/issues/350#issuecomment-477342782
