mkcert -key-file key.pem -cert-file cert.pem free2z.local "*.free2z.local" localhost 127.0.0.1 ::1
mv dev/cert.pem dev/cert.bak.pem
mv dev/key.pem dev/key.bak.pem
mv cert.pem dev/cert.pem
mv key.pem dev/key.pem
