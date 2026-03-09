/**
 * @file visualizer.js
 * @module Visualizer
 * @description
 *   Multi-mode ambient audio visualizer with optional party-mode reactive
 *   background and beat-detection.
 *
 *   Modes:
 *     'bars'      — Classic spectrum-analyser frequency bars
 *     'waveform'  — Time-domain oscilloscope trace
 *     'circular'  — Polar spectrum (Winamp / WMP inspired)
 *     'particles' — Frequency-reactive ambient particle field
 *
 *   Party Mode:
 *     When enabled, the page background pulses to the detected beat (energy
 *     in the 60–250 Hz bass band) and bar/waveform colours cycle through
 *     a rainbow palette.
 *
 *   Usage:
 *     const viz = new Visualizer(canvasElement);
 *     viz.setAnalyser(analyserNode);   // call after AudioContext is ready
 *     viz.setMode('bars');
 *     viz.setPartyMode(true);
 *     viz.start();
 */

'use strict';

class Visualizer {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        this.canvas    = canvas;
        this.ctx       = canvas.getContext('2d');
        this.analyser  = null;
        this.mode      = 'bars';
        this.partyMode = false;

        this._rafId    = null;
        this._running  = false;

        // Frequency / time data buffers — allocated in setAnalyser()
        this._freqData  = null;   // Uint8Array, length = fftSize/2
        this._timeData  = null;   // Uint8Array, length = fftSize
        this._fftSize   = 2048;

        // Beat detection state
        this._beatHistory = new Float32Array(60).fill(0);
        this._beatIdx     = 0;
        this._beatPulse   = 0;   // 0..1, decays over time
        this._beatHue     = 0;   // degrees, cycles during party mode

        // Particle system (mode = 'particles')
        this._particles = [];
        this._initParticles(120);

        // Pre-draw a gradient for bars mode — invalidated if canvas resizes
        this._barGradient = null;
        this._lastW       = 0;
        this._lastH       = 0;
    }

    // ── Public API ────────────────────────────────────────────────────────

    /**
     * Sets the AnalyserNode to read from.
     * Can be called before or after start().
     * @param {AnalyserNode} analyser
     */
    setAnalyser(analyser) {
        this.analyser   = analyser;
        this._fftSize   = analyser.fftSize;
        this._freqData  = new Uint8Array(analyser.frequencyBinCount);
        this._timeData  = new Uint8Array(analyser.fftSize);
    }

    /**
     * Switches the visualizer mode.
     * @param {'bars'|'waveform'|'circular'|'particles'} mode
     */
    setMode(mode) {
        this.mode = mode;
        this._barGradient = null;   // invalidate cached gradient
    }

    /**
     * Enables or disables party mode.
     * @param {boolean} enabled
     */
    setPartyMode(enabled) {
        this.partyMode = enabled;
        if (!enabled) {
            // Restore body background
            document.body.style.setProperty('--party-glow', 'transparent');
            document.body.classList.remove('party-active');
        } else {
            document.body.classList.add('party-active');
        }
    }

    /** Starts the animation loop. */
    start() {
        if (this._running) return;
        this._running = true;
        this._loop();
    }

    /** Stops the animation loop. */
    stop() {
        this._running = false;
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    // ── Animation loop ────────────────────────────────────────────────────

    _loop() {
        if (!this._running) return;
        this._rafId = requestAnimationFrame(() => this._loop());
        this._frame();
    }

    _frame() {
        const W = this.canvas.width;
        const H = this.canvas.height;
        const ctx = this.ctx;

        // Collect audio data
        if (this.analyser) {
            this.analyser.getByteFrequencyData(this._freqData);
            this.analyser.getByteTimeDomainData(this._timeData);
        } else {
            // Silent buffers when no analyser is connected yet
            if (!this._freqData) {
                this._freqData = new Uint8Array(1024);
                this._timeData = new Uint8Array(2048);
            }
        }

        // Beat detection
        this._detectBeat();

        // Party-mode background pulse
        if (this.partyMode && this._beatPulse > 0.05) {
            this._beatHue = (this._beatHue + 1.5) % 360;
            const alpha = Math.min(0.35, this._beatPulse * 0.45);
            document.body.style.setProperty('--party-glow',
                `hsla(${this._beatHue},80%,45%,${alpha.toFixed(3)})`);
        } else if (this.partyMode) {
            document.body.style.setProperty('--party-glow', 'transparent');
        }

        // Clear canvas
        ctx.clearRect(0, 0, W, H);

        switch (this.mode) {
            case 'bars':      this._renderBars(W, H);      break;
            case 'waveform':  this._renderWaveform(W, H);  break;
            case 'circular':  this._renderCircular(W, H);  break;
            case 'particles': this._renderParticles(W, H); break;
            default:          this._renderBars(W, H);
        }
    }

    // ── Beat detection ────────────────────────────────────────────────────

    /**
     * Measures energy in the bass band (approx. 60–250 Hz) and sets
     * _beatPulse to 1.0 on beats, decaying exponentially between beats.
     */
    _detectBeat() {
        if (!this._freqData || this._freqData.length === 0) return;

        // Bass band bin range — approximate at 44100 Hz, fftSize 2048
        // bin width ≈ 21.5 Hz → bins 3..12 ≈ 64..258 Hz
        const lo = 3, hi = Math.min(12, this._freqData.length - 1);
        let energy = 0;
        for (let k = lo; k <= hi; k++) {
            const v = this._freqData[k] / 255;
            energy += v * v;
        }
        energy /= (hi - lo + 1);

        this._beatHistory[this._beatIdx] = energy;
        this._beatIdx = (this._beatIdx + 1) % this._beatHistory.length;

        let avg = 0;
        for (let i = 0; i < this._beatHistory.length; i++) avg += this._beatHistory[i];
        avg /= this._beatHistory.length;

        if (energy > avg * 1.5 && energy > 0.02) {
            this._beatPulse = Math.min(1, this._beatPulse + 0.6);
        }
        this._beatPulse = Math.max(0, this._beatPulse - 0.04);
    }

    // ── Bars mode ─────────────────────────────────────────────────────────

    _renderBars(W, H) {
        const ctx      = this.ctx;
        const data     = this._freqData;
        const binCount = data ? data.length : 0;
        if (binCount === 0) return;

        const barCount = Math.min(128, binCount);
        const barW     = W / barCount;
        const step     = Math.floor(binCount / barCount);

        // Background
        ctx.fillStyle = '#0a0e14';
        ctx.fillRect(0, 0, W, H);

        // Gradient
        const W2 = W, H2 = H;
        if (!this._barGradient || this._lastW !== W2 || this._lastH !== H2) {
            this._barGradient = ctx.createLinearGradient(0, H, 0, 0);
            this._barGradient.addColorStop(0,   '#003080');
            this._barGradient.addColorStop(0.5, '#0080ff');
            this._barGradient.addColorStop(0.8, '#00d4ff');
            this._barGradient.addColorStop(1.0, '#ffffff');
            this._lastW = W2; this._lastH = H2;
        }

        const hue = this.partyMode ? (this._beatHue % 360) : null;

        for (let i = 0; i < barCount; i++) {
            let sum = 0;
            for (let s = 0; s < step; s++) sum += data[i * step + s] || 0;
            const val = (sum / step) / 255;
            const bh  = Math.max(2, val * H);
            const bx  = i * barW;

            if (hue !== null) {
                const h2 = (hue + i * (360 / barCount)) % 360;
                ctx.fillStyle = `hsl(${h2}, 100%, ${30 + val * 50}%)`;
            } else {
                ctx.fillStyle = this._barGradient;
            }

            ctx.fillRect(bx + 1, H - bh, barW - 2, bh);

            // Party glow
            if (this.partyMode && this._beatPulse > 0.2) {
                ctx.save();
                ctx.shadowBlur  = 12 * this._beatPulse;
                ctx.shadowColor = `hsl(${(hue + i * 3) % 360}, 100%, 70%)`;
                ctx.fillRect(bx + 1, H - bh, barW - 2, bh);
                ctx.restore();
            }
        }

        // Centre line
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(0, H / 2);
        ctx.lineTo(W, H / 2);
        ctx.stroke();
    }

    // ── Waveform / oscilloscope mode ──────────────────────────────────────

    _renderWaveform(W, H) {
        const ctx  = this.ctx;
        const data = this._timeData;
        if (!data || data.length === 0) return;

        // Background with slight fade for persistence effect
        ctx.fillStyle = 'rgba(10, 14, 20, 0.88)';
        ctx.fillRect(0, 0, W, H);

        const mid = H / 2;
        const hue = this.partyMode ? this._beatHue : 196;  // default cyan-blue

        ctx.save();
        if (this.partyMode && this._beatPulse > 0.1) {
            ctx.shadowBlur  = 14 * this._beatPulse;
            ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
        }
        ctx.strokeStyle = `hsl(${hue}, 90%, 65%)`;
        ctx.lineWidth   = 2;
        ctx.beginPath();

        const sliceW = W / data.length;
        let first = true;
        for (let i = 0; i < data.length; i++) {
            const v = (data[i] / 128.0) - 1.0;     // [-1, 1]
            const y = mid + v * (mid * 0.9);
            const x = i * sliceW;
            if (first) { ctx.moveTo(x, y); first = false; }
            else         ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();

        // Centre dashed rule
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid); ctx.lineTo(W, mid);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // ── Circular / radial spectrum mode ───────────────────────────────────

    _renderCircular(W, H) {
        const ctx     = this.ctx;
        const data    = this._freqData;
        if (!data || data.length === 0) return;

        ctx.fillStyle = '#0a0e14';
        ctx.fillRect(0, 0, W, H);

        const cx = W / 2;
        const cy = H / 2;
        const baseR = Math.min(W, H) * 0.22;
        const maxR  = Math.min(W, H) * 0.45;
        const N     = Math.min(256, data.length);
        const angle = (Math.PI * 2) / N;

        ctx.save();

        for (let i = 0; i < N; i++) {
            const val = data[i] / 255;
            const r1  = baseR;
            const r2  = baseR + (maxR - baseR) * val;
            const a   = i * angle - Math.PI / 2;

            const hue = this.partyMode
                ? (this._beatHue + i * (360 / N)) % 360
                : (220 + i * (140 / N)) % 360;

            if (this.partyMode && this._beatPulse > 0.15) {
                ctx.shadowBlur  = 10 * this._beatPulse;
                ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
            } else {
                ctx.shadowBlur = 0;
            }

            ctx.strokeStyle = `hsl(${hue}, 90%, ${40 + val * 50}%)`;
            ctx.lineWidth   = 2;
            ctx.beginPath();
            ctx.moveTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
            ctx.lineTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a));
            ctx.stroke();
        }

        // Inner circle
        ctx.shadowBlur  = 0;
        ctx.strokeStyle = 'rgba(88,166,255,0.2)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
    }

    // ── Particle / ambient mode ───────────────────────────────────────────

    _initParticles(count) {
        this._particles = [];
        for (let i = 0; i < count; i++) {
            this._particles.push(this._newParticle());
        }
    }

    _newParticle() {
        return {
            x:    Math.random(),    // [0,1] normalised
            y:    Math.random(),
            vx:   (Math.random() - 0.5) * 0.0008,
            vy:   (Math.random() - 0.5) * 0.0008,
            size: 2 + Math.random() * 3,
            hue:  Math.random() * 360,
            life: 0.4 + Math.random() * 0.6,
        };
    }

    _renderParticles(W, H) {
        const ctx  = this.ctx;
        const data = this._freqData;
        if (!data || data.length === 0) return;

        // Get overall energy level
        let energy = 0;
        for (let i = 0; i < data.length; i++) energy += data[i];
        energy /= (data.length * 255);

        // Background fade
        ctx.fillStyle = `rgba(10, 14, 20, ${0.15 + (1 - energy) * 0.05})`;
        ctx.fillRect(0, 0, W, H);

        const hue0 = this.partyMode ? this._beatHue : 200;

        for (const p of this._particles) {
            // Speed up based on audio energy
            const speed = 1 + energy * (this.partyMode ? 8 : 4);
            p.x += p.vx * speed;
            p.y += p.vy * speed;

            // Bounce off walls
            if (p.x < 0 || p.x > 1) p.vx *= -1;
            if (p.y < 0 || p.y > 1) p.vy *= -1;
            p.x = Math.max(0, Math.min(1, p.x));
            p.y = Math.max(0, Math.min(1, p.y));

            // Colour
            const hue   = this.partyMode ? (hue0 + p.hue) % 360 : (hue0 + p.hue * 0.3) % 360;
            const lum   = 40 + energy * 50;
            const alpha = p.life * (0.4 + energy * 0.6);

            const px = p.x * W;
            const py = p.y * H;
            const sz = p.size * (1 + energy * 3);

            ctx.save();
            if (this.partyMode && this._beatPulse > 0.15) {
                ctx.shadowBlur  = 8 * this._beatPulse;
                ctx.shadowColor = `hsl(${hue}, 100%, 70%)`;
            }
            ctx.beginPath();
            ctx.arc(px, py, sz / 2, 0, Math.PI * 2);
            ctx.fillStyle = `hsla(${hue}, 90%, ${lum}%, ${alpha.toFixed(2)})`;
            ctx.fill();
            ctx.restore();

            // Slowly drift hue
            p.hue = (p.hue + 0.3) % 360;
        }

        // Occasionally respawn dim particles as bright ones on beats
        if (this._beatPulse > 0.5) {
            for (let i = 0; i < 3; i++) {
                const idx = Math.floor(Math.random() * this._particles.length);
                Object.assign(this._particles[idx], this._newParticle());
                this._particles[idx].life = 1.0;
                this._particles[idx].size = 4 + Math.random() * 6;
                this._particles[idx].hue  = this._beatHue;
            }
        }
    }
}

// ─── Export ────────────────────────────────────────────────────────────────────

globalThis.Visualizer = Visualizer;
