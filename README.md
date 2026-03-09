# AcousticLens: Real-Time Web DSP & Filter-Bank Designer



## 1. Abstract
AcousticLens is a zero-dependency, bare-metal JavaScript implementation of a real-time audio signal processing pipeline. It bridges continuous-time acoustic phenomena with discrete-time browser processing via the Web Audio API. 

This tool serves two primary functions:
1. **Acoustic Fingerprinting:** Real-time spectral decomposition of environmental noise using a windowed Short-Time Fourier Transform (STFT).
2. **Interactive Filter Design:** On-the-fly generation of Finite Impulse Response (FIR) filter coefficients derived from user-drawn frequency responses via an Inverse Fast Fourier Transform (IFFT) frequency-sampling method.

## 2. Standards Compliance & Official Documentation
This project strictly adheres to the following engineering and metrology standards:
* **Nyquist-Shannon Sampling Theorem:** Enforces $f_s \geq 2f_{max}$ for all `AudioContext` initializations to prevent aliasing.
* **ISO 226:2023:** Normalization of spectral magnitude data against normal equal-loudness-level contours to represent true human psychoacoustic perception.
* **IEEE Std 1241-2010:** (Standard for Terminology and Test Methods for Analog-to-Digital Converters) Applied for theoretical quantization noise floor and Effective Number of Bits (ENOB) estimations within the browser's 32-bit float audio pipeline.

## 3. Mathematical Models & DSP Architecture

### 3.1 Spectral Decomposition (STFT)
To map the time-domain signal $x[n]$ into the time-frequency domain, the system computes the discrete STFT:
$$X(m, \omega) = \sum_{n=-\infty}^{\infty} x[n] w[n-m] e^{-j\omega n}$$

### 3.2 Windowing Function
To mitigate spectral leakage during the FFT phase, a Hamming window $w[n]$ is applied to the time-domain data prior to transformation:
$$w[n] = 0.54 - 0.46 \cos\left(\frac{2\pi n}{N-1}\right)$$
where $N$ is the block size (typically 2048 samples).

### 3.3 FIR Filter Design (Frequency Sampling)
When a custom magnitude response $H(k)$ is defined via the UI, the impulse response $h[n]$ is calculated using the IFFT:
$$h[n] = \frac{1}{N} \sum_{k=0}^{N-1} H(k) e^{j\frac{2\pi}{N}kn}$$
The resulting $h[n]$ coefficients are loaded into a convolution engine to filter the live audio stream.

## 4. Repository Architecture

├── /docs
│   ├── IEEE_1241_Implementation_Notes.pdf
│   └── ISO_226_Equal_Loudness_Derivation.md
├── /src
│   ├── index.html          # Canvas UI and layout
│   ├── dsp_core.js         # Raw math: FFT, IFFT, Windowing algorithms
│   └── app.js              # Web Audio API routing and DOM events
├── /benchmarks
│   └── latency_report.csv  # I/O round-trip latency measurements
└── README.md

## 5. Step-by-Step Implementation Guide

### Prerequisites
* A modern web browser supporting the `Web Audio API` (Chrome 66+, Firefox 76+).
* Local development server (e.g., Python `http.server` or VS Code Live Server) to bypass CORS restrictions on microphone access.

### Execution
1. **Clone the repository:**
   `git clone https://github.com/yourusername/AcousticLens-WebDSP.git`
2. **Start the local server:**
   `python3 -m http.server 8000`
3. **Initialize the Environment:**
   Navigate to `http://localhost:8000`. Grant microphone permissions when prompted.
4. **Validation:**
   Observe the real-time STFT output. Generate a known test tone (e.g., a 440Hz sine wave) from an external device to verify the frequency bin accuracy against the canvas rendering.

## 6. Author
**Michael W. Meyers**
*M.S. Electrical Engineering* | *IEEE Student Member*
