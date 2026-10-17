These self-signed localhost TLS fixtures are public test material for the
`f2z-relay` integration tests. `localhost-key.pem` is deliberately checked in
and has no production value or credential: the corresponding certificate is
trusted only by the local test client, and the relay tests bind loopback ports.
Regenerate both together with OpenSSL if they expire or their names change.
