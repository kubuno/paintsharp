# Changelog

All notable changes to **kubuno-paintsharp** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/). Entries are added under
`[Unreleased]` **as the change is made**; `_tools/release.sh` stamps them under the version
number at release time, and CI publishes that section as the GitHub Release notes.

## [Unreleased]


### Changed




- **The RPM package now names the same maintainer as the Debian one.** Its
  changelog entry read `Kubuno Contributors <contact@kubuno.io>`, an address on
  a domain the project does not use; it now reads
  `Martinien OLINGA <kubuno@martinienolinga.com>`, matching the `.deb`. Nothing
  about what the package installs changes.

- **The package maintainer address moved to the project's own domain.** The
  Debian package's `Maintainer` field now reads
  `Martinien OLINGA <kubuno@martinienolinga.com>`. Nothing about what the
  package installs changes.

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


## [0.1.6] - 2026-08-19

### Changed

- Theme tokens: two colours for navigation labels (`--color-text-nav`,
  `--color-text-nav-active`). Every module carries the same token sheet, so the
  values must match across them — whichever bundle loads last would otherwise
  win. No visible change inside this module.

### Changed

- Default application background token aligned with the core (`--body-bg` `#f8fafd`). Only
  visible when the module runs standalone: inside the shell the active theme sets it.

[Unreleased]: https://github.com/kubuno/paintsharp/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/kubuno/paintsharp/releases/tag/v0.1.6
