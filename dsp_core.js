/**
 * @file dsp_core.js
 * @module DSPCore
 * @description
 *   Core Digital Signal Processing (DSP) mathematical algorithms for
 *   AcousticLens.  Every routine is implemented from scratch — no external
 *   DSP libraries.  All exported symbols are attached to the global
 *   `DSPCore` object so they are accessible from app.js when loaded as a
 *   plain <script> tag.
 *
 *   Standards cited throughout:
 *     • Cooley & Tukey 1965 — Radix-2 FFT algorithm
 *     • Harris 1978 (Proc. IEEE) — Window functions for DFT
 *     • IEEE Std 1241-2010 — ADC/DAC test methods (SNR, ENOB)
 *     • IEC 61672-1:2013 — Electroacoustics, A-weighting filter
 *     • ISO 226:2023 — Equal-loudness contours (A-weighting basis)
 *     • Shannon 1949 / Nyquist 1928 — Sampling theorem
 *     • Oppenheim & Schafer, "Discrete-Time Signal Processing," 3rd ed.
 */

'use strict';

// ─── 1. Window Functions ──────────────────────────────────────────────────────

/**
 * Computes a Hamming window of length N.
 *
 * Formula:
 *   w(n) = 0.54 − 0.46 · cos(2π·n / (N−1)),   0 ≤ n ≤ N−1
 *
 * Physics / Standard:
 *   A raised-cosine taper that reduces spectral leakage caused by the
 *   implicit rectangular window inherent in block-DFT analysis (Gibbs
 *   phenomenon).  Compared with a rectangular window the Hamming window
 *   provides ≈ 41 dB peak side-lobe attenuation at the cost of a slightly
 *   wider main lobe (8 × Δf bin width).
 *
 *   Reference: Harris, F.J., "On the Use of Windows for Harmonic Analysis
 *   with the Discrete Fourier Transform," Proc. IEEE, Vol. 66, No. 1,
 *   Jan. 1978.
 *
 * @param {number} N - Window length (number of samples).
 * @returns {Float64Array} Hamming window coefficients, length N.
 */
function hammingWindow(N) {
    const w = new Float64Array(N);
    const denom = N - 1;
    for (let n = 0; n < N; n++) {
        w[n] = 0.54 - 0.46 * Math.cos((2.0 * Math.PI * n) / denom);
    }
    return w;
}

/**
 * Applies a window function element-wise to a real signal.
 *
 * Formula:
 *   x_w[n] = x[n] · w[n],   0 ≤ n ≤ N−1
 *
 * Standard:
 *   ITU-T P.56 — "Objective measurement of active speech level."  The
 *   windowing step must precede any DFT-based spectral analysis to avoid
 *   the rectangular-window artefacts (spectral smearing / leakage) that
 *   corrupt frequency estimates.
 *
 * @param {Float32Array|Float64Array} signal - Time-domain input samples.
 * @param {Float64Array}             window - Window coefficients (same length).
 * @returns {Float64Array} Windowed signal.
 */
function applyWindow(signal, window) {
    const N = signal.length;
    const out = new Float64Array(N);
    for (let n = 0; n < N; n++) {
        out[n] = signal[n] * window[n];
    }
    return out;
}

// ─── 2. FFT / IFFT ────────────────────────────────────────────────────────────

/**
 * In-place Cooley–Tukey radix-2 Decimation-In-Time (DIT) FFT.
 *
 * Algorithm:
 *   1. Bit-reversal permutation of the input array.
 *   2. log₂(N) butterfly stages, each doubling the DFT sub-problem size.
 *
 * DFT definition:
 *   X[k] = Σ_{n=0}^{N−1} x[n] · e^{−j 2π k n / N}
 *
 * Twiddle factor per stage of length L:
 *   W_L^k = e^{−j 2π k / L} = cos(−2π k / L) + j·sin(−2π k / L)
 *
 * Butterfly:
 *   t          = W_L^k · x[i + k + L/2]
 *   x[i+k]     ← x[i+k] + t
 *   x[i+k+L/2] ← x[i+k] − t
 *
 * Constraints:
 *   N must be an exact power of 2 (radix-2 requirement).
 *   The Nyquist-Shannon theorem (Shannon 1949) constrains the useful
 *   frequency range to [0, fs/2]; bins above N/2 are conjugate-symmetric
 *   mirrors for real-valued inputs and are not displayed.
 *
 * Reference:
 *   Cooley, J.W. & Tukey, J.W., "An Algorithm for the Machine Calculation
 *   of Complex Fourier Series," Mathematics of Computation, Vol. 19,
 *   pp. 297–301, 1965.
 *
 * @param {Float64Array} re - Real part of the input/output (length 2^m).
 * @param {Float64Array} im - Imaginary part of the input/output (same length).
 */
function fft(re, im) {
    const N = re.length;

    // ── Bit-reversal permutation ─────────────────────────────────────────
    let j = 0;
    for (let i = 1; i < N; i++) {
        let bit = N >> 1;
        for (; j & bit; bit >>= 1) { j ^= bit; }
        j ^= bit;
        if (i < j) {
            let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
            tmp    = im[i]; im[i] = im[j]; im[j] = tmp;
        }
    }

    // ── Butterfly stages ─────────────────────────────────────────────────
    for (let len = 2; len <= N; len <<= 1) {
        const halfLen = len >> 1;
        const ang     = -2.0 * Math.PI / len;   // twiddle base angle
        const wRe0    = Math.cos(ang);
        const wIm0    = Math.sin(ang);

        for (let start = 0; start < N; start += len) {
            let wRe = 1.0, wIm = 0.0;           // running twiddle factor
            for (let k = 0; k < halfLen; k++) {
                const uRe = re[start + k];
                const uIm = im[start + k];
                const tRe = wRe * re[start + k + halfLen] - wIm * im[start + k + halfLen];
                const tIm = wRe * im[start + k + halfLen] + wIm * re[start + k + halfLen];

                re[start + k]            = uRe + tRe;
                im[start + k]            = uIm + tIm;
                re[start + k + halfLen]  = uRe - tRe;
                im[start + k + halfLen]  = uIm - tIm;

                // Advance twiddle factor: w ← w · W_len
                const nextWRe = wRe * wRe0 - wIm * wIm0;
                wIm           = wRe * wIm0 + wIm * wRe0;
                wRe           = nextWRe;
            }
        }
    }
}

/**
 * In-place Inverse FFT via the conjugate-symmetry identity.
 *
 * Identity used:
 *   IFFT{X} = (1/N) · conj( FFT{ conj(X) } )
 *
 * IDFT definition:
 *   x[n] = (1/N) · Σ_{k=0}^{N−1} X[k] · e^{+j 2π k n / N}
 *
 * This avoids implementing a separate inverse butterfly pass and reuses
 * the forward FFT exactly.
 *
 * Reference:
 *   Oppenheim & Schafer, "Discrete-Time Signal Processing," 3rd ed.,
 *   Prentice Hall, 2009 — §9.3 "Efficient Computation of the DFT."
 *
 * @param {Float64Array} re - Real part of frequency-domain input (modified in-place).
 * @param {Float64Array} im - Imaginary part (modified in-place).
 */
function ifft(re, im) {
    const N = re.length;

    // Conjugate the input
    for (let i = 0; i < N; i++) { im[i] = -im[i]; }

    // Forward FFT on conjugated input
    fft(re, im);

    // Conjugate and scale
    const invN = 1.0 / N;
    for (let i = 0; i < N; i++) {
        re[i] *=  invN;
        im[i]  = -im[i] * invN;
    }
}

// ─── 3. Spectral Magnitude ────────────────────────────────────────────────────

/**
 * Computes the one-sided magnitude spectrum in dBFS for the first N/2+1 bins.
 *
 * Formula:
 *   |X[k]|_dBFS = 20 · log₁₀( √(Re[k]² + Im[k]²) / (N · CG / 2) )
 *
 *   where CG = coherent gain = (1/N) Σ w[n]  (passed as windowGain).
 *   The factor N·CG/2 normalises so that a full-scale (±1) sine wave at
 *   a bin centre reads exactly 0 dBFS after windowing.
 *
 *   A floor of 1×10⁻¹² (−240 dBFS) prevents log₁₀(0).
 *
 * Standard:
 *   IEEE Std 1241-2010 §4.1.2 — "Spectral Analysis of ADC Output" —
 *   magnitude scaling and full-scale normalisation.
 *
 * @param {Float64Array} re         - Real part after FFT (length N).
 * @param {Float64Array} im         - Imaginary part after FFT (length N).
 * @param {number}       [windowGain=1] - Coherent gain of the window used.
 * @returns {Float64Array} Magnitude in dBFS, length N/2+1.
 */
function computeMagnitudeDb(re, im, windowGain) {
    const N    = re.length;
    const bins = (N >> 1) + 1;
    const cg   = (windowGain !== undefined) ? windowGain : 1.0;
    const norm = (N / 2.0) * cg;      // full-scale sine normalisation factor
    const result = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / norm;
        result[k] = 20.0 * Math.log10(Math.max(mag, 1e-12));
    }
    return result;
}

/**
 * Computes the coherent gain of a window (mean of the window coefficients).
 *
 * Formula:
 *   CG = (1/N) · Σ_{n=0}^{N−1} w[n]
 *
 * Reference:
 *   Harris 1978 (Proc. IEEE), Table I.  For the Hamming window, CG = 0.54.
 *
 * @param {Float64Array} window - Window coefficient array.
 * @returns {number} Coherent gain in [0, 1].
 */
function windowCoherentGain(window) {
    let sum = 0.0;
    for (let n = 0; n < window.length; n++) { sum += window[n]; }
    return sum / window.length;
}

// ─── 4. Colour Mapping ────────────────────────────────────────────────────────

/**
 * Maps a dBFS value to an RGB colour for spectrogram display.
 *
 * Colour scale (thermal "inferno" inspired, 5-stop gradient):
 *   0%  (minDb) → #000000  (black)
 *   25%          → #3c0064  (dark purple)
 *   50%          → #be1e2d  (dark red)
 *   75%          → #ffa500  (orange)
 *   100% (maxDb) → #ffffd2  (near-white yellow)
 *
 * Physics note: logarithmic (dB) input already provides the perceptual
 * compression appropriate for audio spectral display (Weber–Fechner law).
 *
 * @param {number} db     - Magnitude in dBFS.
 * @param {number} minDb  - Display floor (maps to black).
 * @param {number} maxDb  - Display ceiling (maps to white).
 * @returns {{r:number, g:number, b:number}} Integer RGB values in [0, 255].
 */
function magnitudeToColor(db, minDb, maxDb) {
    const t = Math.max(0.0, Math.min(1.0, (db - minDb) / (maxDb - minDb)));

    const stops = [
        { t: 0.00, r:   0, g:   0, b:   0 },
        { t: 0.25, r:  60, g:   0, b: 100 },
        { t: 0.50, r: 190, g:  30, b:  45 },
        { t: 0.75, r: 255, g: 165, b:   0 },
        { t: 1.00, r: 255, g: 255, b: 210 },
    ];

    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i].t) {
            const s0 = stops[i - 1];
            const s1 = stops[i];
            const alpha = (t - s0.t) / (s1.t - s0.t);
            return {
                r: Math.round(s0.r + alpha * (s1.r - s0.r)),
                g: Math.round(s0.g + alpha * (s1.g - s0.g)),
                b: Math.round(s0.b + alpha * (s1.b - s0.b)),
            };
        }
    }
    return { r: 255, g: 255, b: 210 };
}

// ─── 5. A-Weighting Filter ────────────────────────────────────────────────────

/**
 * Computes digital biquad (second-order section, SOS) coefficients for the
 * A-weighting filter using the bilinear transform with frequency pre-warping.
 *
 * Analog prototype (IEC 61672-1:2013, derived from ISO 226:2023 equal-loudness
 * contours):
 *
 *              k_A · s⁴
 *   H_A(s) = ──────────────────────────────────────────────
 *             (s+ω₁)² · (s+ω₂) · (s+ω₃) · (s+ω₄)²
 *
 *   where ω_i = 2π·f_i  and
 *     f₁ = 20.598 997 Hz,  f₂ = 107.652 65 Hz,
 *     f₃ = 737.862 23 Hz,  f₄ = 12 194.217 Hz
 *
 * Decomposed into THREE cascaded biquad sections via bilinear transform:
 *
 *   s = 2·fs · (1 − z⁻¹) / (1 + z⁻¹)   (bilinear, with pre-warping)
 *   Pre-warped: Ω_i = 2·fs · tan(ω_i / (2·fs))
 *
 *   Section 1 (double pole at Ω₁, double zero at DC):
 *     H₁(s) = s² / (s + Ω₁)²
 *
 *   Section 2 (poles at Ω₂ & Ω₃, double zero at DC):
 *     H₂(s) = s² / ((s + Ω₂)(s + Ω₃))
 *
 *   Section 3 (double pole at Ω₄, no zeros):
 *     H₃(s) = 1 / (s + Ω₄)²
 *
 * The normalisation constant k_A is computed numerically to give
 *   |H_A(j·2π·1000)| = 1  (0 dB at 1 kHz, per IEC 61672-1 §5.4.8).
 *
 * References:
 *   IEC 61672-1:2013 "Electroacoustics – Sound level meters – Part 1."
 *   Oppenheim & Schafer §7.2, "Design of IIR Filters by Bilinear Transformation."
 *
 * @param {number} fs - Digital sample rate in Hz.
 * @returns {Array<{b0:number,b1:number,b2:number,a1:number,a2:number}>}
 *   Array of 3 normalised biquad sections (a0 = 1).
 */
function computeAWeightingCoefficients(fs) {
    // IEC 61672-1:2013 corner frequencies (Hz)
    const f1 = 20.598997,  f2 = 107.65265,
          f3 = 737.86223,  f4 = 12194.217;

    // Analog angular frequencies (rad/s)
    const p1 = 2.0 * Math.PI * f1;
    const p2 = 2.0 * Math.PI * f2;
    const p3 = 2.0 * Math.PI * f3;
    const p4 = 2.0 * Math.PI * f4;

    // Bilinear pre-warped digital angular frequencies
    // Ω = 2·fs·tan(ω_analog / (2·fs))
    const K  = 2.0 * fs;
    const W1 = K * Math.tan(p1 / K);
    const W2 = K * Math.tan(p2 / K);
    const W3 = K * Math.tan(p3 / K);
    const W4 = K * Math.tan(p4 / K);

    const sections = [];

    // ── Section 1: s² / (s + W1)²  ──────────────────────────────────────
    // Bilinear numerator of s² → K²(1−z⁻¹)²
    // Bilinear denominator of (s+W1)² → (K+W1)² + 2(W1²−K²)z⁻¹/… (see below)
    {
        const D  = K + W1;           // denominator leading coefficient
        const b0 = (K * K) / (D * D);
        sections.push({
            b0:  b0,
            b1: -2.0 * b0,
            b2:  b0,
            a1:  2.0 * (W1 - K) / D,
            a2:  ((W1 - K) / D) * ((W1 - K) / D),
        });
    }

    // ── Section 2: s² / ((s+W2)(s+W3))  ─────────────────────────────────
    // Denominator after bilinear:
    //   a0 = K² + K·(W2+W3) + W2·W3
    //   a1 = 2·(W2·W3 − K²) / a0
    //   a2 = (K² − K·(W2+W3) + W2·W3) / a0
    {
        const SUM = W2 + W3;
        const PRO = W2 * W3;
        const A0  = K * K + K * SUM + PRO;
        const b0  = (K * K) / A0;
        sections.push({
            b0:  b0,
            b1: -2.0 * b0,
            b2:  b0,
            a1:  2.0 * (PRO - K * K) / A0,
            a2:  (K * K - K * SUM + PRO) / A0,
        });
    }

    // ── Section 3: 1 / (s + W4)²  ────────────────────────────────────────
    // Numerator after bilinear = (1+z⁻¹)² = 1 + 2z⁻¹ + z⁻²
    {
        const D  = K + W4;
        const b0 = 1.0 / (D * D);
        sections.push({
            b0:  b0,
            b1:  2.0 * b0,
            b2:  b0,
            a1:  2.0 * (W4 - K) / D,
            a2:  ((W4 - K) / D) * ((W4 - K) / D),
        });
    }

    // ── Normalise overall gain to 0 dB at 1 kHz ──────────────────────────
    // Evaluate H(e^{j·2π·1000/fs}) = product of each section's H(z) at z=e^{jω}
    const omega1k = 2.0 * Math.PI * 1000.0 / fs;
    let gainRe = 1.0, gainIm = 0.0;

    for (const sec of sections) {
        // z⁻¹ = e^{−jω}, z⁻² = e^{−j2ω}
        const c1 = Math.cos(omega1k),  s1 = -Math.sin(omega1k);  // z⁻¹
        const c2 = Math.cos(2*omega1k), s2 = -Math.sin(2*omega1k); // z⁻²

        const numRe = sec.b0 + sec.b1 * c1 + sec.b2 * c2;
        const numIm =          sec.b1 * s1 + sec.b2 * s2;
        const denRe = 1.0  + sec.a1 * c1 + sec.a2 * c2;
        const denIm =         sec.a1 * s1 + sec.a2 * s2;

        const denom2 = denRe * denRe + denIm * denIm;
        const hRe = (numRe * denRe + numIm * denIm) / denom2;
        const hIm = (numIm * denRe - numRe * denIm) / denom2;

        const nRe = gainRe * hRe - gainIm * hIm;
        gainIm     = gainRe * hIm + gainIm * hRe;
        gainRe     = nRe;
    }

    const gainMag  = Math.sqrt(gainRe * gainRe + gainIm * gainIm);
    const normGain = (gainMag > 1e-12) ? (1.0 / gainMag) : 1.0;

    // Apply normalisation factor to section 1 numerator only
    sections[0].b0 *= normGain;
    sections[0].b1 *= normGain;
    sections[0].b2 *= normGain;

    return sections;
}

/**
 * Applies a cascade of second-order IIR (biquad) sections to a signal buffer.
 *
 * Direct Form II Transposed structure per section:
 *   y[n] = b0·x[n] + b1·x[n−1] + b2·x[n−2]
 *          − a1·y[n−1] − a2·y[n−2]
 *
 * Standard:
 *   AES17-2015 "AES standard method of measurement of properties of digital
 *   audio equipment."  Direct Form II Transposed is preferred for
 *   fixed-point and floating-point implementations alike due to its minimal
 *   intermediate accumulation error.
 *
 * @param {Float32Array|Float64Array}                     signal   - Input samples.
 * @param {Array<{b0,b1,b2,a1,a2}>}                      sections - Biquad SOS coefficients.
 * @returns {Float64Array} Filtered output signal.
 */
function applyBiquadSections(signal, sections) {
    let buf = new Float64Array(signal);
    for (const sec of sections) {
        const out = new Float64Array(buf.length);
        let x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
        for (let n = 0; n < buf.length; n++) {
            const x0 = buf[n];
            const y0 = sec.b0 * x0 + sec.b1 * x1 + sec.b2 * x2
                                    - sec.a1 * y1  - sec.a2 * y2;
            out[n] = y0;
            x2 = x1; x1 = x0;
            y2 = y1; y1 = y0;
        }
        buf = out;
    }
    return buf;
}

// ─── 6. IEEE 1241 Analysis Metrics ───────────────────────────────────────────

/**
 * Computes the Signal-to-Noise Ratio (SNR) from a one-sided dBFS magnitude
 * spectrum.
 *
 * Formula (IEEE Std 1241-2010 §4.1.3):
 *   SNR [dB] = 10 · log₁₀( P_signal / P_noise )
 *
 *   P_signal = Σ_{k ∈ S}  10^{M[k]/10}
 *   P_noise  = Σ_{k ∉ S}  10^{M[k]/10}
 *
 * Signal bin set S: all bins within SIGNAL_WINDOW bins of the spectral peak
 * (excluding DC at k=0).  This heuristic isolates the dominant tone; for
 * wideband audio, interpret SNR as a rough dynamic-range indicator.
 *
 * Standard:
 *   IEEE Std 1241-2010, "IEEE Standard for Terminology and Test Methods for
 *   Analog-to-Digital Converters," §4.1.3, "Signal-to-Noise Ratio."
 *
 * @param {Float64Array} magnitudeDb - One-sided dBFS spectrum (from computeMagnitudeDb).
 * @returns {{ snrDb: number, peakBin: number }}
 */
function computeSNR(magnitudeDb) {
    const N = magnitudeDb.length;
    const SIGNAL_WINDOW = 4;   // ±4 bins around peak counted as signal

    // Find dominant peak (skip DC bin 0)
    let peakBin = 1;
    for (let k = 2; k < N; k++) {
        if (magnitudeDb[k] > magnitudeDb[peakBin]) peakBin = k;
    }

    let sigPow = 0.0, noisePow = 0.0;
    for (let k = 1; k < N; k++) {          // exclude DC
        const linPow = Math.pow(10.0, magnitudeDb[k] / 10.0);
        if (Math.abs(k - peakBin) <= SIGNAL_WINDOW) {
            sigPow += linPow;
        } else {
            noisePow += linPow;
        }
    }

    noisePow = Math.max(noisePow, 1e-20);
    sigPow   = Math.max(sigPow,   1e-20);

    return {
        snrDb:   10.0 * Math.log10(sigPow / noisePow),
        peakBin: peakBin,
    };
}

/**
 * Computes the Effective Number of Bits (ENOB) from the measured SNR.
 *
 * Formula (IEEE Std 1241-2010 §3.4.2):
 *   ENOB = (SNR_dB − 1.76) / 6.02
 *
 * Derivation:
 *   For an ideal N-bit uniform ADC, the theoretical SNR (sine wave input,
 *   full scale) is:  SNR_ideal = 6.02·N + 1.76  [dB].
 *   Inverting this gives ENOB — the number of bits of an ideal converter
 *   whose SNR equals the measured value.
 *
 * Standard:
 *   IEEE Std 1241-2010, §3.4.2 "Effective Number of Bits."
 *
 * @param {number} snrDb - Signal-to-Noise Ratio in dB.
 * @returns {number} ENOB (effective bits).
 */
function computeENOB(snrDb) {
    return (snrDb - 1.76) / 6.02;
}

// ─── 7. Audio Effect Helpers ─────────────────────────────────────────────────

/**
 * Generates a synthetic stereo reverb impulse-response AudioBuffer using
 * filtered, exponentially decaying white noise.
 *
 * Algorithm:
 *   For each channel, each sample i is drawn from a uniform-white-noise
 *   source and multiplied by an exponential envelope:
 *
 *     h[i] = U(−1, +1) · (1 − i/L)^decay
 *
 *   where L = ceil(fs · duration).  Higher `decay` values produce a longer,
 *   smoother tail; lower values produce an abrupt early decay.
 *
 * @param {AudioContext} audioCtx  - Web Audio API context (provides sample rate).
 * @param {number}       duration  - Reverb tail length in seconds (≥ 0.05).
 * @param {number}       decay     - Envelope shape exponent (typical range 0.1–5).
 * @returns {AudioBuffer} Stereo impulse-response buffer.
 */
function createReverbImpulse(audioCtx, duration, decay) {
    const fs     = audioCtx.sampleRate;
    const len    = Math.max(1, Math.ceil(fs * Math.max(0.05, duration)));
    const buffer = audioCtx.createBuffer(2, len, fs);

    for (let ch = 0; ch < 2; ch++) {
        const d = buffer.getChannelData(ch);
        for (let i = 0; i < len; i++) {
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, Math.max(0.1, decay));
        }
    }
    return buffer;
}

/**
 * Generates a WaveShaperNode distortion curve using the standard soft-clip
 * formula widely used in guitar-amp simulations:
 *
 *   y = ((π + k) · x) / (π + k · |x|)
 *
 * where k = amount (0 = no distortion, 400 = extreme clipping).
 * The curve is symmetric around zero (odd function) for zero DC offset.
 *
 * @param {number} amount - Distortion amount (0–400).  Values > 200 produce
 *                          near-hard-clipping.
 * @returns {Float32Array} 512-point waveshaping curve mapped to [−1, +1].
 */
function createDistortionCurve(amount) {
    const n     = 512;
    const curve = new Float32Array(n);
    const k     = Math.max(0, amount);
    for (let i = 0; i < n; i++) {
        const x    = (i * 2) / (n - 1) - 1;   // x ∈ [−1, +1]
        curve[i]   = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

// ─── 8. Utility ───────────────────────────────────────────────────────────────

/**
 * Builds a one-sided linear frequency axis for the first N/2+1 FFT bins.
 *
 * Formula:
 *   f[k] = k · fs / N,   0 ≤ k ≤ N/2
 *
 * Nyquist-Shannon constraint:
 *   The highest representable frequency f[N/2] = fs/2 must satisfy
 *   fs/2 ≥ f_max to prevent aliasing — verified in app.js::initAudioContext.
 *
 * @param {number} N  - FFT length (number of time-domain samples).
 * @param {number} fs - Sample rate in Hz.
 * @returns {Float64Array} Frequency values in Hz, length N/2+1.
 */
function frequencyAxis(N, fs) {
    const bins = (N >> 1) + 1;
    const axis = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
        axis[k] = k * fs / N;
    }
    return axis;
}

// ─── Public API (browser global + Node.js compatible) ────────────────────────
// Attaches to globalThis so the object is accessible as `DSPCore` in both
// a browser window (globalThis === window) and a Node.js eval context.

/** @namespace DSPCore */
globalThis.DSPCore = Object.freeze({
    hammingWindow,
    applyWindow,
    fft,
    ifft,
    computeMagnitudeDb,
    windowCoherentGain,
    magnitudeToColor,
    computeAWeightingCoefficients,
    applyBiquadSections,
    computeSNR,
    computeENOB,
    frequencyAxis,
    createReverbImpulse,
    createDistortionCurve,
});
