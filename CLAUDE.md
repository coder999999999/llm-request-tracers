# Notes for Claude Code

- This is a static site (GitHub Pages), no build step: `index.html` (the comparison), `tracers.html` (the tracer cards and every stage's code path) and one HTML page per tracer. The two comparison pages share `assets/compare/site.css` and `assets/compare/page.js`.
- The explainer videos in `video/` are part of a planned series, *One Request, Traced*. Read [`docs/video-series.md`](docs/video-series.md) before changing videos, captions, or the "short version" section of `index.html`.
- Never commit personal details (names, emails, account usernames) in files, captions, video frames, or metadata.
- Run `npm run stamp` after changing any script or stylesheet under `data/` or `assets/compare/`: it updates the `?v=` tags in the HTML pages so browsers fetch the new file, and `npm test` fails until you do.
- Run `npm run check` before committing changes under `data/engines/`; read `docs/superpowers/specs/2026-10-06-engine-comparison-design.md` §7.1 before changing page styling.
