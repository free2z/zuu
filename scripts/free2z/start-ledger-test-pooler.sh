#!/usr/bin/env bash
# Free2Z application check: start ledger test pooler.
set -euo pipefail
work="${RUNNER_TEMP:?}/ledger-pooler"
mkdir -p "$work"
cat > "$work/pgbouncer.ini" <<EOF
[databases]
* = host=127.0.0.1 port=5432 user=free2z password=free2z
[pgbouncer]
listen_addr=127.0.0.1
listen_port=6432
auth_type=trust
auth_file=/etc/pgbouncer/userlist.txt
pool_mode=transaction
max_client_conn=100
default_pool_size=1
max_db_connections=1
reserve_pool_size=0
server_idle_timeout=1
max_prepared_statements=0
ignore_startup_parameters=extra_float_digits
admin_users=free2z
pidfile=/tmp/pgbouncer.pid
unix_socket_dir=/tmp
EOF
printf '"free2z" "free2z"\n' > "$work/userlist.txt"
chmod 755 "$work"
chmod 644 "$work"/*
docker run -d --name ledger-ci-pooler --network host \
  --entrypoint /usr/bin/pgbouncer -v "$work:/etc/pgbouncer:ro" \
  ghcr.io/cloudnative-pg/pgbouncer:1.25.2-202609221033-trixie@sha256:b15c428057d1ffbc19fb70496911a5f1a47066dcc1315bf794f4e85ade29e2e5 \
  /etc/pgbouncer/pgbouncer.ini
python - <<'PY'
import time
import psycopg
for attempt in range(50):
    try:
        with psycopg.connect(host='127.0.0.1', port=6432, dbname='free2z', user='free2z', connect_timeout=1) as conn:
            assert conn.execute('SELECT 1').fetchone() == (1,)
        break
    except psycopg.OperationalError:
        if attempt == 49:
            raise
        time.sleep(.1)
PY
printf 'LEDGER_TEST_POOLER_PORT=6432\nLEDGER_TEST_POOLER_CONTAINER=ledger-ci-pooler\nLEDGER_TEST_POSTGRES_CONTAINER=%s\n' \
  "${LEDGER_TEST_POSTGRES_CONTAINER:?}" >> "${GITHUB_ENV:?}"
