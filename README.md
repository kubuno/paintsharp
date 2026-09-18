<!--
  SPDX-FileCopyrightText: 2026 Kubuno contributors
  SPDX-License-Identifier: AGPL-3.0-or-later
-->

<div align="center">

<img src=".github/logo.png" alt="Kubuno PaintSharp logo" width="120">

# Kubuno — PaintSharp

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Rust](https://img.shields.io/badge/Rust-edition_2021-orange.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)
![Status](https://img.shields.io/badge/status-alpha-yellow.svg)
![Kubuno module](https://img.shields.io/badge/Kubuno-module-4D38DB.svg)

**The creative suite for Kubuno — a bundle of self-hosted editors for raster and vector art, 3D, video, 2D animation, PDF and type design, all collaborating in real time on files that live in your own drive.**

A module for [Kubuno](https://github.com/kubuno/core), the self-hosted, libre (AGPLv3) cloud platform — a sovereign alternative to the mainstream productivity suites.

</div>

---

## ✨ Apps

PaintSharp bundles several creative editors, each reachable under `/paintsharp/<app>`:

| App | Path | What it does |
|---|---|---|
| <img src=".github/logo-layer.png" width="18" height="18" alt=""> **Layer** | `/paintsharp/layer` | Raster / image editor |
| <img src=".github/logo-apex.png" width="18" height="18" alt=""> **Apex** | `/paintsharp/apex` | Vector editor (paths, nodes, gradients) |
| <img src=".github/logo-vertex.png" width="18" height="18" alt=""> **Vertex** | `/paintsharp/vertex` | 3D editor |
| <img src=".github/logo-motion.png" width="18" height="18" alt=""> **Motion** | `/paintsharp/motion` | Video editor |
| <img src=".github/logo-keyframe.png" width="18" height="18" alt=""> **Keyframe** | `/paintsharp/keyframe` | 2D animation |
| <img src=".github/logo-pdfwriter.png" width="18" height="18" alt=""> **PdfWriter** | `/paintsharp/pdfwriter` | PDF editor (import & edit content) |
| <img src=".github/logo-fonteditor.png" width="18" height="18" alt=""> **FontEditor** | `/paintsharp/fonteditor` | Type design (glyph drawing, metrics, kerning, OTF export) |

The editors share a common UI library (EditorShell, colour tools, navigator…).

### Highlights

- 🎨 **Layer** — layer-based raster editing with a professional filter library (blur, sharpen, noise, stylize… — one-click defaults plus tunable dialogs), applied as pure pixel operations with full undo.
- ✒️ **Apex** — pen/node editing with gradients and boolean path operations; freehand **pencil & brush** tools with stroke stabilization, path fitting and pressure-driven calligraphic ribbons; **image tracing** (raster → editable vectors) running server-side on the [VTracer](https://github.com/visioncortex/vtracer) engine, with a live preview, full parameter control and post-trace path simplification; SVG import/export interop (including pasting SVG from the clipboard as editable shapes); vector selections copy as portable envelopes and paste into other Kubuno modules (chat cards, office documents…).
- 🧊 **Vertex** — 3D modeling with a professional **sculpt mode** (14 sculpting brushes — clay, inflate, crease, grab, snake hook… — with falloff curves, pen pressure and dynamic-topology refinement) and **CSG booleans** (union / difference / intersect), plus weld, join and normal tools.
- 📄 **PdfWriter** — imports real PDFs and keeps text editable: embedded font names are matched onto the closest available family, and admin-provided fonts (drive `System/Fonts`) are both rendered on-canvas and **embedded in the exported PDF**; **signatures** (draw with smoothing, type in a cursive font, or import an image with background removal — saved for reuse); offline **OCR** on scanned pages (Tesseract, fully local).
- 🔤 **FontEditor** — full type-design workflow: glyph overview grid, Bézier glyph editor with vertical metrics and draggable advance width, kerning pairs and a live text preview; projects are saved as `.kbfnt` files and export to **OTF** (CFF), **TTF** (native sfnt writer, kerning included), WOFF, WOFF2, EOT and SVG font; existing `ttf`/`otf`/`woff`/`woff2`/`eot` fonts open directly as new projects.
- 💾 **Files in your drive** — documents live in the Kubuno drive as regular files (`.kblayer`, `.kbvec`, `.kb3d`, `.kbvid`, `.kbanim`, `.kbpdf`, `.kbfnt`), reached through the platform core so hardened per-module secrets keep saving, opening and importing working.
- 👥 **Real-time collaboration** — the editors collaborate in real time through the core's Yjs service; collaboration can be toggled instance-wide by an administrator.

## 🏗️ Architecture

PaintSharp is a **separate process** (a standalone Rust binary listening on port **3106**) that registers with the [core](https://github.com/kubuno/core) at startup. The core proxies its routes (`/api/v1/paintsharp/*`), distributes platform events to it and manages its lifecycle; it also serves the module's runtime-loaded React frontend bundle through the host import map.

- **Backend** — `src/`: Axum + SQLx (PostgreSQL, dedicated schema `paintsharp`); migrations in `migrations/`. Proxied requests are authenticated from a signed `X-Kubuno-Auth` token minted by the core, never from plain forwarded headers.
- **Frontend** — `frontend/`: a React bundle built to `entry.js`, consuming `@kubuno/sdk`, `@kubuno/ui` (`@ui`) and `@kubuno/drive` from npm — resolved by the host at runtime via the import map, never re-bundled.

## 📥 Install

A Kubuno module is distributed as a single **`.kbpkg`** — a portable package that the Kubuno server installs by itself, the same file on Linux, Windows and macOS. It is not a system service and ships in no other format.

The easiest way to self-host a full Kubuno instance (core + every module) is the all-in-one **Docker image** (`ghcr.io/kubuno/kubuno`); see **[kubuno/docker](https://github.com/kubuno/docker)**. To install PaintSharp into an existing instance, grab the `.kbpkg` from the [GitHub Releases](https://github.com/kubuno/paintsharp/releases) and let the core unpack it — from the admin console's module marketplace, or offline from the CLI:

```bash
sudo kubuno modules:install kubuno-paintsharp-<version>-<os>-<arch>.kbpkg
sudo systemctl restart kubuno            # the core loads the module on (re)start
```

## 🛠️ Build & development

**Requirements:** Rust ≥ 1.82, Node.js ≥ 24, PostgreSQL 16.

```bash
cargo build --release                      # → target/release/kubuno-paintsharp
cd frontend && npm ci && npm run build     # → dist/{entry.js, entry.css}
bash build_kbpkg.sh                         # → dist/paintsharp-<version>-<os>-<arch>.kbpkg
bash build_kbpkg.sh --install              # build, install into the module store and restart
```

> Shared dependencies come from Kubuno — no `kubuno/core` checkout required:
> - **Rust** — shared crates via tagged git dependencies on `kubuno/core`.
> - **Frontend** — `@kubuno/sdk`, `@kubuno/ui`, `@kubuno/drive` from the `@kubuno` npm scope.

## 🙏 Acknowledgements

- Image tracing (raster → vector, Apex's *Image trace* dialog) is powered by **[VTracer](https://github.com/visioncortex/vtracer)**, the [visioncortex](https://www.visioncortex.org/) vectorization engine (MIT/Apache-2.0). Its conversion pipeline is vendored in `src/services/vtrace.rs` on top of the `visioncortex` crate.
- OCR (PdfWriter's *Recognize text* on scanned pages, and text recognition inside traced images in Apex) uses **[Tesseract](https://github.com/tesseract-ocr/tesseract)** compiled to WebAssembly — worker, core and language models are self-hosted with the module, no public CDN involved.
- Font export builds on **[opentype.js](https://github.com/opentypejs/opentype.js)** (OTF/CFF) and **[fonteditor-core](https://github.com/kekee000/fonteditor-core)** (font-file parsing).

## 📦 Tech stack

Rust 2021 · Axum · Tokio · SQLx (PostgreSQL 16) — React 19 · TypeScript · Vite · Tailwind CSS v4 · Zustand · React Query · Yjs · Three.js.

## 🤝 Contributing

Contributions are welcome. Please open an issue to discuss any significant change before submitting a pull request.

## 📄 License

[AGPL-3.0-or-later](LICENSE) © Kubuno contributors.
