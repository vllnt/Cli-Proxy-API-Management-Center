FROM oven/bun:1.3.14 AS panel
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
