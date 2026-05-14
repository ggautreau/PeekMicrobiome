# sylph-web-gut

In-browser gut metagenomic profiling: a WebAssembly build of [sylph](https://github.com/bluenote-1577/sylph) targeted at a gut-only reference database, with a streaming FASTQ importer capped at 3 M reads per sample.

> [!IMPORTANT]
> **Unofficial port.** This is an adapted WebAssembly port of sylph for quick, in-browser checks of gut metagenomic composition. It is **not supported or endorsed by the sylph authors** and does not achieve the reliability of [sylph](https://github.com/bluenote-1577/sylph), [MetaPhlAn4](https://github.com/biobakery/MetaPhlAn), or [Meteor2](https://forgemia.inra.fr/metagenopolis/meteor) run natively — use those for real analyses. If you use the results, please cite the upstream papers below.

## Goals

- **Zero install** — single static site, no server-side compute.
- **Privacy** — FASTQ never leaves the user's machine.
- **Tractable footprint** — gut-only `.syldb` (UHGG species reps) fits within the wasm32 4 GB memory ceiling.

## Layout

| Path | What it holds |
|---|---|
| `web/` | Static site: multi-sample sylph profiler with INRAE-themed UI. |
| `web/sylph-pkg/` | wasm-pack output (committed so the deployed site is self-contained). |
| `scripts/` | Native pipeline to build the gut `.syldb` from UHGG. |
| `sylph-wasm/` | Fork of upstream sylph with a wasm32 target and JS bindings. |
| `sylph-survey/` | Notes and porting plan for the sylph → WASM fork. |
| `docs/` | Design notes, size estimates, deployment notes. |
| `.github/workflows/pages.yml` | GitHub Pages deploy on push to `main`. |

## Database hosting

The 6 MB smoke-test database (`web/db/gut_mini.syldb`) is bundled with the site. The full 433 MB UHGG `gut.syldb` is too large for GitHub Pages and is fetched from **Zenodo** at runtime:

- DOI: [10.5281/zenodo.20180025](https://doi.org/10.5281/zenodo.20180025)
- File URL (CORS-enabled, used by the web app): `https://zenodo.org/api/records/20180025/files/gut.syldb/content`

> Note: the user-facing record URL `https://zenodo.org/records/20180025/files/gut.syldb` does **not** return CORS headers, so it can't be `fetch()`-ed by the browser app. Use the `/api/records/.../content` form instead. GitHub Release assets have the same CORS limitation — that's why we host on Zenodo rather than from a GitHub Release.

To publish a new version, upload a fresh `gut.syldb` to Zenodo and swap the URL in the two `<option value="…">` lines in `web/index.html` and `web/profile.html`.

## Citations

If you use the results, please cite:

- **sylph** — Shaw, J. & Yu, Y. W. *Rapid species-level metagenome profiling and containment estimation with sylph.* Nature Biotechnology (2024). <https://www.nature.com/articles/s41587-024-02412-y> — upstream repo: <https://github.com/bluenote-1577/sylph>
- **UHGG catalog** — Almeida, A. *et al.* *A unified catalog of 204,938 reference genomes from the human gut microbiome.* Nature Biotechnology 39, 105–114 (2021). <https://www.nature.com/articles/s41587-020-0603-3>

This repository is an unofficial adaptation; the authors of sylph and the UHGG catalog are not responsible for it.
