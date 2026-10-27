# Static assets are built without deployment credentials. Runtime configuration is mounted by the operator.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS classic
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20250419~deb12u2 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_OPTIONS=--use-openssl-ca
WORKDIR /src/ts/react/free2z
COPY ts/react/free2z/package*.json ./
RUN npm ci --legacy-peer-deps
COPY ts/react/free2z/ ./
# Classic shares the generated meeting-request type with the Svelte client.
COPY ts/svelte/free2z/src/lib/api/f2z.schemas.ts /src/ts/svelte/free2z/src/lib/api/f2z.schemas.ts
RUN CI=false npm run build

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS docs
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20250419~deb12u2 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_OPTIONS=--use-openssl-ca
WORKDIR /src
COPY docs/about-free2z/package*.json ./
RUN npm ci
COPY docs/about-free2z/ ./
RUN npm run build

FROM python:3.12-bookworm@sha256:903c1a88edb0a18dbc4e02ef07545d18eefea9839ee40761266a640f8d5213d6 AS django-static
RUN dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20250419~deb12u2
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
COPY py/free2z/requirements/main.txt /requirements.txt
RUN python -m pip install --disable-pip-version-check --require-hashes -r /requirements.txt
COPY py/free2z /py
ENV PYTHONPATH=/py DJANGO_SETTINGS_MODULE=dj.free2z.settings
RUN python /py/dj/free2z/manage.py collectstatic --noinput

FROM nginx:1.31.6@sha256:60f0d4e986561e08804f75c211dcaf7fc5455699eada29f42cbe8a0a7253dd86
ARG NGINX_SOURCE_VERSION=1.30.4
ARG NGINX_SOURCE_SHA256=4261dc90e9e47c1c4041276e9aaa3d48ebe2e664f728e14fa95ae6c67d57a08b
ARG NGINX_VOD_MODULE_COMMIT=6c305a78b7ab6e4312279bea5c45741bb54a713b

# PCRE2 headers compile nginx; explicitly retaining its runtime library keeps
# apt autoremove from removing a library needed by the installed executable.
RUN apt-get update \
    && apt-get install -y build-essential libpcre2-dev zlib1g-dev libssl-dev wget git libpcre2-8-0 ca-certificates \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20250419+deb13u1

# Fetch nginx-vod-module by immutable commit and download the official upstream
# NGINX source tarball. Verify the tarball before extracting it; its detached
# signature was checked against the official nginx.org PGP key before pinning
# this SHA-256.
RUN git init /nginx-vod-module \
    && git -C /nginx-vod-module fetch --depth 1 https://github.com/kaltura/nginx-vod-module.git ${NGINX_VOD_MODULE_COMMIT} \
    && git -C /nginx-vod-module checkout --detach ${NGINX_VOD_MODULE_COMMIT} \
    && test "$(git -C /nginx-vod-module rev-parse HEAD)" = "${NGINX_VOD_MODULE_COMMIT}" \
    && wget https://nginx.org/download/nginx-${NGINX_SOURCE_VERSION}.tar.gz \
    && echo "${NGINX_SOURCE_SHA256}  nginx-${NGINX_SOURCE_VERSION}.tar.gz" | sha256sum -c - \
    && tar xvf nginx-${NGINX_SOURCE_VERSION}.tar.gz

# Default arguments
RUN cd nginx-${NGINX_SOURCE_VERSION} \
    && ./configure \
    --prefix=/etc/nginx \
    --sbin-path=/usr/sbin/nginx \
    --modules-path=/usr/lib/nginx/modules \
    --conf-path=/etc/nginx/nginx.conf \
    --error-log-path=/var/log/nginx/error.log \
    --http-log-path=/var/log/nginx/access.log \
    --pid-path=/var/run/nginx.pid \
    --lock-path=/var/run/nginx.lock \
    --http-client-body-temp-path=/var/cache/nginx/client_temp \
    --http-proxy-temp-path=/var/cache/nginx/proxy_temp \
    --http-fastcgi-temp-path=/var/cache/nginx/fastcgi_temp \
    --http-uwsgi-temp-path=/var/cache/nginx/uwsgi_temp \
    --http-scgi-temp-path=/var/cache/nginx/scgi_temp \
    --user=nginx \
    --group=nginx \
    --with-compat \
    --with-file-aio \
    --with-threads \
    --with-http_addition_module \
    --with-http_auth_request_module \
    --with-http_dav_module \
    --with-http_flv_module \
    --with-http_gunzip_module \
    --with-http_gzip_static_module \
    --with-http_mp4_module \
    --with-http_random_index_module \
    --with-http_realip_module \
    --with-http_secure_link_module \
    --with-http_slice_module \
    --with-http_ssl_module \
    --with-http_stub_status_module \
    --with-http_sub_module \
    --with-http_v2_module \
    --with-mail \
    --with-mail_ssl_module \
    --with-stream \
    --with-stream_realip_module \
    --with-stream_ssl_module \
    --with-stream_ssl_preread_module \
    --with-cc-opt="-g -O2 -ffile-prefix-map=/data/builder/debuild/nginx-${NGINX_SOURCE_VERSION}/debian/debuild-base/nginx-${NGINX_SOURCE_VERSION}=. -fstack-protector-strong -Wformat -Werror=format-security -Wp,-D_FORTIFY_SOURCE=2 -fPIC" \
    --with-ld-opt='-Wl,-z,relro -Wl,-z,now -Wl,--as-needed -pie' \
    --add-module=/nginx-vod-module \
    # # TODO REMOVE \
    # --with-debug \
    # ### \
    && make \
    && make install \
    && test "$(/usr/sbin/nginx -v 2>&1)" = "nginx version: nginx/${NGINX_SOURCE_VERSION}"

# Cleanup
RUN apt-get remove -y build-essential libpcre2-dev zlib1g-dev libssl-dev && apt-get autoremove -y \
    && rm -rf nginx-${NGINX_SOURCE_VERSION} nginx-${NGINX_SOURCE_VERSION}.tar.gz /nginx-vod-module

CMD ["/usr/sbin/nginx", "-g", "daemon off;"]

COPY --from=classic /src/ts/react/free2z/build/ /base/build/
COPY --from=docs /src/docsbuild/ /base/docsbuild/
COPY --from=django-static /py/dj/free2z/static/ /base/dj/free2z/static/
COPY ts/free2z/bridge/site/ /base/bridge-pages/site/
COPY ts/free2z/bridge/static/ /base/bridge-pages/static/
COPY build/free2z/nginx.conf /etc/nginx/nginx.conf
ARG BUILD_SHA
RUN test -n "$BUILD_SHA"
LABEL org.opencontainers.image.source="https://github.com/free2z/zuu" org.opencontainers.image.revision=$BUILD_SHA
ENTRYPOINT []
CMD ["/usr/sbin/nginx", "-g", "daemon off;"]
