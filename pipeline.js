/**
 * @file pipeline.js
 * @module PipelineEditor
 * @description
 *   Canvas-based, Simulink-style drag-and-drop signal-chain block diagram
 *   editor.  Each block corresponds to one Web Audio API node; the editor
 *   emits a plain graph-spec object whenever the topology or parameters
 *   change so that app.js can rebuild the Web Audio graph.
 *
 *   The editor has NO dependency on the Web Audio API — it is a pure UI
 *   component that produces and consumes serialisable graph specs.
 */

'use strict';

// ─── Block type registry ──────────────────────────────────────────────────────

/**
 * Definitions for every available block type.
 *
 * @typedef {Object} BlockTypeDef
 * @property {string}   label        - Human-readable name shown on the block.
 * @property {string}   color        - CSS hex color for the accent bar and border.
 * @property {boolean}  removable    - Whether the user can delete this block.
 * @property {Object}   defaultParams - Initial parameter values.
 * @property {Array<{key:string, label:string, min:number, max:number, step:number, unit:string}>} paramDefs
 */
const BLOCK_TYPES = {
    SOURCE: {
        label: 'Source', color: '#2ea043', removable: false,
        defaultParams: {},
        paramDefs: [],
    },
    OUTPUT: {
        label: 'Output', color: '#1f6feb', removable: false,
        defaultParams: {},
        paramDefs: [],
    },
    GAIN: {
        label: 'Gain', color: '#388bfd', removable: true,
        defaultParams: { gain: 1.0 },
        paramDefs: [
            { key: 'gain', label: 'Gain', min: 0, max: 4, step: 0.01, unit: '×' },
        ],
    },
    LOWPASS: {
        label: 'Low Pass', color: '#f0883e', removable: true,
        defaultParams: { frequency: 1000, Q: 0.707 },
        paramDefs: [
            { key: 'frequency', label: 'Frequency', min: 20, max: 20000, step: 1, unit: 'Hz', log: true },
            { key: 'Q', label: 'Q', min: 0.1, max: 30, step: 0.1, unit: '' },
        ],
    },
    HIGHPASS: {
        label: 'High Pass', color: '#f0883e', removable: true,
        defaultParams: { frequency: 500, Q: 0.707 },
        paramDefs: [
            { key: 'frequency', label: 'Frequency', min: 20, max: 20000, step: 1, unit: 'Hz', log: true },
            { key: 'Q', label: 'Q', min: 0.1, max: 30, step: 0.1, unit: '' },
        ],
    },
    BANDPASS: {
        label: 'Band Pass', color: '#f0883e', removable: true,
        defaultParams: { frequency: 1000, Q: 5 },
        paramDefs: [
            { key: 'frequency', label: 'Frequency', min: 20, max: 20000, step: 1, unit: 'Hz', log: true },
            { key: 'Q', label: 'Q', min: 0.1, max: 30, step: 0.1, unit: '' },
        ],
    },
    NOTCH: {
        label: 'Notch', color: '#e3b341', removable: true,
        defaultParams: { frequency: 1000, Q: 10 },
        paramDefs: [
            { key: 'frequency', label: 'Frequency', min: 20, max: 20000, step: 1, unit: 'Hz', log: true },
            { key: 'Q', label: 'Q', min: 0.1, max: 100, step: 0.1, unit: '' },
        ],
    },
    PEAKING: {
        label: 'Peak EQ', color: '#e3b341', removable: true,
        defaultParams: { frequency: 1000, Q: 5, gain: 0 },
        paramDefs: [
            { key: 'frequency', label: 'Frequency', min: 20, max: 20000, step: 1, unit: 'Hz', log: true },
            { key: 'Q', label: 'Q', min: 0.1, max: 30, step: 0.1, unit: '' },
            { key: 'gain', label: 'Gain', min: -30, max: 30, step: 0.5, unit: 'dB' },
        ],
    },
    LOWSHELF: {
        label: 'Low Shelf', color: '#e3b341', removable: true,
        defaultParams: { frequency: 200, gain: 0 },
        paramDefs: [
            { key: 'frequency', label: 'Frequency', min: 20, max: 2000, step: 1, unit: 'Hz', log: true },
            { key: 'gain', label: 'Gain', min: -30, max: 30, step: 0.5, unit: 'dB' },
        ],
    },
    HIGHSHELF: {
        label: 'High Shelf', color: '#e3b341', removable: true,
        defaultParams: { frequency: 8000, gain: 0 },
        paramDefs: [
            { key: 'frequency', label: 'Frequency', min: 2000, max: 20000, step: 1, unit: 'Hz', log: true },
            { key: 'gain', label: 'Gain', min: -30, max: 30, step: 0.5, unit: 'dB' },
        ],
    },
    COMPRESSOR: {
        label: 'Compressor', color: '#a371f7', removable: true,
        defaultParams: { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
        paramDefs: [
            { key: 'threshold', label: 'Threshold', min: -100, max: 0, step: 1, unit: 'dB' },
            { key: 'knee', label: 'Knee', min: 0, max: 40, step: 1, unit: 'dB' },
            { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, unit: ':1' },
            { key: 'attack', label: 'Attack', min: 0, max: 1, step: 0.001, unit: 's' },
            { key: 'release', label: 'Release', min: 0, max: 1, step: 0.01, unit: 's' },
        ],
    },
    DELAY: {
        label: 'Delay', color: '#58a6ff', removable: true,
        defaultParams: { delayTime: 0.3 },
        paramDefs: [
            { key: 'delayTime', label: 'Delay Time', min: 0, max: 5, step: 0.01, unit: 's' },
        ],
    },
    REVERB: {
        label: 'Reverb', color: '#79c0ff', removable: true,
        defaultParams: { duration: 2.0, decay: 0.5 },
        paramDefs: [
            { key: 'duration', label: 'Duration', min: 0.1, max: 10, step: 0.1, unit: 's' },
            { key: 'decay', label: 'Decay', min: 0.1, max: 5, step: 0.1, unit: '' },
        ],
    },
    DISTORTION: {
        label: 'Distortion', color: '#f85149', removable: true,
        defaultParams: { amount: 50 },
        paramDefs: [
            { key: 'amount', label: 'Amount', min: 0, max: 400, step: 1, unit: '' },
        ],
    },
    FIR: {
        label: 'FIR Filter', color: '#00d4ff', removable: true,
        defaultParams: {},
        paramDefs: [],
    },
    STEREO_PANNER: {
        label: 'Panner', color: '#58a6ff', removable: true,
        defaultParams: { pan: 0 },
        paramDefs: [
            { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, unit: '' },
        ],
    },
};

// ─── PipelineEditor ───────────────────────────────────────────────────────────

/**
 * Visual, canvas-based signal-chain block diagram editor.
 *
 * Usage:
 *   const editor = new PipelineEditor(canvasElement, (spec) => rebuildAudio(spec));
 *   editor.addBlock('LOWPASS', 300, 100);
 *
 * The callback receives a { blocks, connections } spec every time the graph
 * changes (topology or parameters).  The spec is fully serialisable.
 */
class PipelineEditor {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {function({blocks, connections}):void} onChange
     */
    constructor(canvas, onChange) {
        this.canvas  = canvas;
        this.ctx     = canvas.getContext('2d');
        this.onChange = onChange || (() => {});

        /** @type {Array<{id:number,type:string,x:number,y:number,w:number,h:number,params:Object}>} */
        this.blocks      = [];
        /** @type {Array<{fromId:number,toId:number}>} */
        this.connections = [];
        this._nextId     = 1;

        // Block rendering dimensions
        this.BW = 118;   // block width
        this.BH = 64;    // block height
        this.PR = 7;     // port radius

        // Interaction state
        this._dragging       = null;   // {block, ox, oy}
        this._connecting     = null;   // {block}  — drawing a wire from block's output
        this._mousePos       = { x: 0, y: 0 };
        this._selectedBlock  = null;
        this._hoveredPort    = null;   // {block, type:'input'|'output'}

        // Attach default SOURCE + OUTPUT blocks
        const cw = canvas.width;
        const ch = canvas.height;
        this._sourceBlock = this._createBlock('SOURCE', 30, ch / 2 - this.BH / 2);
        this._outputBlock = this._createBlock('OUTPUT', cw - 30 - this.BW, ch / 2 - this.BH / 2);
        this.blocks.push(this._sourceBlock, this._outputBlock);

        // Wire SOURCE → OUTPUT by default
        this.connections.push({ fromId: this._sourceBlock.id, toId: this._outputBlock.id });

        this._bindEvents();
        this._render();
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Adds a new block of the given type at an auto-chosen position.
     * @param {string} type - Key from BLOCK_TYPES.
     * @param {number} [x]  - Canvas X; if omitted, auto-positioned in the centre.
     * @param {number} [y]  - Canvas Y; if omitted, auto-positioned in the centre.
     * @returns {Object} The new block.
     */
    addBlock(type, x, y) {
        if (!BLOCK_TYPES[type]) {
            console.warn(`[Pipeline] Unknown block type "${type}"`);
            return null;
        }
        const cw = this.canvas.width;
        const ch = this.canvas.height;
        const bx = (x !== undefined) ? x : (cw / 2 - this.BW / 2 + (Math.random() - 0.5) * 40);
        const by = (y !== undefined) ? y : (ch / 2 - this.BH / 2 + (Math.random() - 0.5) * 40);
        const block = this._createBlock(type, bx, by);
        this.blocks.push(block);
        this._render();
        this._emitChange();
        return block;
    }

    /**
     * Removes a block (and all connections involving it) by ID.
     * SOURCE and OUTPUT blocks cannot be removed.
     * @param {number} id
     */
    removeBlock(id) {
        const block = this._findBlock(id);
        if (!block || !BLOCK_TYPES[block.type].removable) return;
        this.connections = this.connections.filter(c => c.fromId !== id && c.toId !== id);
        this.blocks = this.blocks.filter(b => b.id !== id);
        if (this._selectedBlock && this._selectedBlock.id === id) this._selectedBlock = null;
        this._render();
        this._emitChange();
    }

    /**
     * Removes a connection by reference equality.
     * @param {{fromId:number,toId:number}} conn
     */
    removeConnection(conn) {
        this.connections = this.connections.filter(c => c !== conn);
        this._render();
        this._emitChange();
    }

    /**
     * Updates one or more parameters of the given block.
     * @param {number} id
     * @param {Object} params - Partial params object.
     */
    updateBlockParams(id, params) {
        const block = this._findBlock(id);
        if (!block) return;
        Object.assign(block.params, params);
        this._render();
        this._emitChange();
    }

    /**
     * Returns the current graph as a plain serialisable object.
     * @returns {{blocks: Array, connections: Array}}
     */
    getGraphSpec() {
        return {
            blocks: this.blocks.map(b => ({
                id:     b.id,
                type:   b.type,
                x:      b.x,
                y:      b.y,
                params: { ...b.params },
            })),
            connections: this.connections.map(c => ({ fromId: c.fromId, toId: c.toId })),
        };
    }

    /**
     * Resets the pipeline to SOURCE → OUTPUT (identity chain).
     */
    reset() {
        const ch = this.canvas.height;
        const cw = this.canvas.width;
        this.blocks = [this._sourceBlock, this._outputBlock];
        this._sourceBlock.x = 30;
        this._sourceBlock.y = ch / 2 - this.BH / 2;
        this._outputBlock.x = cw - 30 - this.BW;
        this._outputBlock.y = ch / 2 - this.BH / 2;
        this.connections = [{ fromId: this._sourceBlock.id, toId: this._outputBlock.id }];
        this._selectedBlock = null;
        this._render();
        this._emitChange();
    }

    // ── Private helpers ─────────────────────────────────────────────────────

    _createBlock(type, x, y) {
        return {
            id:     this._nextId++,
            type,
            x,
            y,
            w:      this.BW,
            h:      this.BH,
            params: { ...BLOCK_TYPES[type].defaultParams },
        };
    }

    _findBlock(id) {
        return this.blocks.find(b => b.id === id) || null;
    }

    _emitChange() {
        this.onChange(this.getGraphSpec());
    }

    // ── Port geometry ───────────────────────────────────────────────────────

    _outputPortPos(block) {
        return { x: block.x + block.w, y: block.y + block.h / 2 };
    }

    _inputPortPos(block) {
        return { x: block.x, y: block.y + block.h / 2 };
    }

    _hitPort(mx, my) {
        const R = this.PR + 5;   // slightly larger hit target
        for (const block of this.blocks) {
            const def = BLOCK_TYPES[block.type];
            if (block.type !== 'OUTPUT') {
                const p = this._outputPortPos(block);
                if (Math.hypot(mx - p.x, my - p.y) <= R)
                    return { block, type: 'output' };
            }
            if (block.type !== 'SOURCE') {
                const p = this._inputPortPos(block);
                if (Math.hypot(mx - p.x, my - p.y) <= R)
                    return { block, type: 'input' };
            }
        }
        return null;
    }

    _hitBlock(mx, my) {
        for (let i = this.blocks.length - 1; i >= 0; i--) {
            const b = this.blocks[i];
            if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h)
                return b;
        }
        return null;
    }

    _hitConnection(mx, my) {
        for (const conn of this.connections) {
            const from = this._findBlock(conn.fromId);
            const to   = this._findBlock(conn.toId);
            if (!from || !to) continue;
            const p1  = this._outputPortPos(from);
            const p2  = this._inputPortPos(to);
            const cpx = (p1.x + p2.x) / 2;
            const cpy = (p1.y + p2.y) / 2;
            for (let t = 0; t <= 1; t += 0.04) {
                const bx = (1-t)*(1-t)*p1.x + 2*(1-t)*t*cpx + t*t*p2.x;
                const by = (1-t)*(1-t)*p1.y + 2*(1-t)*t*cpy  + t*t*p2.y;
                if (Math.hypot(mx - bx, my - by) < 7) return conn;
            }
        }
        return null;
    }

    // ── Event handling ──────────────────────────────────────────────────────

    _bindEvents() {
        const c = this.canvas;

        const pos = (e) => {
            const r  = c.getBoundingClientRect();
            const sx = c.width  / r.width;
            const sy = c.height / r.height;
            return {
                x: (e.clientX - r.left) * sx,
                y: (e.clientY - r.top)  * sy,
            };
        };

        c.addEventListener('mousedown', (e) => {
            const { x, y } = pos(e);
            const port = this._hitPort(x, y);
            if (port && port.type === 'output') {
                this._connecting = { block: port.block };
                this._mousePos   = { x, y };
                return;
            }
            const block = this._hitBlock(x, y);
            if (block) {
                this._dragging      = { block, ox: x - block.x, oy: y - block.y };
                this._selectedBlock = block;
                // Bring to front
                this.blocks = this.blocks.filter(b => b !== block);
                this.blocks.push(block);
                this._render();
                return;
            }
            this._selectedBlock = null;
            this._render();
        });

        c.addEventListener('mousemove', (e) => {
            const { x, y } = pos(e);
            this._mousePos   = { x, y };
            this._hoveredPort = this._hitPort(x, y);
            if (this._dragging) {
                this._dragging.block.x = x - this._dragging.ox;
                this._dragging.block.y = y - this._dragging.oy;
            }
            this._render();
        });

        c.addEventListener('mouseup', (e) => {
            const { x, y } = pos(e);
            if (this._connecting) {
                const port = this._hitPort(x, y);
                if (port && port.type === 'input' && port.block !== this._connecting.block) {
                    const fromId = this._connecting.block.id;
                    const toId   = port.block.id;
                    const dup = this.connections.some(c => c.fromId === fromId && c.toId === toId);
                    if (!dup) {
                        this.connections.push({ fromId, toId });
                        this._emitChange();
                    }
                }
                this._connecting = null;
                this._render();
            }
            if (this._dragging) {
                this._dragging = null;
                this._emitChange();
            }
        });

        c.addEventListener('dblclick', (e) => {
            const { x, y } = pos(e);
            const block = this._hitBlock(x, y);
            if (block) {
                c.dispatchEvent(new CustomEvent('pipeline-edit-block',
                    { detail: block, bubbles: true }));
            }
        });

        c.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const { x, y } = pos(e);
            const block = this._hitBlock(x, y);
            if (block && BLOCK_TYPES[block.type].removable) {
                this.removeBlock(block.id);
                return;
            }
            const conn = this._hitConnection(x, y);
            if (conn) this.removeConnection(conn);
        });

        // Prevent context menu eating the event before our handler
        c.addEventListener('mouseout', () => {
            if (this._connecting) { this._connecting = null; this._render(); }
        });
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    _render() {
        const ctx = this.ctx;
        const W   = this.canvas.width;
        const H   = this.canvas.height;

        // Background
        ctx.fillStyle = '#0a0e14';
        ctx.fillRect(0, 0, W, H);

        // Subtle dot grid
        ctx.fillStyle = '#1a2030';
        const gs = 22;
        for (let gx = gs; gx < W; gx += gs)
            for (let gy = gs; gy < H; gy += gs) {
                ctx.beginPath();
                ctx.arc(gx, gy, 1, 0, Math.PI * 2);
                ctx.fill();
            }

        // Draw connections
        for (const conn of this.connections) {
            const from = this._findBlock(conn.fromId);
            const to   = this._findBlock(conn.toId);
            if (!from || !to) continue;
            this._drawWire(
                this._outputPortPos(from),
                this._inputPortPos(to),
                '#58a6ff', false
            );
        }

        // Wire being dragged
        if (this._connecting) {
            this._drawWire(
                this._outputPortPos(this._connecting.block),
                this._mousePos,
                '#8b949e', true
            );
        }

        // Draw all blocks
        for (const block of this.blocks) {
            this._drawBlock(block);
        }
    }

    _drawWire(p1, p2, color, dashed) {
        const ctx  = this.ctx;
        const cpx  = (p1.x + p2.x) / 2;
        const cp1y = p1.y;
        const cp2y = p2.y;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.bezierCurveTo(cpx, cp1y, cpx, cp2y, p2.x, p2.y);
        ctx.setLineDash(dashed ? [5, 4] : []);
        ctx.strokeStyle = color;
        ctx.lineWidth   = dashed ? 1.5 : 2;
        ctx.stroke();
        ctx.setLineDash([]);

        if (!dashed) {
            // Arrowhead
            const angle = Math.atan2(p2.y - cp2y, p2.x - cpx);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(p2.x, p2.y);
            ctx.lineTo(
                p2.x - 11 * Math.cos(angle - 0.35),
                p2.y - 11 * Math.sin(angle - 0.35)
            );
            ctx.lineTo(
                p2.x - 11 * Math.cos(angle + 0.35),
                p2.y - 11 * Math.sin(angle + 0.35)
            );
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    _drawBlock(block) {
        const ctx  = this.ctx;
        const def  = BLOCK_TYPES[block.type];
        const { x, y, w, h } = block;
        const isSel = this._selectedBlock === block;

        ctx.save();

        // Drop shadow
        ctx.shadowColor   = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur    = 12;
        ctx.shadowOffsetY = 3;

        // Body
        ctx.fillStyle = '#161b22';
        this._roundRect(ctx, x, y, w, h, 7);
        ctx.fill();

        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Accent bar (top 5 px)
        ctx.fillStyle = def.color;
        this._roundRectTop(ctx, x, y, w, 5, 7);
        ctx.fill();

        // Border
        ctx.strokeStyle = isSel ? '#ffffff' : def.color;
        ctx.lineWidth   = isSel ? 2 : 1.5;
        this._roundRect(ctx, x, y, w, h, 7);
        ctx.stroke();

        // Label
        ctx.fillStyle = '#c9d1d9';
        ctx.font      = 'bold 11px Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def.label, x + w / 2, y + h / 2 - 7);

        // Param summary
        const summary = this._paramSummary(block);
        ctx.fillStyle = '#8b949e';
        ctx.font      = '9px Consolas, monospace';
        ctx.fillText(summary, x + w / 2, y + h / 2 + 9);

        // Output port (right centre)
        if (block.type !== 'OUTPUT') {
            const p       = this._outputPortPos(block);
            const hovered = this._hoveredPort && this._hoveredPort.block === block
                            && this._hoveredPort.type === 'output';
            ctx.beginPath();
            ctx.arc(p.x, p.y, this.PR, 0, Math.PI * 2);
            ctx.fillStyle   = hovered ? def.color : '#0a0e14';
            ctx.strokeStyle = def.color;
            ctx.lineWidth   = 1.5;
            ctx.fill();
            ctx.stroke();
        }

        // Input port (left centre)
        if (block.type !== 'SOURCE') {
            const p       = this._inputPortPos(block);
            const hovered = this._hoveredPort && this._hoveredPort.block === block
                            && this._hoveredPort.type === 'input';
            ctx.beginPath();
            ctx.arc(p.x, p.y, this.PR, 0, Math.PI * 2);
            ctx.fillStyle   = hovered ? '#58a6ff' : '#0a0e14';
            ctx.strokeStyle = '#58a6ff';
            ctx.lineWidth   = 1.5;
            ctx.fill();
            ctx.stroke();
        }

        ctx.restore();
    }

    _paramSummary(block) {
        const p = block.params;
        switch (block.type) {
            case 'SOURCE':      return '← input';
            case 'OUTPUT':      return 'output →';
            case 'GAIN':        return `${(p.gain ?? 1).toFixed(2)}×`;
            case 'LOWPASS':
            case 'HIGHPASS':
            case 'BANDPASS':
            case 'NOTCH':       return `${Math.round(p.frequency ?? 1000)} Hz  Q${(p.Q ?? 1).toFixed(1)}`;
            case 'PEAKING':     return `${Math.round(p.frequency ?? 1000)} Hz  ${(p.gain ?? 0) >= 0 ? '+' : ''}${(p.gain ?? 0).toFixed(1)} dB`;
            case 'LOWSHELF':
            case 'HIGHSHELF':   return `${Math.round(p.frequency ?? 1000)} Hz  ${(p.gain ?? 0) >= 0 ? '+' : ''}${(p.gain ?? 0).toFixed(1)} dB`;
            case 'COMPRESSOR':  return `${p.threshold ?? -24} dB  ${p.ratio ?? 12}:1`;
            case 'DELAY':       return `${((p.delayTime ?? 0.3) * 1000).toFixed(0)} ms`;
            case 'REVERB':      return `${(p.duration ?? 2).toFixed(1)} s`;
            case 'DISTORTION':  return `amt ${p.amount ?? 50}`;
            case 'FIR':         return 'see designer ↓';
            case 'STEREO_PANNER': return `pan ${(p.pan ?? 0).toFixed(2)}`;
            default:            return '';
        }
    }

    // ── Canvas helpers ──────────────────────────────────────────────────────

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h,     x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y,         x + r, y);
        ctx.closePath();
    }

    _roundRectTop(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x, y + h);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
}

// ─── Block parameter form builder ─────────────────────────────────────────────

/**
 * Builds an HTML form for a block's parameters.
 *
 * @param {Object} block     - Block object from PipelineEditor.
 * @param {HTMLElement} container - DOM container to fill with the form.
 * @returns {function(): Object} A getter that reads current form values.
 */
function buildParamForm(block, container) {
    const def = BLOCK_TYPES[block.type];
    container.innerHTML = '';

    if (!def || !def.paramDefs || def.paramDefs.length === 0) {
        container.textContent = 'No editable parameters.';
        return () => ({});
    }

    const inputs = {};
    for (const pd of def.paramDefs) {
        const row = document.createElement('div');
        row.className = 'param-row';

        const lbl = document.createElement('label');
        lbl.textContent = pd.label;

        const rangeInput = document.createElement('input');
        rangeInput.type  = 'range';
        rangeInput.min   = pd.min;
        rangeInput.max   = pd.max;
        rangeInput.step  = pd.step;
        rangeInput.value = block.params[pd.key] ?? pd.min;

        const numInput = document.createElement('input');
        numInput.type  = 'number';
        numInput.min   = pd.min;
        numInput.max   = pd.max;
        numInput.step  = pd.step;
        numInput.value = block.params[pd.key] ?? pd.min;

        const unitSpan = document.createElement('span');
        unitSpan.className   = 'param-unit';
        unitSpan.textContent = pd.unit || '';

        rangeInput.addEventListener('input', () => {
            numInput.value = rangeInput.value;
        });
        numInput.addEventListener('input', () => {
            rangeInput.value = numInput.value;
        });

        row.append(lbl, rangeInput, numInput, unitSpan);
        container.appendChild(row);
        inputs[pd.key] = numInput;
    }

    return () => {
        const result = {};
        for (const [key, inp] of Object.entries(inputs)) {
            result[key] = parseFloat(inp.value);
        }
        return result;
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

globalThis.PipelineEditor  = PipelineEditor;
globalThis.BLOCK_TYPES     = BLOCK_TYPES;
globalThis.buildParamForm  = buildParamForm;
