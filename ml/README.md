# Lake Mendota shift model (`ml/`)

Trains on the Mendota buoy's multi-year 1-minute wind history to learn its
**shift** behavior. Fully decoupled from the web app — pulls straight from the
public SSEC API (no auth), so it runs anywhere with no infra.

## Layers
1–2. **Regimes + durations + transitions — a covariate-dependent HSMM**
   (`hsmm.py`, *next*). Jointly models the hidden wind state, *how long it
   lasts*, and the transition between states, with **state-duration parameters
   driven by covariates** (hour-of-day, season, and the **lake-breeze index**).
   This matches the Bayesian HSMM published on this very buoy (arXiv 2109.09949).
   `train.py` (GMM clustering + Markov transitions) is the **interim baseline**
   for a quick look while the HSMM is built.
3. **Deep shift-forecaster** — predict the next shift (Δdir, minutes-until,
   P(persistent vs oscillating), lake-breeze onset) from raw 1-min windows.
   Persistence + gradient-boosted baselines first, then a TCN/LSTM → ONNX, run
   on the Mendota view. *(after the HSMM)*

The segmenter (`shifts.py`) is a faithful port of the app's engine
(`src/lib/oscillation.ts`), so a "shift" means the same thing here as on screen.

**Lake-breeze index** (`data.lake_breeze_index`): ε ∝ U²/ΔT, ΔT = AOSS-tower
land air − buoy lake-surface water (both °C, same API). The classic
[Lyons 1972] predictor of the dominant afternoon shift — used as an HSMM
duration covariate and a forecaster feature.

## Files
- `data.py` — pull N years of 1-min wind from the SSEC API (stdlib only).
- `shifts.py` — unwrap → circular mean → change-point detection → segment
  features + shift events (pure Python, no deps).
- `train.py` — layers 1–2; writes `artifacts/shift_model.json`.

## Run
```bash
cd ml
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python train.py --days 60 --stride 3   # fast dev pass
python train.py --days 1825            # full 5-year artifact (~10–15 min)
```
`data.py` + `shifts.py` need **no** dependencies; only `train.py` needs
numpy/scikit-learn. Verified: 10 days → 173 segments / 161 shift events in ~4.5 s,
so 5 years runs in ~10–15 min on CPU.

## Where to run it (free)
- **Locally** (recommended to start) — it's an infrequent ~10-min job; run it by
  hand, or schedule monthly with `launchd`/`cron` on your Mac.
- **Modal** — free monthly credits + built-in cron + optional GPU; best
  hands-off option, and scales to the deep model (layer 3).
- **Kaggle / Colab** — free GPU for iterating the deep model.
- (Not GitHub Actions — out of credits. Not Azure — overkill for this.)

## Artifacts → app
`artifacts/shift_model.json` is small (centroids, scaler, transition matrices).
The deep model (layer 3) exports `*.onnx`, run via `onnxruntime-node` on the
**Mendota** views only (MYC isn't part of training for now).
