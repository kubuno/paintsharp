# Changelog

All notable changes to **kubuno-paintsharp** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/). Entries are added under
`[Unreleased]` **as the change is made**; `_tools/release.sh` stamps them under the version
number at release time, and CI publishes that section as the GitHub Release notes.

## [Unreleased]

### Changed




- **This module now installs as a Kubuno package (`.kbpkg`) only.** Its system
  packages (Debian/RPM and the Windows and macOS installers) are no longer
  built: the module is distributed as one `.kbpkg` per platform (Linux, Windows,
  macOS) that the Kubuno server installs itself — from the admin console, or
  offline with `kubuno modules:install <file>.kbpkg`.
- **The editors keep saving, opening and importing files when the server
  issues a separate internal secret per module.** Every file a PaintSharp editor
  creates, opens, imports or permanently deletes now reaches the Files service
  through the platform core instead of contacting the file service directly. On
  installations hardened so that each module holds its own internal secret, those
  direct calls were refused — silently breaking saving and leaving permanently
  deleted files behind in Drive — and routing them through the core keeps them
  working. Importing a media clip from Files into a Motion project travels the
  same path.
- **Dates are formatted by the platform now, not by a library.** `date-fns` is
  gone from this module: the shared SDK exposes helpers built on `Intl`, which is
  localised for every language we ship and needs no locale bundle loaded. Call
  sites say what a date is FOR — `formatDate(d, 'date')` — and the platform
  decides how to write it, so a reader in Japanese no longer gets a French
  layout. Machine formats (keys, `<input type="date">` values) go through
  `toISODate` and friends, built from local calendar fields so the day cannot
  shift near midnight.
- **Class names are composed by `cn()` from `@ui`**, replacing `clsx`. One less
  dependency for a dozen lines of finished logic; call sites are unchanged.
- **The app table in the README now shows each editor's real logo.** The seven
  editors — Layer, Apex, Vertex, Motion, Keyframe, PdfWriter and FontEditor —
  are listed with the same artwork the applications menu and the browser tab
  use, instead of stand-in emoji. The images ship in-repo under `.github/`.

- **The README now opens with the module's logo.** The public README on
  GitHub now shows the module's designer logo (the same PNG shown as the
  browser tab icon and in the applications menu) at the top of the page — the
  repository landing now matches the icon a signed-in user sees inside the
  platform. The image ships in-repo, under `.github/logo.png`, so it renders
  even when the repo is browsed offline.

- **New logos for every PaintSharp sub-module** — Apex (brown "Ap"), Layer
  (blue "La"), Motion (dark blue "Mo"), Vertex (bronze "Ve"), Keyframe
  (purple "Kf"), PdfWriter (red "Pw") and FontEditor (green "Fe") each get a
  coloured hexagon with their two-letter initials — used as the browser-tab
  icons and in the applications menu. These sub-modules previously had
  generic line icons and no tab icon of their own. They also appear as their
  own logos on the PaintSharp home page cards.

### Changed

- **New PaintSharp logo.** The monogram now sits inside a purple hexagonal
  badge — the same shield shape the rest of the suite uses — so PaintSharp reads
  as one of the platform's applications at a glance in the app launcher, the
  home favourites and its own header and sidebar. (The matching browser-tab
  icon ships from the host.)



### Fixed


- **A withdrawn dependency is no longer used.** A crate deep in the tree
  (`spin` 0.9.8, pulled in through the HTTP stack) was yanked by its authors.
  No vulnerability was announced, but a withdrawn crate has no business in a
  release; the lockfile now takes the version that replaced it.
- **The package could not be built where `zip` is absent.** The Windows job of
  the continuous integration has no `zip`, so the Windows package was simply lost
  the first time it was attempted — a script failure, not a build failure. The
  builder now falls back to 7-Zip, then to PowerShell.
### Added

- **This module now ships a `.kbpkg`** — the single package format a Kubuno
  server installs by itself, the same file on Linux, Windows and macOS. It
  carries the same binary, interface and manifest as the system packages,
  arranged the way the server expects to find a module on disk, plus a
  `SHA256SUMS` so a copy carried offline can be checked without the catalogue.
  Nothing changes for existing installations: the `.deb`, `.rpm`, `.exe` and
  `.pkg` are still published, and a catalogue that sees both simply prefers the
  new one. It is also the only format the server can unpack without an external
  tool, which is what makes one-click installation possible away from
  Debian-like systems.
### Fixed

- **A built package could be thrown away instead of published.** The job that
  attaches a package to the release waited ten minutes for another workflow to
  create that release, then gave up with "release never appeared — build.yml
  likely failed". The diagnosis was wrong: on a repository whose `.deb` takes
  longer than ten minutes to build, the release simply did not exist yet, and a
  package that had built perfectly was discarded. Four modules reached v0.1.6
  with packages missing for some systems because of it. The job now creates the
  release itself when it is missing, so it no longer depends on another workflow
  finishing first.
### Added

- **Security policy and CI quality gate.** A `SECURITY.md` documents how to
  report vulnerabilities, and a CI workflow enforces `clippy -D warnings`, a
  dependency-vulnerability audit (`cargo audit`) and the frontend typecheck/tests.

### Security

- **Paintsharp now authenticates proxied requests from a signed token instead of
  trusting plain headers.** Requests must carry a valid `X-Kubuno-Auth` token
  minted by the core with this module's internal secret (see `kubuno-modauth`),
  rather than reading `X-Kubuno-User-*` headers at face value — which any process
  reaching Paintsharp's loopback port could otherwise forge to act as any user.

### Fixed

- **Deleting a scene, layered image, vector project, animation, video project,
  PDF document or font project now removes its file from Drive.** Permanent
  deletion used to drop only the database record and leave the file behind, so
  Drive kept listing files that could no longer be opened. A PDF you imported
  yourself is still kept.

## [0.1.6] - 2026-08-19

### Changed

- **Pill-shaped buttons are gone from the interface.** Filter chips, view
  segments, tab selectors and action buttons that were drawn as pills now use the
  same 4 px corner radius as every other button — the shape set them apart for no
  reason other than habit. Round buttons that hold a lone icon, avatars, status
  dots and non-clickable badges keep their shape: a circle around a single glyph
  is not a pill.

- Theme tokens: two colours for navigation labels (`--color-text-nav`,
  `--color-text-nav-active`). Every module carries the same token sheet, so the
  values must match across them — whichever bundle loads last would otherwise
  win. No visible change inside this module.

### Changed

- Default application background token aligned with the core (`--body-bg` `#f8fafd`). Only
  visible when the module runs standalone: inside the shell the active theme sets it.

[Unreleased]: https://github.com/kubuno/paintsharp/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/kubuno/paintsharp/releases/tag/v0.1.6
