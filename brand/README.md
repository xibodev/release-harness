# Release-Harness Brand Kit

This directory contains the canonical visual identity assets and usage guidance
for Release-Harness. In prose, metadata, and accessible names, use the formal
product name `Release-Harness`. The `release.harness` spelling is the visual
wordmark used in logo artwork.

## Start Here

- [BRAND.md](BRAND.md) defines identity, color, voice, accessibility, and usage.
- [tokens.json](tokens.json) and [tokens.css](tokens.css) provide portable design
  tokens.
- [preview.html](preview.html) is a local, self-contained asset preview.
- [LICENSES.md](LICENSES.md) records licensing and third-party asset status.
- [provenance.json](provenance.json) records asset origin and canonical geometry.

## Asset Families

- `logos/`: full-color marks, lockups, wordmarks, and one-color lockups.
- `icons/`: favicon and square application icon variants.
- `og/`: the default 1200 by 630 social preview as canonical SVG and generated
  PNG.

## Regenerate The Social PNG

The SVG is the editable source. With dependencies and the repository's
Playwright Chromium installed, regenerate both PNG copies from the repository
root:

```bash
npm run generate:brand-png
npm run generate:brand-png -- --check
```

The renderer fixes the viewport at 1200 by 630 CSS pixels, uses device scale 1,
waits for fonts, and writes the same PNG bytes to the kit and public projection.
The check command renders the current source and directly compares that output
with both tracked PNG files; it does not rely on a stored reference value.

Byte-for-byte rendering assumes the same Playwright Chromium build and available
host fonts. The SVG uses system font fallbacks and bundles no font files, so run
generation and `--check` in the same controlled CI or maintainer environment.

Runtime website files under `docs/` are explicit projections of selected assets
from this kit. Keep those projections byte-identical to their canonical source:

| Runtime file | Canonical source |
|---|---|
| `docs/favicon.svg` | `brand/icons/favicon.svg` |
| `docs/logo-mark.svg` | `brand/logos/mark.svg` |
| `docs/og-default.png` | `brand/og/og-default.png` |

Do not publish the whole `brand/` directory as part of the documentation site.
The site builder maintains an explicit file allowlist.
