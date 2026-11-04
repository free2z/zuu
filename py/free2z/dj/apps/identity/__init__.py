"""Account identity: the ways a Creator can sign in (Pillar 1).

This app is self-contained so it can move to another repository later. Other
apps call the public functions in:mod:`dj.apps.identity.methods`. This app
does not reach into another app's internals. It uses only their public models,
looked up through the app registry, and two public functions:
``ktauth.credentials.identity_can_authenticate`` and
``social.clients.configured_providers``.

Its own models  are passkeys, recovery codes and per-credential auth
context (:mod:`dj.apps.identity.models`). Their only foreign key is to
``settings.AUTH_USER_MODEL``, so the app moves with its three tables.
"""
