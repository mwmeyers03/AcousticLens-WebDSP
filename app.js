/**
 * @file app.js
 * @module AcousticLens
 * @description
 *   Web Audio API graph construction, HTML5 Canvas rendering, and UI wiring
 *   for the AcousticLens real-time DSP studio.
 *
 *   Audio signal path (configurable via pipeline editor):
 *     Source (mic or file)
 *       └→ [User-defined pipeline blocks]
 *             └→ masterAnalyser  ─→  Web Audio destination (speakers)
 *                     ↓
 *                 recorderDest  (optional, MediaRecorder taps here)
 *
 *   Processing chain per animation frame:
 *     masterAnalyser.getFloatTimeDomainData()
 *       → Hamming window → FFT → |X[k]|_dBFS
 *         → spectrogram column render
 *         → SNR / ENOB display
 *
 *   Standards: IEEE 1241-2010 · IEC 61672-1:2013 · ISO 226:2023
 *              W3C Web Audio API · W3C Media Capture and Streams API
 */

'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** FFT / AnalyserNode buffer length (power of 2). */
const FFT_SIZE = 2048;
/** Spectrogram dBFS display floor. */
const MIN_DB   = -120;
/** Spectrogram dBFS display ceiling. */
const MAX_DB   = 0;
/** Upper frequency bound for the Nyquist check (ISO 226:2023). */
const F_MAX_HZ = 20000;

// ─── Module State ──────────────────────────────────────────────────────────────

let audioCtx        = null;   // AudioContext
let masterAnalyser  = null;   // AnalyserNode (post-pipeline tap point)
let sourceNode      = null;   // MediaStreamAudioSourceNode | AudioBufferSourceNode
let mediaStream     = null;   // getUserMedia stream
let audioBuffer     = null;   // Decoded AudioBuffer for file playback
let animFrameId     = null;   // requestAnimationFrame handle
let isRunning       = false;  // Whether the processFrame loop is active

// FIR convolver — loaded by the FIR designer; inserted when a FIR block exists
let firConvolver    = null;

// Pipeline audio nodes — map of block id → AudioNode
let pipelineNodes   = new Map();
// Current pipeline graph spec
let currentPipeline = null;

// Recording state
let mediaRecorder   = null;
let recorderChunks  = [];
let recorderDest    = null;   // MediaStreamDestinationNode

// Pre-computed window + A-weighting
let hammingWin      = null;
let hammingCG       = 1.0;
let aWeightSections = null;

// FIR designer state
let firMagnitude    = null;    // Float64Array[N/2+1]
let isDrawing       = false;
let firLogRatio     = Math.log(44100 / 2 / 20);
let firFMax         = 44100 / 2;
const FIR_F_MIN     = 20;

// Canvas references
let spectroCanvas   = null;
let spectroCtx2d    = null;
let spectroImgData  = null;
let firCanvas       = null;
let firCtx2d        = null;

// Pipeline editor & visualizer instances
let pipelineEditor  = null;
let visualizer      = null;

// ─── 1. Audio Context & Graph ──────────────────────────────────────────────────

/**
 * Creates and configures the AudioContext, masterAnalyser, and FIR convolver.
 * Must be called from a user-gesture handler to satisfy the W3C Autoplay Policy.
 */
function initAudioContext() {
    const AudioCtxCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtxCtor) throw new Error('Web Audio API is not supported in this browser.');

    audioCtx = new AudioCtxCtor();
    const fs = audioCtx.sampleRate;

    if (fs < 2 * F_MAX_HZ) {
        audioCtx.close();
        throw new Error(
            `Nyquist violation: fs=${fs} Hz < 2·f_max=${2 * F_MAX_HZ} Hz.`
        );
    }
    console.info(`[AcousticLens] AudioContext ready. fs=${fs} Hz ✓`);

    // Update UI
    const elFs = document.getElementById('sample-rate-value');
    if (elFs) elFs.textContent = `${fs.toLocaleString()} Hz`;

    // Pre-compute window
    hammingWin      = DSPCore.hammingWindow(FFT_SIZE);
    hammingCG       = DSPCore.windowCoherentGain(hammingWin);
    aWeightSections = DSPCore.computeAWeightingCoefficients(fs);

    firFMax     = fs / 2;
    firLogRatio = Math.log(firFMax / FIR_F_MIN);

    // Master analyser (always at the end of the pipeline)
    masterAnalyser                      = audioCtx.createAnalyser();
    masterAnalyser.fftSize              = FFT_SIZE;
    masterAnalyser.smoothingTimeConstant = 0;
    masterAnalyser.connect(audioCtx.destination);

    // FIR convolver — identity until the FIR designer paints it
    firConvolver          = audioCtx.createConvolver();
    firConvolver.normalize = false;
    _setIdentityFIR();

    // Wire visualizer to the master analyser
    if (visualizer) visualizer.setAnalyser(masterAnalyser);

    // Rebuild the pipeline audio graph with the current spec
    if (currentPipeline) _buildAudioGraph(currentPipeline);
}

/**
 * Connects sourceNode to the pipeline and starts the animation frame loop.
 * @param {AudioNode} src - MediaStreamAudioSourceNode or AudioBufferSourceNode.
 */
function _connectSource(src) {
    sourceNode = src;
    if (currentPipeline) _buildAudioGraph(currentPipeline);
    if (!isRunning) {
        isRunning = true;
        processFrame();
    }
    if (visualizer && !visualizer._running) visualizer.start();
}

/**
 * Disconnects the current source node without tearing down the AudioContext.
 */
function _disconnectSource() {
    isRunning = false;
    if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    if (sourceNode) {
        try { sourceNode.disconnect(); } catch (_) {}
        sourceNode = null;
    }
}

// ─── 2. Pipeline Audio Graph Builder ──────────────────────────────────────────

/**
 * Rebuilds the Web Audio API graph from a pipeline graph spec.
 * Called whenever the pipeline topology or block parameters change.
 *
 * @param {{blocks:Array, connections:Array}} spec
 */
function _buildAudioGraph(spec) {
    if (!audioCtx || !masterAnalyser) return;

    // Disconnect all existing pipeline nodes
    for (const [, node] of pipelineNodes) {
        if (node && node !== sourceNode && node !== masterAnalyser) {
            try { node.disconnect(); } catch (_) {}
        }
    }
    pipelineNodes.clear();

    // Also disconnect source from everything
    if (sourceNode) { try { sourceNode.disconnect(); } catch (_) {} }

    // Create AudioNodes for each block
    for (const block of spec.blocks) {
        const node = _createNodeForBlock(block);
        if (node) pipelineNodes.set(block.id, node);
    }

    // Connect based on connections
    for (const conn of spec.connections) {
        const fromNode = pipelineNodes.get(conn.fromId);
        const toNode   = pipelineNodes.get(conn.toId);
        if (fromNode && toNode) {
            try { fromNode.connect(toNode); } catch (e) {
                console.warn('[Pipeline] connect error:', e.message);
            }
        }
    }

    // Ensure masterAnalyser → destination (it may have been disconnected above)
    try { masterAnalyser.disconnect(); } catch (_) {}
    masterAnalyser.connect(audioCtx.destination);
    if (recorderDest) masterAnalyser.connect(recorderDest);
}

/**
 * Creates an AudioNode for a pipeline block spec.
 * SOURCE maps to sourceNode; OUTPUT maps to masterAnalyser.
 *
 * @param {{id:number, type:string, params:Object}} block
 * @returns {AudioNode|null}
 */
function _createNodeForBlock(block) {
    const p = block.params || {};
    switch (block.type) {
        case 'SOURCE':
            return sourceNode || null;

        case 'OUTPUT':
            return masterAnalyser;

        case 'GAIN': {
            const n = audioCtx.createGain();
            n.gain.value = p.gain ?? 1.0;
            return n;
        }

        case 'LOWPASS':
        case 'HIGHPASS':
        case 'BANDPASS':
        case 'NOTCH':
        case 'ALLPASS': {
            const n  = audioCtx.createBiquadFilter();
            n.type   = block.type.toLowerCase();
            n.frequency.value = p.frequency ?? 1000;
            n.Q.value         = p.Q ?? 1;
            return n;
        }

        case 'PEAKING': {
            const n  = audioCtx.createBiquadFilter();
            n.type   = 'peaking';
            n.frequency.value = p.frequency ?? 1000;
            n.Q.value         = p.Q ?? 1;
            n.gain.value      = p.gain ?? 0;
            return n;
        }

        case 'LOWSHELF': {
            const n  = audioCtx.createBiquadFilter();
            n.type   = 'lowshelf';
            n.frequency.value = p.frequency ?? 200;
            n.gain.value      = p.gain ?? 0;
            return n;
        }

        case 'HIGHSHELF': {
            const n  = audioCtx.createBiquadFilter();
            n.type   = 'highshelf';
            n.frequency.value = p.frequency ?? 8000;
            n.gain.value      = p.gain ?? 0;
            return n;
        }

        case 'COMPRESSOR': {
            const n = audioCtx.createDynamicsCompressor();
            n.threshold.value = p.threshold ?? -24;
            n.knee.value      = p.knee ?? 30;
            n.ratio.value     = p.ratio ?? 12;
            n.attack.value    = p.attack ?? 0.003;
            n.release.value   = p.release ?? 0.25;
            return n;
        }

        case 'DELAY': {
            const n = audioCtx.createDelay(10.0);
            n.delayTime.value = p.delayTime ?? 0.3;
            return n;
        }

        case 'REVERB': {
            const n       = audioCtx.createConvolver();
            n.normalize   = false;
            n.buffer      = DSPCore.createReverbImpulse(
                audioCtx, p.duration ?? 2.0, p.decay ?? 0.5
            );
            return n;
        }

        case 'DISTORTION': {
            const n     = audioCtx.createWaveShaper();
            n.curve     = DSPCore.createDistortionCurve(p.amount ?? 50);
            n.oversample = '4x';
            return n;
        }

        case 'FIR':
            return firConvolver;

        case 'STEREO_PANNER': {
            const n   = audioCtx.createStereoPanner();
            n.pan.value = p.pan ?? 0;
            return n;
        }

        default:
            console.warn('[Pipeline] Unknown block type:', block.type);
            return null;
    }
}

// ─── 3. Microphone Input ────────────────────────────────────────────────────────

async function startMicrophone() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl:  false,
        },
        video: false,
    });
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    _connectSource(audioCtx.createMediaStreamSource(mediaStream));
    console.info('[AcousticLens] Microphone connected.');
}

function stopMicrophone() {
    _disconnectSource();
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }
    console.info('[AcousticLens] Microphone stopped.');
}

// ─── 4. File Playback ──────────────────────────────────────────────────────────

/**
 * Decodes an audio File/Blob and stores it in audioBuffer.
 * Supports any format the browser can decode (mp3, flac, ogg, wav, aac, …)
 * with no artificial size limit — the data is processed as a single ArrayBuffer.
 *
 * @param {File} file
 * @returns {Promise<void>}
 */
async function loadAudioFile(file) {
    _setText('file-info', `Loading: ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`);
    const progress = document.getElementById('file-progress');
    if (progress) progress.style.display = 'block';

    const arrayBuffer = await file.arrayBuffer();
    if (!audioCtx) initAudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    if (progress) progress.style.display = 'none';
    _setText('file-info',
        `✓ ${file.name}  ·  ${audioBuffer.numberOfChannels}ch  ·  ` +
        `${audioBuffer.sampleRate.toLocaleString()} Hz  ·  ` +
        `${audioBuffer.duration.toFixed(2)} s`
    );

    document.getElementById('btn-play-file').disabled  = false;
    document.getElementById('btn-stop-file').disabled  = true;
    console.info(`[AcousticLens] File decoded: ${file.name}`);
}

function playAudioFile() {
    if (!audioBuffer || !audioCtx) return;
    if (sourceNode) { try { sourceNode.stop(); } catch (_) {} }
    _disconnectSource();

    const bufSrc  = audioCtx.createBufferSource();
    bufSrc.buffer = audioBuffer;
    bufSrc.loop   = document.getElementById('chk-loop').checked;
    bufSrc.onended = () => {
        if (!bufSrc.loop) {
            _setStatus('■ File ended', '#8b949e');
            document.getElementById('btn-play-file').disabled  = false;
            document.getElementById('btn-stop-file').disabled  = true;
            isRunning = false;
        }
    };
    bufSrc.start();
    _connectSource(bufSrc);

    document.getElementById('btn-play-file').disabled  = true;
    document.getElementById('btn-stop-file').disabled  = false;
    console.info('[AcousticLens] File playback started.');
}

function stopFilePlayback() {
    if (sourceNode) {
        try { sourceNode.stop(); } catch (_) {}
    }
    _disconnectSource();
    document.getElementById('btn-play-file').disabled  = false;
    document.getElementById('btn-stop-file').disabled  = true;
}

// ─── 5. Output Recording ──────────────────────────────────────────────────────

function startRecording() {
    if (!audioCtx || !masterAnalyser) {
        alert('Start audio first, then record.');
        return;
    }
    recorderChunks = [];
    recorderDest   = audioCtx.createMediaStreamDestination();
    masterAnalyser.connect(recorderDest);

    mediaRecorder = new MediaRecorder(recorderDest.stream);
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recorderChunks.push(e.data);
    };
    mediaRecorder.start(100);

    document.getElementById('btn-record-out').disabled  = true;
    document.getElementById('btn-stop-record').disabled = false;
    document.getElementById('btn-download-rec').disabled = true;
    _setStatus('<span class="recording-dot">⏺</span> Recording…', '#f44336');
    document.getElementById('status-text').innerHTML =
        '<span class="recording-dot">⏺</span>&nbsp;Recording…';
    document.getElementById('status-text').style.color = '#f44336';
    console.info('[AcousticLens] Recording started.');
}

function stopRecording() {
    if (!mediaRecorder) return;
    mediaRecorder.stop();
    mediaRecorder.onstop = () => {
        document.getElementById('btn-download-rec').disabled = false;
        console.info(`[AcousticLens] Recording stopped. ${recorderChunks.length} chunks.`);
    };
    if (recorderDest) {
        try { masterAnalyser.disconnect(recorderDest); } catch (_) {}
        recorderDest = null;
    }
    document.getElementById('btn-record-out').disabled  = false;
    document.getElementById('btn-stop-record').disabled = true;
    _setStatus('■ Stopped', '#f44336');
}

function downloadRecording() {
    if (!recorderChunks.length) return;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/ogg';
    const blob = new Blob(recorderChunks, { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `acousticlens-recording-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${mime.includes('webm') ? 'webm' : 'ogg'}`;
    a.click();
    URL.revokeObjectURL(url);
}

// ─── 6. Main Processing Loop (spectrogram + metrics) ──────────────────────────

function processFrame() {
    if (!isRunning) return;

    const timeData = new Float32Array(FFT_SIZE);
    masterAnalyser.getFloatTimeDomainData(timeData);

    const windowed    = DSPCore.applyWindow(timeData, hammingWin);
    const re          = windowed;
    const im          = new Float64Array(FFT_SIZE);
    DSPCore.fft(re, im);
    const magnitudeDb = DSPCore.computeMagnitudeDb(re, im, hammingCG);

    _renderSpectrogramColumn(magnitudeDb);
    _updateAnalysisDisplay(magnitudeDb);

    animFrameId = requestAnimationFrame(processFrame);
}

// ─── 7. Spectrogram Rendering ──────────────────────────────────────────────────

function initSpectrogram(canvas) {
    spectroCanvas  = canvas;
    spectroCtx2d   = canvas.getContext('2d');
    spectroImgData = spectroCtx2d.createImageData(canvas.width, canvas.height);
    const data     = spectroImgData.data;
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    spectroCtx2d.putImageData(spectroImgData, 0, 0);
}

function _renderSpectrogramColumn(magnitudeDb) {
    const W    = spectroCanvas.width;
    const H    = spectroCanvas.height;
    const data = spectroImgData.data;
    const rowStride = W * 4;

    for (let row = 0; row < H; row++) {
        const rowOff = row * rowStride;
        data.copyWithin(rowOff, rowOff + 4, rowOff + rowStride);
    }

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

    for (const f of [100, 500, 1000, 2000, 5000, 10000, 20000]) {
        if (f > fNyquist) continue;
        const row = H - 1 - Math.round((f / fNyquist) * (H - 1));
        ctx.beginPath();
        ctx.moveTo(0,  row + 0.5);
        ctx.lineTo(32, row + 0.5);
        ctx.stroke();
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 2, row - 2);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.save();
    ctx.translate(W - 12, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Frequency (Hz)', 0, 0);
    ctx.restore();
    ctx.restore();
}

// ─── 8. Analysis Metrics ──────────────────────────────────────────────────────

function _updateAnalysisDisplay(magnitudeDb) {
    const fs = audioCtx ? audioCtx.sampleRate : 44100;
    const { snrDb, peakBin } = DSPCore.computeSNR(magnitudeDb);
    const enob   = DSPCore.computeENOB(snrDb);
    const peakHz = peakBin * fs / FFT_SIZE;

    _setText('snr-value',      `${snrDb.toFixed(1)} dB`);
    _setText('enob-value',     `${enob.toFixed(2)} bits`);
    _setText('peak-freq-value',
        peakHz < 1000 ? `${peakHz.toFixed(0)} Hz` : `${(peakHz / 1000).toFixed(2)} kHz`
    );
}

// ─── 9. FIR Filter Designer ────────────────────────────────────────────────────

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

    canvas.addEventListener('mousedown', (e) => { isDrawing = true; onPointerMove(e); });
    canvas.addEventListener('mousemove', onPointerMove);
    canvas.addEventListener('mouseup',   () => { isDrawing = false; applyFIRFilter(); });
    canvas.addEventListener('mouseleave',() => { isDrawing = false; });

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault(); isDrawing = true; onPointerMove(e.touches[0]);
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault(); onPointerMove(e.touches[0]);
    }, { passive: false });
    canvas.addEventListener('touchend', () => { isDrawing = false; applyFIRFilter(); });
}

function _paintFIRAtPos(x, y, W, H) {
    const fs   = audioCtx ? audioCtx.sampleRate : 44100;
    const bins = firMagnitude.length;
    const PAD_TOP = 14, PAD_BOT = 18;
    const drawH   = H - PAD_TOP - PAD_BOT;
    const freq     = FIR_F_MIN * Math.exp(Math.max(0, Math.min(1, x / W)) * firLogRatio);
    const binIndex = Math.round(freq * FFT_SIZE / fs);
    const gain     = Math.max(0.0, Math.min(1.0, 1.0 - (y - PAD_TOP) / drawH));
    for (let dk = -3; dk <= 3; dk++) {
        const k = binIndex + dk;
        if (k >= 0 && k < bins) firMagnitude[k] = gain;
    }
}

function _drawFIRCurve() {
    const W   = firCanvas.width;
    const H   = firCanvas.height;
    const ctx = firCtx2d;
    const fMin     = FIR_F_MIN;
    const fMax     = firFMax;
    const logRatio = firLogRatio;
    const PAD_TOP = 14, PAD_BOT = 18;
    const drawH   = H - PAD_TOP - PAD_BOT;
    const gainToY = (g) => PAD_TOP + (1.0 - Math.max(0, Math.min(1, g))) * drawH;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#1e2a3a';
    ctx.lineWidth   = 1;
    ctx.font        = '9px monospace';
    ctx.fillStyle   = '#3a5070';

    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        if (f > fMax) continue;
        const x = Math.log(f / fMin) / logRatio * W;
        ctx.beginPath(); ctx.moveTo(x, PAD_TOP); ctx.lineTo(x, H - PAD_BOT); ctx.stroke();
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, H - 4);
    }

    for (const gl of [
        { gain: 1.00, label: '0 dB' }, { gain: 0.50, label: '−6 dB' },
        { gain: 0.25, label: '−12 dB' }, { gain: 0.10, label: '−20 dB' },
        { gain: 0.00, label: '−∞' },
    ]) {
        const y = gainToY(gl.gain);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillText(gl.label, 2, y - 2);
    }

    ctx.beginPath();
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth   = 2;
    const fs   = audioCtx ? audioCtx.sampleRate : 44100;
    const bins = firMagnitude.length;
    let started = false;
    for (let k = 1; k < bins; k++) {
        const freq = k * fs / FFT_SIZE;
        if (freq < fMin || freq > fMax) continue;
        const x = Math.log(freq / fMin) / logRatio * W;
        const y = gainToY(firMagnitude[k]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else            ctx.lineTo(x, y);
    }
    ctx.stroke();

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

function applyFIRFilter() {
    if (!firConvolver || !audioCtx || !firMagnitude) return;
    const N  = FFT_SIZE;
    const re = new Float64Array(N);
    const im = new Float64Array(N);

    re[0] = firMagnitude[0];
    im[0] = 0.0;
    for (let k = 1; k <= N / 2; k++) {
        const mag = firMagnitude[Math.min(k, firMagnitude.length - 1)];
        const phi = -Math.PI * k * (N - 1) / N;
        re[k]     =  mag * Math.cos(phi);
        im[k]     =  mag * Math.sin(phi);
        re[N - k] =  re[k];
        im[N - k] = -im[k];
    }

    DSPCore.ifft(re, im);

    const win = DSPCore.hammingWindow(N);
    let dcGain = 0.0;
    for (let n = 0; n < N; n++) { re[n] *= win[n]; dcGain += re[n]; }
    if (Math.abs(dcGain) > 1e-10) {
        for (let n = 0; n < N; n++) re[n] /= dcGain;
    }

    const irBuf = audioCtx.createBuffer(1, N, audioCtx.sampleRate);
    irBuf.copyToChannel(new Float32Array(re), 0);
    firConvolver.buffer = irBuf;
    console.info(`[AcousticLens] FIR applied (N=${N} taps).`);
}

function _setIdentityFIR() {
    if (!audioCtx || !firConvolver) return;
    const irBuf  = audioCtx.createBuffer(1, FFT_SIZE, audioCtx.sampleRate);
    irBuf.getChannelData(0)[0] = 1.0;
    firConvolver.buffer = irBuf;
}

// ─── 10. UI Wiring ─────────────────────────────────────────────────────────────

/**
 * Entry point — called from DOMContentLoaded.
 * Defers AudioContext creation to the first user gesture (W3C Autoplay Policy).
 */
function onPageLoad() {
    // ── Canvas inits ─────────────────────────────────────────────────────
    const spectroEl = document.getElementById('spectrogram-canvas');
    const firEl     = document.getElementById('fir-canvas');
    if (spectroEl) initSpectrogram(spectroEl);
    if (firEl)     initFIRDesigner(firEl);

    // ── Pipeline editor ──────────────────────────────────────────────────
    const pipelineCanvas = document.getElementById('pipeline-canvas');
    if (pipelineCanvas) {
        pipelineEditor = new PipelineEditor(pipelineCanvas, (spec) => {
            currentPipeline = spec;
            if (audioCtx) _buildAudioGraph(spec);
        });
        currentPipeline = pipelineEditor.getGraphSpec();

        // Add-block toolbar buttons
        document.querySelectorAll('.btn-add-block').forEach(btn => {
            btn.addEventListener('click', () => {
                pipelineEditor.addBlock(btn.dataset.type);
            });
        });

        // Reset chain
        const btnReset = document.getElementById('btn-reset-pipeline');
        if (btnReset) btnReset.addEventListener('click', () => {
            if (confirm('Reset the signal chain to Source → Output?'))
                pipelineEditor.reset();
        });

        // Block params modal
        pipelineCanvas.addEventListener('pipeline-edit-block', (e) => {
            _openBlockParamsModal(e.detail);
        });
    }

    // ── Visualizer ───────────────────────────────────────────────────────
    const vizCanvas = document.getElementById('visualizer-canvas');
    if (vizCanvas) {
        visualizer = new Visualizer(vizCanvas);
        visualizer.start();

        document.querySelectorAll('.viz-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.viz-mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                visualizer.setMode(btn.dataset.mode);
            });
        });

        const partyToggle = document.getElementById('chk-party-mode');
        if (partyToggle) {
            partyToggle.addEventListener('change', () => {
                visualizer.setPartyMode(partyToggle.checked);
            });
        }
    }

    // ── Mic controls ─────────────────────────────────────────────────────
    document.getElementById('btn-start-mic').addEventListener('click', async () => {
        try {
            _setStatus('Initialising…', '#ffa500');
            if (!audioCtx) initAudioContext();
            stopFilePlayback();
            await startMicrophone();
            _setStatus('● Live Mic', '#4caf50');
            document.getElementById('btn-start-mic').disabled = true;
            document.getElementById('btn-stop-mic').disabled  = false;
        } catch (err) {
            _setStatus('✖ Error', '#f44336');
            alert(`AcousticLens error: ${err.message}`);
            console.error(err);
        }
    });

    document.getElementById('btn-stop-mic').addEventListener('click', () => {
        stopMicrophone();
        _setStatus('■ Stopped', '#8b949e');
        document.getElementById('btn-start-mic').disabled = false;
        document.getElementById('btn-stop-mic').disabled  = true;
    });

    // ── File controls ─────────────────────────────────────────────────────
    document.getElementById('btn-load-file').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });

    document.getElementById('file-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            if (!audioCtx) initAudioContext();
            await loadAudioFile(file);
            _setStatus('✓ File loaded', '#4caf50');
        } catch (err) {
            _setStatus('✖ Decode error', '#f44336');
            alert(`Failed to decode audio file: ${err.message}`);
            console.error(err);
        }
        // Reset input so same file can be re-selected
        e.target.value = '';
    });

    document.getElementById('btn-play-file').addEventListener('click', () => {
        stopMicrophone();
        document.getElementById('btn-start-mic').disabled = false;
        document.getElementById('btn-stop-mic').disabled  = true;
        playAudioFile();
        _setStatus('▶ Playing', '#4caf50');
        document.getElementById('btn-record-out').disabled = false;
    });

    document.getElementById('btn-stop-file').addEventListener('click', () => {
        stopFilePlayback();
        _setStatus('■ Stopped', '#8b949e');
        document.getElementById('btn-record-out').disabled = false;
    });

    // ── Recording controls ────────────────────────────────────────────────
    document.getElementById('btn-record-out').addEventListener('click', startRecording);
    document.getElementById('btn-stop-record').addEventListener('click', stopRecording);
    document.getElementById('btn-download-rec').addEventListener('click', downloadRecording);

    // ── FIR controls ─────────────────────────────────────────────────────
    document.getElementById('btn-apply-fir').addEventListener('click', applyFIRFilter);
    document.getElementById('btn-reset-fir').addEventListener('click', () => {
        if (firMagnitude) {
            firMagnitude.fill(1.0);
            _drawFIRCurve();
            _setIdentityFIR();
        }
    });

    // ── Block params modal close ──────────────────────────────────────────
    document.getElementById('btn-params-close').addEventListener('click', _closeBlockParamsModal);
    document.getElementById('block-params-overlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('block-params-overlay'))
            _closeBlockParamsModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') _closeBlockParamsModal();
    });
}

// ─── Block params modal ────────────────────────────────────────────────────────

let _currentEditBlock = null;
let _getParamValues   = null;

function _openBlockParamsModal(block) {
    _currentEditBlock = block;
    const overlay = document.getElementById('block-params-overlay');
    const form    = document.getElementById('block-params-form');
    const title   = document.getElementById('block-params-title');

    title.textContent = `${BLOCK_TYPES[block.type]?.label || block.type} — Parameters`;
    _getParamValues   = buildParamForm(block, form);

    document.getElementById('btn-params-apply').onclick = () => {
        if (pipelineEditor && _currentEditBlock && _getParamValues) {
            pipelineEditor.updateBlockParams(_currentEditBlock.id, _getParamValues());
        }
        _closeBlockParamsModal();
    };

    overlay.classList.add('open');
}

function _closeBlockParamsModal() {
    document.getElementById('block-params-overlay').classList.remove('open');
    _currentEditBlock = null;
    _getParamValues   = null;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _canvasPos(canvas, e) {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top)  * scaleY,
    };
}

function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function _setStatus(msg, color) {
    const el = document.getElementById('status-text');
    if (!el) return;
    el.textContent = msg;
    el.style.color = color;
}
