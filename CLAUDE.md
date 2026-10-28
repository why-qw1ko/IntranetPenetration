# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A [uTools](https://u.tools/) plugin for managing NAT traversal / tunnel services. It provides a GUI for two tunneling backends:

- **Microsoft DevTunnel** — free tunnel service from Azure, wrapping the `devtunnel` CLI
- **Frp (Fast Reverse Proxy)** — open-source self-hosted tunnel tool, wrapping the `frpc` CLI

Additional features: directory proxying (expose a local folder as an HTTP file server via tunnel), in-app tutorial, and about/changelog page.

## Commands

- **Dev server**: `npm run dev` (Vite)
- **Build**: `npm run build` → output in `dist/`
- **Tests**: `npm test` (Node test runner; HTTP integration and renderer event regressions)
- **Lint**: `npm run lint` (Standard; production JS/JSX and build scripts)
- **All local checks**: `npm run check` (lint, tests, build)
- **Reproducible install**: `npm ci --ignore-scripts`; CI checks Windows and Linux on Node 22

## Architecture

```
public/
  plugin.json          # uTools plugin manifest (entry, preload, features)
  logo.png             # Plugin icon
  preload/
    package.json       # { "type": "commonjs" } — preload runs in Node context
    services.js        # Backend: wraps devtunnel & frpc CLI, exposes window.services
    devtunnel.js       # DevTunnel process lifecycle and URL ownership
    devtunnel-parser.js # CLI text/JSON parsing, with compatibility samples in tests
    file-server.js     # Async read-only HTTP server, bounded metadata reads, stream cleanup
    frpc.js            # FRP process lifecycle and per-proxy registration status
    frp.js             # Shared validation and TOML generation
    storage.js         # Device-key isolation and legacy migration helpers
src/
  main.jsx             # React entry
  App.jsx              # Root component with section/view routing (state, not router)
  Sidebar/             # Left nav: DevTunnel, Frp, ProxyDir, Tutorial, About
  Dashboard/           # Tunnel list, login, log viewer
  CreateTunnel/        # Form to create a new DevTunnel
  TunnelDetail/        # View/edit a single tunnel's config + logs
  Settings/            # Configure devtunnel.exe path, frpc path, default values
  ConfirmModal/        # Reusable confirmation dialog
  FrpPage/             # Frp server config, proxy rules, frpc logs
  ProxyDir/            # Directory proxy: expose a local folder via tunnel
  TutorialPage/        # In-app tutorial/documentation
  AboutPage/           # About page with disclaimer and changelog
```

### Two-process model

- **Preload** (`public/preload/services.js`): runs in uTools' Node.js context. CLI calls use `child_process.execFile`/`spawn` with argument arrays. Exposes `window.services` to the renderer and delegates process control, parsing and HTTP serving to focused CommonJS modules. Communication uses `CustomEvent`s. UTF-8 output decoding falls back to the built-in GBK `TextDecoder` where available.

- **Renderer** (`src/`): React 19 SPA. No react-router — navigation is a `section` + `view` string state in `App.jsx`. Sections: `devtunnel`, `frp`, `proxydir`, `tutorial`, `about`. Views within devtunnel: `dashboard`, `create`, `detail`, `settings`. All components call `window.services.*` for backend operations and listen to `CustomEvent`s for real-time log/status updates. Icons from `lucide-react`.

### Key patterns

- **Tunnel URLs** are extracted from devtunnel stdout via regex (`/https:\/\/\S+\.devtunnels\.ms/g`) and cached in `window.services.tunnelUrlCache`.
- **Host process lifecycle**: `devtunnel.js` owns one host process. Windows stop uses `taskkill /pid /T /F` and waits for close. File-service cleanup is tied to the captured service instance.
- **Log buffer**: backend and renderer keep the latest 500 entries; the latest 200 persist with debounced writes to device-keyed dbStorage.
- **Configuration**: shared defaults and FRP server/proxies are reread from uTools DB. Paths, directory settings and Token use device-prefixed dbStorage keys. This isolates reads across devices but does not prevent uTools data synchronization or encrypt credentials.
- **Login flow**: device code OAuth — devtunnel outputs a URL + code, the preload auto-opens the browser and dispatches `tunnel-login-code` / `tunnel-login-done` events.
- **Frp**: generates TOML config at runtime, writes to temp file, spawns `frpc` with `-c` flag. TCP connectivity testing available.
- **File server**: binds to loopback; async filesystem operations check lexical and real-path boundaries, including external symlinks. Directory metadata reads have a concurrency limit of 8. Stream pipelines handle read errors and client cancellation.
- **Failures and startup**: list/port/FRP configuration reads distinguish failure from empty results. Directory startup validates before stopping an existing host; cancelling a reuse prompt preserves the host. Only resources owned by the current attempt are cleaned on failure.

### CSS

All styles are plain CSS (no preprocessor, no CSS modules). Each component has a co-located `index.css`. Shared variables and base styles live in `App.css`. The design system uses CSS custom properties (`--brand`, `--radius`, etc.) defined in `:root`.

### Build notes

- `vite.config.js` sets `base: './'` for relative asset paths (required by uTools).
- The preload script is NOT bundled by Vite — it's copied from `public/` to `dist/` as-is.
- `jsconfig.json` includes `utools-api-types` for editor autocomplete of `window.utools.*`.

## Important Details

- The default executable path is `path.join(os.homedir(), 'devtunnel', 'devtunnel.exe')`. Settings can override it for the current device.
- The `frpc` path is configurable per device; detection also checks the devtunnel executable's directory.
- The preload uses CommonJS (`require`), not ESM — the `public/preload/package.json` sets `"type": "commonjs"`.
- `window.__runningTunnelId` is a global variable used to persist the running tunnel ID across re-renders (since the host process lives in the preload, not React state).
- Do not introduce new dependencies or reformat unrelated files for a local fix. Keep original CRLF source line endings; workflow YAML uses LF.
- Renderer tests use a small hook host, not a browser DOM. They cannot replace real uTools focus, layout, login, cross-device sync or external CLI acceptance checks.
