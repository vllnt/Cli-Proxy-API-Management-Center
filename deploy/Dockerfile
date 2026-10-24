FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS panel
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && cp dist/index.html /management.html

ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN mkdir -p /opt/cliproxy/static
COPY --from=panel /management.html /opt/cliproxy/static/management.html
RUN chown 10001:10001 /opt/cliproxy/static/management.html \
    && chmod 0444 /opt/cliproxy/static/management.html
USER 10001:10001
