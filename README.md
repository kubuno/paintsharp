<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Kubuno Paintsharp

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Rust](https://img.shields.io/badge/Rust-edition_2021-orange.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![Module](https://img.shields.io/badge/Kubuno-module-4D38DB.svg)

**Kubuno PaintSharp — the creative suite.**

A module for [Kubuno](https://github.com/kubuno/core), the self-hosted, libre (AGPLv3) cloud platform.

## Apps

PaintSharp bundles several creative editors, each reachable under `/paintsharp/<app>`:

| App | Path | What it does |
|---|---|---|
| 🖌️ **Layer** | `/paintsharp/layer` | Raster / image editor (Photoshop-like) |
| ✒️ **Apex** | `/paintsharp/apex` | Vector editor (paths, nodes, gradients) |
| 📦 **Vertex** | `/paintsharp/vertex` | 3D editor |
| 🎬 **Motion** | `/paintsharp/motion` | Video editor |
| 🎞️ **Keyframe** | `/paintsharp/keyframe` | 2D animation |
| 📝 **PdfWriter** | `/paintsharp/pdfwriter` | PDF editor (import & edit content) |

The editors share a common UI library (EditorShell, color tools, navigator…).

## Architecture

A standalone Rust process that registers with the [core](https://github.com/kubuno/core) at startup; the core proxies its routes (`/api/v1/paintsharp/*`) and serves its runtime-loaded React frontend bundle.

- **Backend** — `src/`: Axum + SQLx (PostgreSQL, schema `paintsharp`); migrations in `migrations/`.
- **Frontend** — `frontend/`: a React bundle built to `entry.js`, consuming `@kubuno/sdk`, `@kubuno/ui` and `@kubuno/drive` from npm (provided by the host at runtime via the import map).

## Build

**Requirements:** Rust ≥ 1.82, Node.js ≥ 20, PostgreSQL 16.

```bash
cargo build --release                     # → target/release/kubuno-paintsharp
cd frontend && npm ci && npm run build     # → dist/{entry.js, entry.css}
bash build_deb.sh                          # → dist/kubuno-paintsharp_*.deb
```

> Shared dependencies come from Kubuno — no `kubuno/core` checkout required:
> - **Rust** — shared crates via tagged git dependencies on `kubuno/core`.
> - **Frontend** — `@kubuno/sdk`, `@kubuno/ui`, `@kubuno/drive` from the `@kubuno` npm scope.

## License

[AGPL-3.0-or-later](LICENSE) © Kubuno contributors.
