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
- **No test suite or linter configured** (standard is listed as a devDep but no script)

## Architecture

```
public/
  plugin.json          # uTools plugin manifest (entry, preload, features)
  logo.png             # Plugin icon
  preload/
    package.json       # { "type": "commonjs" } — preload runs in Node context
    services.js        # Backend: wraps devtunnel & frpc CLI, exposes window.services
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

- **Preload** (`public/preload/services.js`): runs in uTools' Node.js context. All `devtunnel` and `frpc` CLI calls go through `child_process.exec`/`spawn`. Exposes `window.services` to the renderer. Uses `window.utools.db` for persistent config and log storage. Communication back to the renderer is via `window.dispatchEvent(new CustomEvent(...))`. Uses `iconv-lite` for Windows GBK encoding support.

- **Renderer** (`src/`): React 19 SPA. No react-router — navigation is a `section` + `view` string state in `App.jsx`. Sections: `devtunnel`, `frp`, `proxydir`, `tutorial`, `about`. Views within devtunnel: `dashboard`, `create`, `detail`, `settings`. All components call `window.services.*` for backend operations and listen to `CustomEvent`s for real-time log/status updates. Icons from `lucide-react`.

### Key patterns

- **Tunnel URLs** are extracted from devtunnel stdout via regex (`/https:\/\/\S+\.devtunnels\.ms/g`) and cached in `window.services.tunnelUrlCache`.
- **Host process lifecycle**: only one tunnel can run at a time (`hostProcess` singleton in services.js). Stopped via `taskkill /pid /T /F` on Windows.
- **Log buffer**: in-memory array (max 500 entries) persisted to uTools DB (max 200) with debounced writes.
- **Config caching**: `getConfig()` caches the DB doc in `configCache`; cleared on `saveConfig`.
- **Login flow**: device code OAuth — devtunnel outputs a URL + code, the preload auto-opens the browser and dispatches `tunnel-login-code` / `tunnel-login-done` events.
- **Frp**: generates TOML config at runtime, writes to temp file, spawns `frpc` with `-c` flag. TCP connectivity testing available.
- **File server**: built-in Node.js HTTP server for directory proxying with MIME type detection, directory listing, and path traversal protection.

### CSS

All styles are plain CSS (no preprocessor, no CSS modules). Each component has a co-located `index.css`. Shared variables and base styles live in `App.css`. The design system uses CSS custom properties (`--brand`, `--radius`, etc.) defined in `:root`.

### Build notes

- `vite.config.js` sets `base: './'` for relative asset paths (required by uTools).
- The preload script is NOT bundled by Vite — it's copied from `public/` to `dist/` as-is.
- `jsconfig.json` includes `utools-api-types` for editor autocomplete of `window.utools.*`.

## Important Details

- The default `devtunnel.exe` path is hardcoded in services.js to `C:\Users\不冷\devtunnel\devtunnel.exe`. Users change this in Settings; the value is stored in uTools DB as `devtunnel-config`.
- The `frpc` path is also configurable via Settings, stored alongside devtunnel config in uTools DB.
- The preload uses CommonJS (`require`), not ESM — the `public/preload/package.json` sets `"type": "commonjs"`.
- `window.__runningTunnelId` is a global variable used to persist the running tunnel ID across re-renders (since the host process lives in the preload, not React state).
