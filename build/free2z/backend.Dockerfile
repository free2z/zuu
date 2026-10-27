# Build context: repository root. No deployment files or credentials are inputs.
FROM python:3.12-bookworm@sha256:903c1a88edb0a18dbc4e02ef07545d18eefea9839ee40761266a640f8d5213d6
RUN dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge 20250419~deb12u2
COPY py/free2z/requirements/main.txt /requirements.txt
RUN python -m pip install --disable-pip-version-check --require-hashes -r /requirements.txt
ENV TIKTOKEN_CACHE_DIR=/opt/tiktoken-cache
COPY py/free2z/utils/warm_tiktoken_cache.py /warm_tiktoken_cache.py
RUN python /warm_tiktoken_cache.py
COPY py/free2z /source
COPY scripts/free2z/package-runtime.py /package-runtime.py
RUN python /package-runtime.py /source /py && rm -rf /source /package-runtime.py
ENV PYTHONPATH=/py DJANGO_SETTINGS_MODULE=dj.free2z.prod_settings
ARG BUILD_SHA
RUN test -n "$BUILD_SHA"
ENV BUILD_SHA=$BUILD_SHA
LABEL org.opencontainers.image.source="https://github.com/free2z/zuu" org.opencontainers.image.revision=$BUILD_SHA
WORKDIR /py
ENTRYPOINT ["python"]
CMD ["-m", "gunicorn", "dj.free2z.wsgi:application", "--bind", "0.0.0.0:8000"]
