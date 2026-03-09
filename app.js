/**
 * @file app.js
 * @module AcousticLens
 * @description
 *   Web Audio API graph construction, HTML5 Canvas rendering, and UI wiring
 *   for the AcousticLens real-time DSP studio.
 *
 *   Audio signal path:
 *     MediaStream (mic)
 *       └→ MediaStreamSourceNode
 *             └→ AnalyserNode  ─(time-domain PCM)─→ [JS processFrame loop]
 *                   └→ ConvolverNode (FIR filter, Phase 2)
 *                         └→ AudioContext.destination (speakers)
 *
 *   Processing chain per animation frame (Phase 1):
 *     getFloatTimeDomainData()  →  Hamming window  →  FFT  →  |X[k]|_dBFS
 *       →  spectrogram column render  →  SNR / ENOB display (Phase 3)
 *
 *   Standards: IEEE 1241-2010 · IEC 61672-1:2013 · ISO 226:2023
 *              W3C Web Audio API · W3C Media Capture and Streams API
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * FFT / AnalyserNode buffer length.
 * Must be a power-of-2 (radix-2 FFT constraint, Cooley & Tukey 1965).
 * At fs = 44 100 Hz → time resolution ≈ 46 ms per frame.
 * @constant {number}
 */
const FFT_SIZE = 2048;

/**
 * Spectrogram dBFS display floor.
 * Chosen to match the approximate noise floor of a 20-bit audio path
 * (20-bit ideal SNR ≈ 122 dB).
 * @constant {number}
 */
const MIN_DB = -120;

/**
 * Spectrogram dBFS display ceiling (full scale).
 * @constant {number}
 */
const MAX_DB = 0;

/**
 * Upper frequency bound used in the Nyquist check.
 * ISO 226:2023 defines the auditory range as 20 Hz – 20 kHz.
 * @constant {number}
 */
const F_MAX_HZ = 20000;

// ─── Module State ─────────────────────────────────────────────────────────────

let audioCtx        = null;   // AudioContext
let analyserNode    = null;   // AnalyserNode (time-domain capture)
let sourceNode      = null;   // MediaStreamAudioSourceNode
let convolver       = null;   // ConvolverNode (FIR filter, Phase 2)
let mediaStream     = null;   // getUserMedia stream
let animFrameId     = null;   // requestAnimationFrame handle
let isRunning       = false;

// Pre-computed Hamming window (reused every frame)
let hammingWin   = null;
let hammingCG    = 1.0;      // coherent gain of the Hamming window

// A-weighting biquad sections (Phase 3)
let aWeightSections = null;

// FIR designer state (Phase 2)
let firMagnitude = null;     // Float64Array[N/2+1], user-drawn gain curve
let isDrawing    = false;

// Canvas references
let spectroCanvas  = null;
let spectroCtx2d   = null;
let spectroImgData = null;   // persistent ImageData for O(W·H) shift

let firCanvas  = null;
let firCtx2d   = null;

// ─── 1. Audio Graph Initialisation ───────────────────────────────────────────

/**
 * Creates and configures the Web Audio API AudioContext, AnalyserNode, and
 * ConvolverNode, then verifies the Nyquist-Shannon Sampling Theorem.
 *
 * Nyquist-Shannon Sampling Theorem (Shannon 1949 / Nyquist 1928):
 *   A band-limited signal with highest frequency component f_max can be
 *   perfectly reconstructed from uniform samples taken at rate fs if and
 *   only if:
 *       fs ≥ 2 · f_max
 *   For full-band audio (f_max = 20 kHz) the minimum rate is 40 kHz.
 *   The Web Audio API defaults to the host hardware rate (typically
 *   44 100 Hz or 48 000 Hz), both of which satisfy this constraint.
 *
 * References:
 *   Shannon, C.E., "Communication in the Presence of Noise," Proc. IRE,
 *   Vol. 37, pp. 10–21, 1949.
 *   Nyquist, H., "Certain Topics in Telegraph Transmission Theory,"
 *   AIEE Trans., Vol. 47, pp. 617–644, 1928.
 *   W3C Web Audio API §1.1, "AudioContext."
 *
 * @throws {Error} If the browser does not support Web Audio API.
 * @throws {Error} If fs < 2·F_MAX_HZ (Nyquist violation).
 */
function initAudioContext() {
    const AudioCtxCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxCtor) {
        throw new Error('Web Audio API is not supported in this browser.');
    }

    audioCtx = new AudioCtxCtor();
    const fs = audioCtx.sampleRate;

    // ── Nyquist-Shannon check ────────────────────────────────────────────
    if (fs < 2 * F_MAX_HZ) {
        audioCtx.close();
        throw new Error(
            `Nyquist violation: fs = ${fs} Hz < 2·f_max = ${2 * F_MAX_HZ} Hz. ` +
            `Cannot capture full audible spectrum (0–${F_MAX_HZ / 1000} kHz).`
        );
    }
    console.info(
        `[AcousticLens] AudioContext ready.  ` +
        `fs = ${fs} Hz ≥ 2·f_max = ${2 * F_MAX_HZ} Hz  ✓ Nyquist-Shannon`
    );

    // Update sample-rate display
    const elFs = document.getElementById('sample-rate-value');
    if (elFs) elFs.textContent = `${fs.toLocaleString()} Hz`;

    // ── Pre-compute window ───────────────────────────────────────────────
    hammingWin = DSPCore.hammingWindow(FFT_SIZE);
    hammingCG  = DSPCore.windowCoherentGain(hammingWin);

    // ── Pre-compute A-weighting coefficients (Phase 3) ───────────────────
    aWeightSections = DSPCore.computeAWeightingCoefficients(fs);

    // ── AnalyserNode ─────────────────────────────────────────────────────
    // fftSize sets the time-domain buffer length (we run our own FFT; the
    // built-in FFT of AnalyserNode is unused).
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize              = FFT_SIZE;
    analyserNode.smoothingTimeConstant = 0;       // no smoothing; we own it

    // ── ConvolverNode (Phase 2 FIR filter) ───────────────────────────────
    // normalize = false: we supply pre-normalised impulse responses.
    convolver          = audioCtx.createConvolver();
    convolver.normalize = false;

    // Graph: analyser → convolver → speakers
    analyserNode.connect(convolver);
    convolver.connect(audioCtx.destination);

    // Start with identity FIR (Dirac delta → all-pass)
    _setIdentityFIR();
}

/**
 * Requests microphone access via the W3C Media Capture and Streams API and
 * connects the resulting MediaStream to the AnalyserNode.
 *
 * Echo cancellation, noise suppression, and AGC are disabled to preserve the
 * raw acoustic signal for fingerprinting analysis.
 *
 * Reference:
 *   W3C Media Capture and Streams API, "getUserMedia()," W3C Recommendation,
 *   2021.
 *
 * @async
 * @returns {Promise<void>}
 */
async function startMicrophone() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl:  false,
        },
        video: false,
    });

    // Resume context suspended by browser autoplay policy
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    sourceNode.connect(analyserNode);
    console.info('[AcousticLens] Microphone connected.');
}

/**
 * Halts audio capture: cancels the animation loop, disconnects the source
 * node, and stops all media tracks.
 */
function stopCapture() {
    isRunning = false;
    if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }
    console.info('[AcousticLens] Capture stopped.');
}

// ─── 2. Main Processing Loop (Phase 1) ───────────────────────────────────────

/**
 * Per-frame audio processing pipeline.  Scheduled via requestAnimationFrame
 * to run at the display refresh rate (~60 fps).  At each call:
 *
 *   Step 1 — Acquire time-domain PCM:
 *     getFloatTimeDomainData() returns the latest FFT_SIZE samples from the
 *     AnalyserNode's internal ring buffer.  Values are normalised to [−1, +1].
 *
 *   Step 2 — Hamming window:
 *     x_w[n] = x[n] · w(n)   (Harris 1978, reduces spectral leakage)
 *
 *   Step 3 — Radix-2 DIT FFT (Cooley & Tukey 1965):
 *     X[k] = Σ x_w[n] · e^{−j 2π k n / N}
 *
 *   Step 4 — One-sided magnitude in dBFS:
 *     |X[k]|_dBFS = 20 log₁₀( |X[k]| / (N·CG/2) )
 *     CG = coherent gain of Hamming window ≈ 0.54  (Harris 1978)
 *
 *   Step 5 — Spectrogram column render (scrolling canvas)
 *
 *   Step 6 — SNR / ENOB display update (Phase 3, IEEE 1241-2010)
 */
function processFrame() {
    if (!isRunning) return;

    // Step 1: time-domain capture
    const timeData = new Float32Array(FFT_SIZE);
    analyserNode.getFloatTimeDomainData(timeData);

    // Step 2: Hamming window
    const windowed = DSPCore.applyWindow(timeData, hammingWin);

    // Step 3: FFT (in-place, re = windowed copy, im = all zeros)
    const re = windowed;              // Float64Array returned by applyWindow
    const im = new Float64Array(FFT_SIZE);
    DSPCore.fft(re, im);

    // Step 4: magnitude in dBFS (corrected for Hamming window coherent gain)
    const magnitudeDb = DSPCore.computeMagnitudeDb(re, im, hammingCG);

    // Step 5: spectrogram
    _renderSpectrogramColumn(magnitudeDb);

    // Step 6: metrics
    _updateAnalysisDisplay(magnitudeDb);

    animFrameId = requestAnimationFrame(processFrame);
}

// ─── 3. Spectrogram Rendering (Phase 1) ──────────────────────────────────────

/**
 * Initialises the spectrogram canvas and allocates the persistent ImageData
 * pixel buffer used for column-shift rendering.
 *
 * Rendering strategy:
 *   A full-canvas ImageData buffer is kept in main memory.  For each new
 *   spectrum frame:
 *     (a) copyWithin() shifts every row left by one pixel (4 bytes per pixel).
 *     (b) The rightmost column is painted with the new spectrum colours.
 *     (c) putImageData() flushes the buffer to the GPU.
 *   This is O(W·H) per frame with no additional GPU read-back, making it
 *   practical at 60 fps for canvas sizes up to ~1280 × 512 px.
 *
 * @param {HTMLCanvasElement} canvas - The spectrogram display canvas.
 */
function initSpectrogram(canvas) {
    spectroCanvas  = canvas;
    spectroCtx2d   = canvas.getContext('2d');
    spectroImgData = spectroCtx2d.createImageData(canvas.width, canvas.height);

    // Fill with opaque black
    const data = spectroImgData.data;
    for (let i = 3; i < data.length; i += 4) { data[i] = 255; }
    spectroCtx2d.putImageData(spectroImgData, 0, 0);
}

/**
 * Shifts the spectrogram one pixel column to the left and paints the new
 * spectrum as a vertical colour strip on the right edge.
 *
 * Frequency-to-pixel mapping (linear Y-axis):
 *   Pixel row p  (0 = top, H−1 = bottom) corresponds to:
 *     f(p) = (H−1−p) · (fs/2) / (H−1)   [Hz]
 *   Nearest FFT bin index:
 *     k(p) = round( (H−1−p) · (N/2) / (H−1) )
 *
 * The linear mapping preserves equal Hz-per-pixel resolution across the full
 * Nyquist range [0, fs/2], consistent with the linear FFT bin spacing.
 *
 * @param {Float64Array} magnitudeDb - One-sided dBFS spectrum, length N/2+1.
 */
function _renderSpectrogramColumn(magnitudeDb) {
    const W    = spectroCanvas.width;
    const H    = spectroCanvas.height;
    const data = spectroImgData.data;
    const rowStride = W * 4;

    // Shift all pixel rows left by one pixel
    for (let row = 0; row < H; row++) {
        const rowOff = row * rowStride;
        data.copyWithin(rowOff, rowOff + 4, rowOff + rowStride);
    }

    // Paint new right-edge column
    const bins = magnitudeDb.length;
    for (let row = 0; row < H; row++) {
        const binIndex = Math.round((H - 1 - row) * (bins - 1) / (H - 1));
        const db       = magnitudeDb[Math.min(binIndex, bins - 1)];
        const { r, g, b } = DSPCore.magnitudeToColor(db, MIN_DB, MAX_DB);
        const off = (row * W + W - 1) * 4;
        data[off]     = r;
        data[off + 1] = g;
        data[off + 2] = b;
        data[off + 3] = 255;
    }

    spectroCtx2d.putImageData(spectroImgData, 0, 0);
    _drawSpectrogramAxes();
}

/**
 * Overlays frequency-axis tick marks and labels on the spectrogram canvas.
 * Called after every column update so labels stay above the scrolling pixels.
 *
 * Tick positions: 100 Hz, 500 Hz, 1 kHz, 2 kHz, 5 kHz, 10 kHz, 20 kHz.
 */
function _drawSpectrogramAxes() {
    const W        = spectroCanvas.width;
    const H        = spectroCanvas.height;
    const fs       = audioCtx ? audioCtx.sampleRate : 44100;
    const fNyquist = fs / 2;
    const ctx      = spectroCtx2d;

    ctx.save();
    ctx.font        = '10px monospace';
    ctx.fillStyle   = 'rgba(255,255,255,0.80)';
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth   = 1;

    const ticks = [100, 500, 1000, 2000, 5000, 10000, 20000];
    for (const f of ticks) {
        if (f > fNyquist) continue;
        const row = H - 1 - Math.round((f / fNyquist) * (H - 1));
        ctx.beginPath();
        ctx.moveTo(0,  row + 0.5);
        ctx.lineTo(32, row + 0.5);
        ctx.stroke();
        const lbl = f >= 1000 ? `${f / 1000}k` : `${f}`;
        ctx.fillText(lbl, 2, row - 2);
    }

    // Y-axis title
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.save();
    ctx.translate(W - 12, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Frequency (Hz)', 0, 0);
    ctx.restore();

    ctx.restore();
}

// ─── 4. Phase 3: Analysis Metrics Display ────────────────────────────────────

/**
 * Updates the on-screen SNR, ENOB, and peak-frequency readouts using the
 * IEEE Std 1241-2010 metrics computed by DSPCore.
 *
 * SNR formula (§4.1.3):   SNR [dB] = 10 log₁₀(P_signal / P_noise)
 * ENOB formula (§3.4.2):  ENOB     = (SNR_dB − 1.76) / 6.02
 *
 * Peak frequency: f_peak = peakBin · fs / N
 *
 * @param {Float64Array} magnitudeDb - One-sided dBFS spectrum.
 */
function _updateAnalysisDisplay(magnitudeDb) {
    const fs = audioCtx ? audioCtx.sampleRate : 44100;
    const { snrDb, peakBin } = DSPCore.computeSNR(magnitudeDb);
    const enob    = DSPCore.computeENOB(snrDb);
    const peakHz  = peakBin * fs / FFT_SIZE;

    _setText('snr-value',       `${snrDb.toFixed(1)} dB`);
    _setText('enob-value',      `${enob.toFixed(2)} bits`);
    _setText('peak-freq-value',
        peakHz < 1000
            ? `${peakHz.toFixed(0)} Hz`
            : `${(peakHz / 1000).toFixed(2)} kHz`
    );
}

// ─── 5. Phase 2: FIR Filter Designer ─────────────────────────────────────────

/**
 * Initialises the FIR Filter Designer canvas with a flat (all-pass) response
 * and attaches mouse/touch event handlers for interactive curve drawing.
 *
 * Canvas coordinate system:
 *   X-axis → frequency, logarithmically spaced: x = W · log(f/f_min) / log(f_max/f_min)
 *   Y-axis → linear gain [0, 1] top-to-bottom:  gain = 1 − y/H
 *
 * Logarithmic frequency spacing is standard in audio engineering because
 * human pitch perception follows a logarithmic scale (Bark / critical-band
 * theory, ISO 226:2023).
 *
 * @param {HTMLCanvasElement} canvas - FIR designer canvas element.
 */
function initFIRDesigner(canvas) {
    firCanvas = canvas;
    firCtx2d  = canvas.getContext('2d');

    const bins = (FFT_SIZE >> 1) + 1;
    firMagnitude = new Float64Array(bins).fill(1.0);

    _drawFIRCurve();

    const onPointerMove = (e) => {
        if (!isDrawing) return;
        const pos = _canvasPos(canvas, e);
        _paintFIRAtPos(pos.x, pos.y, canvas.width, canvas.height);
        _drawFIRCurve();
    };

    canvas.addEventListener('mousedown', (e) => {
        isDrawing = true;
        onPointerMove(e);
    });
    canvas.addEventListener('mousemove', onPointerMove);
    canvas.addEventListener('mouseup',   () => { isDrawing = false; applyFIRFilter(); });
    canvas.addEventListener('mouseleave',() => { isDrawing = false; });

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        isDrawing = true;
        onPointerMove(e.touches[0]);
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        onPointerMove(e.touches[0]);
    }, { passive: false });
    canvas.addEventListener('touchend', () => {
        isDrawing = false;
        applyFIRFilter();
    });
}

/**
 * Updates firMagnitude at the frequency bin nearest to the canvas X position.
 *
 * Frequency ↔ canvas X mapping (logarithmic):
 *   f(x) = f_min · (f_max / f_min)^(x / W)
 *   bin(f) = round( f · N / fs )
 *
 * The same PAD_TOP / PAD_BOT vertical inset used in _drawFIRCurve is applied
 * here so that drawing at the top of the canvas maps to gain = 1.0 and
 * drawing at the bottom maps to gain = 0.0.
 *
 * A ±3-bin brush width ensures smooth curves even at low pointer speeds.
 *
 * @param {number} x - Canvas X coordinate (pixels from left).
 * @param {number} y - Canvas Y coordinate (pixels from top).
 * @param {number} W - Canvas width in pixels.
 * @param {number} H - Canvas height in pixels.
 */
function _paintFIRAtPos(x, y, W, H) {
    const fs   = audioCtx ? audioCtx.sampleRate : 44100;
    const fMin = 20, fMax = fs / 2;
    const bins = firMagnitude.length;

    // Match the vertical inset from _drawFIRCurve
    const PAD_TOP = 14, PAD_BOT = 18;
    const drawH   = H - PAD_TOP - PAD_BOT;

    const freq     = fMin * Math.pow(fMax / fMin, Math.max(0, Math.min(1, x / W)));
    const binIndex = Math.round(freq * FFT_SIZE / fs);
    const gain     = Math.max(0.0, Math.min(1.0, 1.0 - (y - PAD_TOP) / drawH));

    for (let dk = -3; dk <= 3; dk++) {
        const k = binIndex + dk;
        if (k >= 0 && k < bins) {
            firMagnitude[k] = gain;
        }
    }
}

/**
 * Renders the current FIR frequency-response curve on the designer canvas,
 * including a logarithmically-spaced frequency grid and a gain grid.
 *
 * Grid lines (frequency, log-spaced): 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k Hz.
 * Grid lines (gain): 0 dB (gain=1), −6 dB, −12 dB, −20 dB, −∞ (gain=0).
 *
 * A small vertical inset (PAD_TOP / PAD_BOT) ensures that the all-pass line
 * (gain = 1.0) and the stop-band line (gain = 0) are fully visible and not
 * clipped against the canvas edges.
 */
function _drawFIRCurve() {
    const W   = firCanvas.width;
    const H   = firCanvas.height;
    const fs  = audioCtx ? audioCtx.sampleRate : 44100;
    const ctx = firCtx2d;
    const fMin = 20, fMax = fs / 2;

    // Vertical inset so gain=1 line is visibly inside the canvas
    const PAD_TOP = 14, PAD_BOT = 18;
    const drawH   = H - PAD_TOP - PAD_BOT;

    /** Map linear gain [0,1] → canvas Y pixel */
    const gainToY = (g) => PAD_TOP + (1.0 - Math.max(0, Math.min(1, g))) * drawH;

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    // ── Frequency grid (logarithmic) ─────────────────────────────────────
    ctx.strokeStyle = '#1e2a3a';
    ctx.lineWidth   = 1;
    ctx.font        = '9px monospace';
    ctx.fillStyle   = '#3a5070';

    const freqTicks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    for (const f of freqTicks) {
        if (f > fMax) continue;
        const x = Math.log(f / fMin) / Math.log(fMax / fMin) * W;
        ctx.beginPath(); ctx.moveTo(x, PAD_TOP); ctx.lineTo(x, H - PAD_BOT); ctx.stroke();
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, H - 4);
    }

    // ── Gain grid ────────────────────────────────────────────────────────
    const gainLevels = [
        { gain: 1.00, label: '0 dB'   },
        { gain: 0.50, label: '−6 dB'  },
        { gain: 0.25, label: '−12 dB' },
        { gain: 0.10, label: '−20 dB' },
        { gain: 0.00, label: '−∞'     },
    ];
    for (const gl of gainLevels) {
        const y = gainToY(gl.gain);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillText(gl.label, 2, y - 2);
    }

    // ── Magnitude curve ───────────────────────────────────────────────────
    ctx.beginPath();
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth   = 2;

    const bins = firMagnitude.length;
    let started = false;
    for (let k = 1; k < bins; k++) {
        const freq = k * fs / FFT_SIZE;
        if (freq < fMin || freq > fMax) continue;
        const x = Math.log(freq / fMin) / Math.log(fMax / fMin) * W;
        const y = gainToY(firMagnitude[k]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else          { ctx.lineTo(x, y); }
    }
    ctx.stroke();

    // ── Axis labels ───────────────────────────────────────────────────────
    ctx.fillStyle = '#6080a0';
    ctx.font      = '10px monospace';
    ctx.fillText('← Frequency (log scale) →', W / 2 - 70, H - 4);

    ctx.save();
    ctx.translate(11, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Gain ↑', 0, 0);
    ctx.restore();
}

/**
 * Converts the user-drawn frequency-domain magnitude curve into FIR filter
 * coefficients h[n] via the IFFT frequency-sampling method, then loads them
 * into the ConvolverNode.
 *
 * Algorithm (IEEE Std 1188-1996 / Oppenheim & Schafer §7.6):
 *   1. Build a Hermitian-symmetric spectrum for a real-valued FIR:
 *        H[0]   = firMagnitude[0]              (DC)
 *        H[k]   = firMagnitude[k]              1 ≤ k ≤ N/2
 *        H[N−k] = firMagnitude[k]              (conjugate symmetry)
 *
 *   2. Apply linear-phase shift to produce a causal Type-I FIR centred
 *      at n = N/2 (group delay = N/2 samples):
 *        H_lp[k] = H[k] · e^{−j π k (N−1) / N}
 *
 *   3. IFFT → h[n]   (h is real due to Hermitian symmetry)
 *
 *   4. Apply Hamming window to h[n] to reduce Gibbs artefacts at
 *      discontinuities in the drawn response (Harris 1978).
 *
 *   5. Normalise h[n] for unity DC gain:
 *        h[n] ← h[n] / Σ h[n]
 *
 *   6. Load as mono AudioBuffer into ConvolverNode.
 *
 * Standards:
 *   IEEE Std 1188-1996 "Recommended Practice for Specifying and Measuring
 *   FIR Filter Transfer Functions."
 *   W3C Web Audio API §1.17, "ConvolverNode."
 */
function applyFIRFilter() {
    if (!convolver || !audioCtx || !firMagnitude) return;

    const N  = FFT_SIZE;
    const re = new Float64Array(N);
    const im = new Float64Array(N);

    // Step 1 + 2: Hermitian-symmetric spectrum with linear-phase shift
    re[0] = firMagnitude[0];
    im[0] = 0.0;
    for (let k = 1; k <= N / 2; k++) {
        const mag = firMagnitude[Math.min(k, firMagnitude.length - 1)];
        // Linear-phase factor: e^{−j·π·k·(N−1)/N}
        const phi = -Math.PI * k * (N - 1) / N;
        re[k]     =  mag * Math.cos(phi);
        im[k]     =  mag * Math.sin(phi);
        re[N - k] =  re[k];           // conjugate symmetry: H[N−k] = H*[k]
        im[N - k] = -im[k];
    }

    // Step 3: IFFT → time-domain impulse response
    DSPCore.ifft(re, im);

    // Step 4: Apply Hamming window to reduce Gibbs artefacts
    const win = DSPCore.hammingWindow(N);
    let dcGain = 0.0;
    for (let n = 0; n < N; n++) {
        re[n] *= win[n];
        dcGain += re[n];
    }

    // Step 5: Normalise for unity DC gain
    if (Math.abs(dcGain) > 1e-10) {
        for (let n = 0; n < N; n++) { re[n] /= dcGain; }
    }

    // Step 6: Load into ConvolverNode
    const irBuf = audioCtx.createBuffer(1, N, audioCtx.sampleRate);
    irBuf.copyToChannel(new Float32Array(re), 0);
    convolver.buffer = irBuf;

    console.info(`[AcousticLens] FIR filter applied (N=${N} taps).`);
}

/**
 * Resets the ConvolverNode to a Dirac delta (δ[n]) impulse response,
 * which passes the signal unmodified (all-pass).
 *
 * δ[n] is the identity element of convolution:  x[n] * δ[n] = x[n].
 */
function _setIdentityFIR() {
    if (!audioCtx || !convolver) return;
    const irBuf  = audioCtx.createBuffer(1, FFT_SIZE, audioCtx.sampleRate);
    const irData = irBuf.getChannelData(0);
    irData[0] = 1.0;    // Dirac delta at n = 0
    convolver.buffer = irBuf;
}

// ─── 6. UI Wiring ─────────────────────────────────────────────────────────────

/**
 * Entry point called from the DOMContentLoaded handler in index.html.
 *
 * Defers AudioContext creation to the first explicit user interaction
 * (button click) to comply with the W3C Autoplay Policy — browsers require
 * a user gesture before creating or resuming an AudioContext.
 *
 * Reference: W3C Web Audio API §1.2 "Autoplay Policy."
 */
function onPageLoad() {
    const spectroEl = document.getElementById('spectrogram-canvas');
    const firEl     = document.getElementById('fir-canvas');

    if (spectroEl) initSpectrogram(spectroEl);
    if (firEl)     initFIRDesigner(firEl);

    // ── Start button ─────────────────────────────────────────────────────
    document.getElementById('btn-start').addEventListener('click', async () => {
        try {
            _setStatus('Initialising…', '#ffa500');
            if (!audioCtx) initAudioContext();
            await startMicrophone();
            isRunning = true;
            processFrame();
            _setStatus('● Recording', '#4caf50');
            document.getElementById('btn-start').disabled = true;
            document.getElementById('btn-stop').disabled  = false;
        } catch (err) {
            _setStatus('✖ Error', '#f44336');
            alert(`AcousticLens error: ${err.message}`);
            console.error(err);
        }
    });

    // ── Stop button ──────────────────────────────────────────────────────
    document.getElementById('btn-stop').addEventListener('click', () => {
        stopCapture();
        _setStatus('■ Stopped', '#f44336');
        document.getElementById('btn-start').disabled = false;
        document.getElementById('btn-stop').disabled  = true;
    });

    // ── FIR controls ─────────────────────────────────────────────────────
    document.getElementById('btn-apply-fir').addEventListener('click', applyFIRFilter);
    document.getElementById('btn-reset-fir').addEventListener('click', () => {
        if (firMagnitude) {
            firMagnitude.fill(1.0);
            _drawFIRCurve();
            _setIdentityFIR();
        }
    });
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Returns the canvas-relative {x, y} position from a mouse or touch event.
 * @param {HTMLCanvasElement} canvas
 * @param {MouseEvent|Touch}  e
 * @returns {{x:number, y:number}}
 */
function _canvasPos(canvas, e) {
    const rect  = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top)  * scaleY,
    };
}

/**
 * Sets the text content of a DOM element by ID (no-op if element is absent).
 * @param {string} id
 * @param {string} text
 */
function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/**
 * Updates the status indicator text and colour.
 * @param {string} msg   - Status message.
 * @param {string} color - CSS colour string.
 */
function _setStatus(msg, color) {
    const el = document.getElementById('status-text');
    if (!el) return;
    el.textContent  = msg;
    el.style.color  = color;
}
