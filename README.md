# AcousticLens — Real-Time DSP Studio

A real-time, **zero-dependency** browser DSP toolchain built with the
**Web Audio API** and vanilla JavaScript.  No bundler, no npm install, no
external DSP libraries — open `index.html` and go.

> **Live demo** → deploy with one click to GitHub Pages or Vercel (see below).

---

## Features

| Phase | What it does | Standards |
|-------|-------------|-----------|
| **1 — STFT Spectrogram** | Captures live microphone audio, applies a **Hamming window** (Harris 1978), runs a hand-written **Cooley–Tukey radix-2 DIT FFT** (N = 2048), and renders a scrolling colour spectrogram on an HTML5 Canvas | Nyquist-Shannon 1949, Harris 1978 |
| **2 — FIR Filter Designer** | Draw any magnitude response curve on a logarithmic canvas; the app converts it to FIR coefficients via **IFFT frequency-sampling** and loads them into a `ConvolverNode` in real time | IEEE Std 1188-1996, Oppenheim §7.6 |
| **3 — Analysis Metrics** | Displays real-time **SNR** and **ENOB** per IEEE Std 1241-2010, with an **A-weighting** biquad filter derived from the IEC 61672-1:2013 / ISO 226:2023 equal-loudness standard | IEEE 1241-2010, IEC 61672-1:2013, ISO 226:2023 |

---

## Project Structure

```
AcousticLens-WebDSP/
├── index.html          ← UI (three-panel layout, zero framework)
├── dsp_core.js         ← All DSP math from scratch (FFT, IFFT, windowing,
│                          A-weighting, SNR, ENOB, colour mapping)
├── app.js              ← Web Audio API routing + Canvas rendering
├── vercel.json         ← Vercel static-site deployment config
├── .nojekyll           ← Disables Jekyll on GitHub Pages
└── .github/
    └── workflows/
        └── deploy.yml  ← GitHub Actions → GitHub Pages auto-deploy
```

---

## 🚀 Deploy for Free

### Option A — GitHub Pages (automatic)

1. **Fork or push** this repository to your GitHub account.
2. Go to **Settings → Pages**.
3. Under *Source*, choose **GitHub Actions**.
4. The included workflow (`.github/workflows/deploy.yml`) runs automatically
   on every push to `main` / `master` and publishes the site.
5. Your live URL will be:
   ```
   https://<your-username>.github.io/<repo-name>/
   ```

> **Important:** GitHub Pages serves over **HTTPS**, which is required for
> `getUserMedia()` (microphone access).  The site will **not** work over plain
> HTTP — always use the `https://` URL.

---

### Option B — Vercel (zero-config)

1. [Sign up for Vercel](https://vercel.com) (free Hobby plan).
2. Click **Add New → Project** and import this GitHub repository.
3. Vercel auto-detects the static site — click **Deploy**.
4. Your live URL will be:
   ```
   https://<project-name>.vercel.app
   ```

The included `vercel.json` sets security headers (CSP, Permissions-Policy)
and enables `cleanUrls` so `/index` works alongside `/index.html`.

---

### Option C — Netlify

1. [Sign up for Netlify](https://netlify.com) (free Starter plan).
2. Drag-and-drop the repository folder onto the Netlify dashboard, **or**
   connect via GitHub and deploy automatically.
3. No configuration file is required; Netlify detects `index.html` at the
   root automatically.

---

### Option D — Run locally

Because `getUserMedia()` requires a **secure context**, you cannot simply
open `index.html` as a `file://` URL in most browsers.  Use any local
HTTPS/HTTP server:

```bash
# Python 3 (simplest)
python3 -m http.server 8080
# → open http://localhost:8080

# Node.js (npx, no install needed)
npx serve .
# → open http://localhost:3000

# Node.js http-server
npx http-server -p 8080
```

Chrome and Edge allow `getUserMedia()` on `localhost` over plain HTTP, so
the Python / Node.js options above work for local development.

---

## Browser Requirements

| Requirement | Why |
|------------|-----|
| **HTTPS** (or `localhost`) | `getUserMedia()` requires a secure context (W3C Media Capture API) |
| Chrome 66+, Edge 79+, Firefox 76+, Safari 14.1+ | Web Audio API `AudioContext`, `ConvolverNode`, `getFloatTimeDomainData()` |
| Microphone permission | User must click **Allow** when prompted |

---

## Architecture & DSP Notes

### Nyquist-Shannon Theorem
On start, `initAudioContext()` verifies `fs ≥ 2 × 20 000 Hz = 40 kHz`.
The Web Audio API defaults to 44 100 Hz or 48 000 Hz, both of which satisfy
the theorem.  A hard error is thrown if the hardware sample rate is lower.

### Hamming Window
`w(n) = 0.54 − 0.46 · cos(2πn / (N−1))`  
Applied before the FFT to reduce spectral leakage; provides ≈ 41 dB
side-lobe attenuation (Harris 1978).

### Cooley–Tukey FFT
Iterative radix-2 DIT, O(N log N), no external library.  Input N must be a
power of 2.  The Hamming window coherent-gain correction is applied so the
displayed dBFS values are amplitude-accurate.

### A-Weighting Filter (Phase 3)
Three cascaded biquad sections derived from the IEC 61672-1:2013 analog
prototype via the bilinear transform with frequency pre-warping.  Gain is
normalised to exactly 0 dB at 1 kHz (verified by the unit tests).

### FIR Filter Designer (Phase 2)
Frequency-sampling method: the user-drawn curve is treated as a Hermitian-
symmetric frequency-domain specification; IFFT + Hamming window + DC-gain
normalisation produces the impulse response loaded into the `ConvolverNode`.

---

## References

| Standard / Paper | Topic |
|-----------------|-------|
| Shannon, *Proc. IRE* 1949; Nyquist, *AIEE Trans.* 1928 | Sampling theorem |
| Cooley & Tukey, *Math. Comp.* 1965 | Radix-2 FFT algorithm |
| Harris, *Proc. IEEE* 1978 | Window functions for DFT |
| IEEE Std 1241-2010 | ADC test methods (SNR, ENOB) |
| IEC 61672-1:2013 | A-weighting filter specification |
| ISO 226:2023 | Equal-loudness contours |
| Oppenheim & Schafer, *DTSP* 3rd ed. | IFFT identity, bilinear transform |
| IEEE Std 1188-1996 | FIR filter measurement |

