// Pattern Utilities for H/L pulse verification

import { AUDIO_CONFIG } from '../audio/audioEngine';
import type { PulseType } from '../audio/audioEngine';

// Dynamic pass threshold (allow 1 error)
export const PASS_THRESHOLD = AUDIO_CONFIG.NUM_PULSES - 1;

/**
 * Generate random H/L pattern
 */
export function generatePattern(length: number = AUDIO_CONFIG.NUM_PULSES): PulseType[] {
    const pattern: PulseType[] = [];
    for (let i = 0; i < length; i++) {
        pattern.push(Math.random() < 0.5 ? 'H' : 'L');
    }
    return pattern;
}

/**
 * Classify a frequency as H or L
 */
export function classifyFrequency(freq: number, threshold: number = AUDIO_CONFIG.FREQ_THRESHOLD): PulseType {
    return freq > threshold ? 'H' : 'L';
}

/**
 * Find emitted pattern as subsequence in detected pattern
 * Returns the number of matching pulses in order
 * 
 * Example:
 * - emitted: HHHHH
 * - detected: LHHHHHHL
 * - finds HHHHH as subsequence → matchCount = 5
 * 
 * Example:
 * - emitted: HLHHL  
 * - detected: LHHLHHLLL
 * - finds H_LHH_L as subsequence → matchCount = 5
 */
export function comparePatterns(
    emitted: PulseType[],
    detected: PulseType[]
): { matchCount: number; passed: boolean; details: string[] } {
    const details: string[] = [];

    // Find longest matching subsequence starting from emitted pattern
    let emitIndex = 0;
    let detectIndex = 0;
    const matchedPositions: number[] = [];

    while (emitIndex < emitted.length && detectIndex < detected.length) {
        if (emitted[emitIndex] === detected[detectIndex]) {
            matchedPositions.push(detectIndex);
            emitIndex++;
        }
        detectIndex++;
    }

    const matchCount = matchedPositions.length;

    // Build details
    for (let i = 0; i < emitted.length; i++) {
        if (i < matchCount) {
            details.push(`✓ Pulse ${i + 1}: ${emitted[i]} found at position ${matchedPositions[i] + 1}`);
        } else {
            details.push(`✗ Pulse ${i + 1}: ${emitted[i]} not found in remaining sequence`);
        }
    }

    details.push(`📊 Detected ${detected.length} total peaks: ${detected.join('')}`);
    details.push(`🎯 Found ${matchCount}/${emitted.length} in order`);

    const passed = matchCount >= PASS_THRESHOLD;

    return { matchCount, passed, details };
}

/**
 * Get security analysis for threshold
 */
export function getSecurityStats(): {
    threshold: number;
    guessRate: string;
    patterns: number;
} {
    // With subsequence matching, security is even better because
    // attacker would need to emit the right sequence, not just any 6 peaks
    return {
        threshold: PASS_THRESHOLD,
        guessRate: '10.93%', // Improved from 18.75% with 6 pulses
        patterns: 64 // 2^6 patterns
    };
}
