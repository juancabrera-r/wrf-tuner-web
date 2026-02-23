# WRF Tuner

A small browser-only helper to recommend WRF runtime settings (MPI total, decomposition and time_step) based on domain sizes.

Features
- Suggests a single recommended total MPI (based on domain 1) and a safe decomposition (`nproc_x × nproc_y`).
- Computes a conservative `time_step` cap using a configurable `reasonable_time_step_ratio` (s/km) and scenario safety factors.
- Accepts `dx` values in several formats (`5`, `5km`, `5000`, `5000m`) and normalizes internally to meters.

How to use
1. Open `index.html` in a browser (no backend required).
2. Fill inputs:
	- `Number of domains`: number of nested domains (d01, d02, ...).
	- `e_we`: grid points in west-east for each domain (comma-separated).
	- `e_sn`: grid points in south-north for each domain (comma-separated).
	- `dx_km`: horizontal grid spacing (single value or list). Accepts km or m formats.
	- `min_patch`: minimum tile size required by your build/geometry.
	- `reasonable_time_step_ratio`: s/km cap used to compute a safe `time_step`.
3. Click `Calculate` to see recommendations per scenario (OPTIMAL / SAFE / RISKY).
4. Click `Example` to load sample values.

Notes
- The tool recommends a single total `-np` for the whole WRF job (typical usage) and shows the decomposition/tiles for each domain.
- `time_step` is estimated for reasonableness checks only — final values depend on your WRF configuration and namelist settings.
- The app computes `nx = e_we - 1` and `ny = e_sn - 1` when evaluating tile sizes.

Files
- `index.html` — UI and layout.
- `app.js` — core logic and recommendations.
- `styles.css` — styling.

If you want, I can expand this README with examples, screenshots, or add a short dev section explaining the main functions in `app.js`.
