// Audio Engine for Ultrasonic Pulse Emission and Detection
// Uses Web Audio API with proper mobile handling

import { log } from '../utils/logger';

// ============== CONFIGURATION ==============
export const AUDIO_CONFIG = {
    FREQ_LOW: 17500,           // 17.5 kHz
    FREQ_HIGH: 19000,          // 19.0 kHz
    FREQ_THRESHOLD: 18250,     // Classification boundary
    FREQ_TOLERANCE: 250,       // ±250Hz: Accommodate Doppler & clock drift
    PULSE_DURATION_MS: 100,    // Increased: Stronger signal integration
    PULSE_GAP_MS: 80,          // Increased: Better echo rejection (prevents pulse merging)
    NUM_PULSES: 6,
    MAX_PEAKS: 20,             // Increased from 10: Prevents dropping valid pulses if echoes are strong

    // Listener config
    MIC_GAIN: 100,             // 100x amplification
    BANDPASS_LOW: 16500,       // Widen capture band
    BANDPASS_HIGH: 21000,      // Widen capture band
    FFT_SIZE: 8192,
    SNR_THRESHOLD: 1.5,        // More sensitive (1.5x noise floor)
    PEAK_MERGE_FREQ_HZ: 400,
    PEAK_MERGE_TIME_MS: 80,    // Increased from 50ms: Merge echoes better (matches pulse gap)

    // Fade envelope
    FADE_IN_MS: 10,   // Faster attack (Linear)
    FADE_OUT_MS: 20,  // Clean release
};

export type PulseType = 'H' | 'L' | '?';  // '?' = missing/unknown

export interface EmitterConfig {
    volume: number;           // 0.0 - 1.0
    freqLow: number;
    freqHigh: number;
    pulseDuration: number;    // ms
    pulseGap: number;         // ms
    useOutputFilter?: boolean; // If true, use highpass filter (reduces pops). Default: true
    filterCutoff?: number;     // Highpass filter cutoff in Hz. Default: 15000
}

export interface DetectedPeak {
    frequency: number;
    amplitude: number;
    timestamp: number;        // performance.now()
    type: PulseType;
    snr: number;
}

// ============== ULTRASONIC EMITTER ==============
export class UltrasonicEmitter {
    private audioContext: AudioContext | null = null;
    private wakeLock: WakeLockSentinel | null = null;
    private outputFilter: BiquadFilterNode | null = null; // Highpass to block pops

    async init(): Promise<void> {
        if (!this.audioContext) {
            // Try 44.1kHz - this engages Chrome's rolloff filter more aggressively
            this.audioContext = new AudioContext({ sampleRate: 44100 });
            log.info(`[Emitter] AudioContext @ ${this.audioContext.sampleRate}Hz`);

            // Single-stage highpass filter - cutoff updated dynamically in emit()
            // Default: 15kHz cutoff to block audible content while preserving ultrasonic
            const FILTER_CUTOFF = 15000;
            const FILTER_Q = 0.707; // Butterworth (flat passband)


            const filters: BiquadFilterNode[] = [];
            for (let i = 0; i < 1; i++) {  // Single stage - minimizes beeps
                const filter = this.audioContext.createBiquadFilter();
                filter.type = 'highpass';
                filter.frequency.value = FILTER_CUTOFF;
                filter.Q.value = FILTER_Q;
                filters.push(filter);
            }

            // Chain: oscillator → gain → filter → destination
            this.outputFilter = filters[0];
            for (let i = 0; i < filters.length - 1; i++) {
                filters[i].connect(filters[i + 1]);
            }
            filters[filters.length - 1].connect(this.audioContext.destination);
            log.info(`[Emitter] Highpass filter @ ${FILTER_CUTOFF}Hz enabled`);
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
            log.info('[Emitter] AudioContext resumed');
        }
        await this.requestWakeLock();
    }

    private async requestWakeLock(): Promise<void> {
        try {
            if ('wakeLock' in navigator) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                log.info('[Emitter] Wake lock acquired');
            }
        } catch {
            log.debug('[Emitter] Wake lock not available');
        }
    }

    async emit(pattern: PulseType[], config: EmitterConfig): Promise<number[]> {
        if (!this.audioContext) {
            await this.init();
        }
        const ctx = this.audioContext!;
        const emittedFreqs: number[] = [];

        const useFilter = config.useOutputFilter !== false; // Default to true
        const cutoff = config.filterCutoff ?? 15000;
        if (this.outputFilter) this.outputFilter.frequency.value = cutoff;
        log.info(`[Emitter] Emitting ${pattern.length} pulses: ${pattern.join('')}`);
        log.debug(`[Emitter] Config: vol=${config.volume}, dur=${config.pulseDuration}ms, gap=${config.pulseGap}ms, filter=${useFilter}`);

        // Schedule all pulses upfront using AudioContext.currentTime (hardware clock)
        // This is immune to browser tab throttling
        const baseTime = ctx.currentTime + 0.01; // 10ms buffer
        let scheduleTime = baseTime;

        // --- WARMUP PULSE (Fixes AGC Lag) ---
        // Emit a 40ms pulse at L frequency (17500Hz) to trigger AGC
        // Uses L freq to avoid boundary drift at 18250Hz causing random H classifications
        const WAKE_UP_FREQ = 17500;
        this.schedulePulse(ctx, WAKE_UP_FREQ, config.volume, 40, scheduleTime, useFilter);
        scheduleTime += 0.16; // 40ms pulse + 120ms gap (must exceed PEAK_MERGE_TIME_MS of 80ms)
        // ------------------------------------

        const pulseTimes: string[] = [];

        for (let i = 0; i < pattern.length; i++) {
            const freq = pattern[i] === 'H' ? config.freqHigh : config.freqLow;
            emittedFreqs.push(freq);

            // Log relative time for each pulse
            const relativeMs = Math.round((scheduleTime - baseTime) * 1000);
            pulseTimes.push(`${pattern[i]}@${relativeMs}ms`);

            this.schedulePulse(ctx, freq, config.volume, config.pulseDuration, scheduleTime, useFilter);

            // Advance schedule time for next pulse
            scheduleTime += config.pulseDuration / 1000;
            if (i < pattern.length - 1) {
                scheduleTime += config.pulseGap / 1000;
            }
        }

        log.debug(`[Emitter] Pulse schedule: ${pulseTimes.join(', ')}`);

        // Calculate total duration and wait for emission to complete
        // 160ms added for Warmup Pulse overhead (40ms pulse + 120ms gap)
        const totalDurationMs = 160 + (config.pulseDuration * pattern.length) + (config.pulseGap * (pattern.length - 1));
        await this.sleep(totalDurationMs + 50); // Small buffer for fade out

        log.success(`[Emitter] Emission complete. Freqs: ${emittedFreqs.join(', ')}`);
        return emittedFreqs;
    }

    /**
     * Schedule a single pulse using AudioContext.currentTime
     * All timing is done via Web Audio API which uses hardware clock (throttle-resistant)
     * @param useFilter - If true, route through highpass filter to reduce pops
     */
    private schedulePulse(ctx: AudioContext, freq: number, volume: number, durationMs: number, startTime: number, useFilter: boolean): void {
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        const fadeInEnd = startTime + AUDIO_CONFIG.FADE_IN_MS / 1000;
        const fadeOutStart = startTime + (durationMs - AUDIO_CONFIG.FADE_OUT_MS) / 1000;
        const endTime = startTime + durationMs / 1000;

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(freq, startTime);

        // Envelope: Linear fade in/out (Exponential starts too slow, cutting effective duration)
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(volume, fadeInEnd);
        gainNode.gain.setValueAtTime(volume, fadeOutStart);
        gainNode.gain.linearRampToValueAtTime(0, endTime);

        oscillator.connect(gainNode);

        // Route through filter (reduces pops) or directly to destination (for A/B testing)
        if (useFilter && this.outputFilter) {
            gainNode.connect(this.outputFilter);
        } else {
            gainNode.connect(ctx.destination);
        }

        oscillator.start(startTime);
        oscillator.stop(endTime + 0.01); // Small buffer after fade out
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async cleanup(): Promise<void> {
        if (this.wakeLock) {
            await this.wakeLock.release();
            this.wakeLock = null;
            log.debug('[Emitter] Wake lock released');
        }
        if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
            this.outputFilter = null; // Filter destroyed with context
            log.debug('[Emitter] AudioContext closed');
        }
    }
}

// ============== ULTRASONIC LISTENER ==============
export class UltrasonicListener {
    private audioContext: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private mediaStream: MediaStream | null = null;
    private wakeLock: WakeLockSentinel | null = null;
    private isRecording = false;
    private peaks: DetectedPeak[] = [];
    private animationFrameId: number | null = null;
    private noiseFloor: number = -100; // Start very low, adapts upward only

    async init(): Promise<void> {
        try {
            // Request microphone
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                }
            });
            log.info('[Listener] Microphone access granted');

            this.audioContext = new AudioContext();
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);

            // AUDIO CHAIN: Source → Highpass → Lowpass → Gain → Limiter → Analyser
            // (Separate HP+LP gives sharper cutoff than single bandpass)

            // 1. Highpass filter (remove sub-17kHz)
            const highpass = this.audioContext.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.value = AUDIO_CONFIG.BANDPASS_LOW;
            highpass.Q.value = 0.7;

            // 2. Lowpass filter (remove above-20kHz)
            const lowpass = this.audioContext.createBiquadFilter();
            lowpass.type = 'lowpass';
            lowpass.frequency.value = AUDIO_CONFIG.BANDPASS_HIGH;
            lowpass.Q.value = 0.7;

            // 3. Gain (60x amplification)
            const gain = this.audioContext.createGain();
            gain.gain.value = AUDIO_CONFIG.MIC_GAIN;

            // 4. Limiter (like FL Studio - prevents clipping by pushing gain down)
            const limiter = this.audioContext.createDynamicsCompressor();
            limiter.threshold.value = -6;  // Start limiting at -6dB
            limiter.knee.value = 0;        // Hard knee (true limiter)
            limiter.ratio.value = 20;      // 20:1 = very aggressive
            limiter.attack.value = 0.001;  // 1ms attack
            limiter.release.value = 0.1;   // 100ms release

            // 5. Analyser (8192 FFT for better frequency resolution)
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = AUDIO_CONFIG.FFT_SIZE;
            this.analyser.smoothingTimeConstant = 0.1;

            // Connect chain
            source.connect(highpass);
            highpass.connect(lowpass);
            lowpass.connect(gain);
            gain.connect(limiter);
            limiter.connect(this.analyser);

            // Setup visibility handler for mobile
            document.addEventListener('visibilitychange', this.handleVisibilityChange);

            await this.requestWakeLock();
            log.success('[Listener] Audio chain initialized (FFT: 8192, Gain: 60x)');
        } catch (e) {
            log.error(`[Listener] Init failed: ${e}`);
            throw e;
        }
    }

    private handleVisibilityChange = async () => {
        if (document.visibilityState === 'visible' && this.audioContext?.state === 'suspended') {
            await this.audioContext.resume();
            log.info('[Listener] AudioContext resumed after visibility change');
        }
    };

    private async requestWakeLock(): Promise<void> {
        try {
            if ('wakeLock' in navigator) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                log.debug('[Listener] Wake lock acquired');
            }
        } catch {
            log.debug('[Listener] Wake lock not available');
        }
    }

    startRecording(): void {
        if (this.isRecording) return;

        this.isRecording = true;
        this.peaks = [];
        this.noiseFloor = -100; // Reset noise floor
        log.info('[Listener] Recording started');
        this.analyzeLoop();
    }

    /**
     * Clear all recorded peaks - call when emission actually starts
     * This removes any noise captured before the teacher began emitting
     */
    clearPeaks(): void {
        const oldCount = this.peaks.length;
        this.peaks = [];
        this.noiseFloor = -100; // Reset noise floor too
        if (oldCount > 0) {
            log.debug(`[Listener] Cleared ${oldCount} pre-emission peaks`);
        }
    }

    private analyzeLoop = (): void => {
        if (!this.isRecording || !this.analyser || !this.audioContext) return;

        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        this.analyser.getFloatFrequencyData(dataArray); // Returns dB values

        const sampleRate = this.audioContext.sampleRate;
        const binSize = sampleRate / this.analyser.fftSize;

        // Find peak in ultrasonic range
        const lowBin = Math.floor(AUDIO_CONFIG.BANDPASS_LOW / binSize);
        const highBin = Math.ceil(AUDIO_CONFIG.BANDPASS_HIGH / binSize);

        let maxAmplitude = -Infinity;
        let maxBin = lowBin;

        // Also calculate median amplitude for noise floor
        const amplitudes: number[] = [];

        for (let i = lowBin; i <= highBin && i < bufferLength; i++) {
            amplitudes.push(dataArray[i]);
            if (dataArray[i] > maxAmplitude) {
                maxAmplitude = dataArray[i];
                maxBin = i;
            }
        }

        // Calculate noise floor as median (50th percentile)
        amplitudes.sort((a, b) => a - b);
        const medianAmplitude = amplitudes[Math.floor(amplitudes.length / 2)] || -100;

        // Adapt noise floor (only upward, slowly)
        if (medianAmplitude > this.noiseFloor) {
            this.noiseFloor = this.noiseFloor * 0.9 + medianAmplitude * 0.1;
        }

        // Calculate SNR (signal-to-noise ratio in dB space)
        const snr = maxAmplitude - this.noiseFloor; // dB difference
        const snrRatio = Math.pow(10, snr / 20); // Convert to linear ratio

        // Only record if SNR is above threshold (default: 2x = 6dB)
        const minSNRdB = 20 * Math.log10(AUDIO_CONFIG.SNR_THRESHOLD); // 2x = ~6dB
        const passesThreshold = snr >= minSNRdB;

        const freq = maxBin * binSize;
        const now = performance.now();

        if (passesThreshold) {
            // FREQUENCY VALIDATION: Only accept peaks near expected frequencies
            // H should be ~19000Hz ±300Hz, L should be ~17500Hz ±300Hz
            const isValidH = Math.abs(freq - AUDIO_CONFIG.FREQ_HIGH) <= AUDIO_CONFIG.FREQ_TOLERANCE;
            const isValidL = Math.abs(freq - AUDIO_CONFIG.FREQ_LOW) <= AUDIO_CONFIG.FREQ_TOLERANCE;

            if (!isValidH && !isValidL) {
                // Reject peaks outside valid frequency bands (e.g., 20004Hz interference)
                this.animationFrameId = requestAnimationFrame(this.analyzeLoop);
                return;
            }

            const type: PulseType = isValidH ? 'H' : 'L';

            // PEAK MERGING: Check if this is same peak as recent one
            const existingPeak = this.peaks.find(p =>
                Math.abs(p.frequency - freq) < AUDIO_CONFIG.PEAK_MERGE_FREQ_HZ &&
                (now - p.timestamp) < AUDIO_CONFIG.PEAK_MERGE_TIME_MS
            );

            if (existingPeak) {
                // Update if stronger
                if (maxAmplitude > existingPeak.amplitude) {
                    existingPeak.frequency = freq;
                    existingPeak.amplitude = maxAmplitude;
                    existingPeak.timestamp = now;
                    existingPeak.type = type;
                    existingPeak.snr = snr; // Update SNR
                }
            } else {
                // New peak
                this.peaks.push({
                    frequency: freq,
                    amplitude: maxAmplitude,
                    timestamp: now,
                    type,
                    snr // Store SNR
                });
                log.debug(`[Listener] Peak: ${Math.round(freq)}Hz (${type}) @ ${maxAmplitude.toFixed(1)}dB, SNR: ${snrRatio.toFixed(1)}x`);
            }
        }

        this.animationFrameId = requestAnimationFrame(this.analyzeLoop);
    };

    stopAndAnalyze(): DetectedPeak[] {
        this.isRecording = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }

        log.info(`[Listener] Recording stopped. ${this.peaks.length} peaks detected`);

        // If too many peaks, take strongest MAX_PEAKS (prevents cheater flooding)
        let finalPeaks = [...this.peaks];
        if (finalPeaks.length > AUDIO_CONFIG.MAX_PEAKS) {
            // Sort by amplitude, keep strongest
            finalPeaks.sort((a, b) => b.amplitude - a.amplitude);
            finalPeaks = finalPeaks.slice(0, AUDIO_CONFIG.MAX_PEAKS);
            log.debug(`[Listener] Capped to ${AUDIO_CONFIG.MAX_PEAKS} strongest peaks`);
        }

        // Sort by timestamp (chronological order for subsequence matching)
        finalPeaks.sort((a, b) => a.timestamp - b.timestamp);

        // DIAGNOSTIC: Log time deltas between peaks
        if (finalPeaks.length > 1) {
            const deltas = finalPeaks.slice(1).map((p, i) =>
                Math.round(p.timestamp - finalPeaks[i].timestamp)
            );
            log.debug(`[Listener] Peak time deltas (ms): ${deltas.join(', ')}`);
        }

        log.success(`[Listener] Final peaks (${finalPeaks.length}): ${finalPeaks.map(p => p.type).join('')}`);
        return finalPeaks;
    }

    getDetectedPattern(): PulseType[] {
        // Note: This relies on stopAndAnalyze() being called first or we need to rework how state is managed
        // For now, let's just return the types of the current peaks if not analyzing
        return this.peaks.map(p => p.type);
    }

    getDiagnostics(): { peaks: DetectedPeak[]; noiseFloor: number } {
        return {
            peaks: [...this.peaks],
            noiseFloor: this.noiseFloor
        };
    }

    async cleanup(): Promise<void> {
        this.isRecording = false;
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);

        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }
        if (this.wakeLock) {
            await this.wakeLock.release();
            this.wakeLock = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
        if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
        }
        log.debug('[Listener] Cleanup complete');
    }
}
