# Coolify deployment

This directory is the optional VLLNT Coolify deployment for the management
panel. The panel is still bundled into the CLIProxy backend image; Coolify
builds the single-file UI from this repository and overlays it onto a pinned,
private backend image.

Coolify must provide `CLIPROXY_BASE_IMAGE` as a private application variable
available at build time. Keep the full registry reference and digest in
Coolify, never in this public repository. The Compose file reuses the existing
private state, TLS, operations and backup mounts, so only one of the legacy
`cliproxy01-private` service and this application may run at a time.

The application should use repository `vllnt/Cli-Proxy-API-Management-Center`,
branch `main`, build pack Docker Compose, base directory `/`, and compose path
`/deploy/compose.yaml`. Leave automatic deployment disabled until the first
build and cutover are verified; then enable it and validate a real `main` push.
