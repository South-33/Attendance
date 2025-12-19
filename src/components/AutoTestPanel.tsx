// Auto-Test Panel - Batch test different volume configurations
// Provides detailed statistics for A/B testing audio configs

import { useState, useEffect, useRef, useCallback } from 'react';
import {
    Volume2,
    VolumeX,
    BarChart,
    CheckCircle,
    XCircle,
    Trophy,
    AlertTriangle,
    Clipboard
} from 'lucide-react';
import { log } from '../utils/logger';
import { AUDIO_CONFIG, UltrasonicEmitter, UltrasonicListener } from '../audio/audioEngine';
import type { EmitterConfig } from '../audio/audioEngine';
import type { QueueEntry } from '../services/firebase';
import { generatePattern, comparePatterns, PASS_THRESHOLD } from '../utils/patternUtils';
import './AutoTestPanel.css';

// Volume presets for testing
const VOLUME_PRESETS = [
    { label: '100%', value: 1.0 },
    { label: '75%', value: 0.75 },
    { label: '50%', value: 0.5 },
    { label: '25%', value: 0.25 },
    { label: '0% (Control)', value: 0 },
];

// Single test result
interface TestResult {
    configLabel: string;
    volume: number;
    passed: boolean;
    matchScore: number;
    emittedPattern: string;
    detectedPattern: string;
    timestamp: number;
    diagnostics?: {
        peaks: { type: string; amplitude: number; frequency: number; snr: number }[];
        noiseFloor: number;
    };
}

// Summary for a single config
interface ConfigSummary {
    label: string;
    volume: number;
    totalTests: number;
    passCount: number;
    passRate: number;
    avgScore: number;
    scoreDistribution: Record<number, number>; // score -> count
    failedPatterns: string[]; // detected patterns that failed
}

// Overall summary
interface TestSummary {
    configSummaries: ConfigSummary[];
    bestConfig: string | null;
    worstConfig: string | null;
    totalPassRate: number;
    totalTests: number;
}

interface AutoTestPanelProps {
    onConfigChange: (config: EmitterConfig) => void;
    onRequestEmit: () => Promise<string | null>; // Returns queueId or null on failure
    myRequest: QueueEntry | null;
    baseConfig: EmitterConfig;
    hasSelectedSession: boolean;
    onDeselectSession: () => void; // Called when switching to local mode
}

export function AutoTestPanel({
    onConfigChange,
    onRequestEmit,
    myRequest,
    baseConfig,
    hasSelectedSession,
    onDeselectSession
}: AutoTestPanelProps) {
    // Config state
    const [selectedVolumes, setSelectedVolumes] = useState<number[]>([0.75]);
    const [testsPerConfig, setTestsPerConfig] = useState(10);
    const [isLocalMode, setIsLocalMode] = useState(false);
    const [useOutputFilter, setUseOutputFilter] = useState(true); // Dual 17kHz highpass filter

    // Test execution state
    const [isRunning, setIsRunning] = useState(false);
    const [currentConfigIndex, setCurrentConfigIndex] = useState(0);
    const [currentTestNumber, setCurrentTestNumber] = useState(0);
    const [progressText, setProgressText] = useState('');

    // Results state
    const [results, setResults] = useState<TestResult[]>([]);
    const [summary, setSummary] = useState<TestSummary | null>(null);
    const [showResults, setShowResults] = useState(false);

    // Refs for tracking async state
    const isRunningRef = useRef(false);
    const pendingResultRef = useRef<{ volume: number; label: string; queueId: string } | null>(null);
    const timeoutRef = useRef<number | null>(null);
    const retryCountRef = useRef(0);
    const MAX_RETRIES = 3;

    // Local mode refs
    const localEmitterRef = useRef<UltrasonicEmitter | null>(null);
    const localListenerRef = useRef<UltrasonicListener | null>(null);

    // Handle volume checkbox toggle
    const toggleVolume = (volume: number) => {
        setSelectedVolumes(prev =>
            prev.includes(volume)
                ? prev.filter(v => v !== volume)
                : [...prev, volume].sort((a, b) => b - a)
        );
    };

    // Calculate summary from results
    const calculateSummary = useCallback((testResults: TestResult[]): TestSummary => {
        const configMap = new Map<string, TestResult[]>();

        // Group results by config label
        testResults.forEach(r => {
            const existing = configMap.get(r.configLabel) || [];
            existing.push(r);
            configMap.set(r.configLabel, existing);
        });

        const configSummaries: ConfigSummary[] = [];

        configMap.forEach((tests, label) => {
            const passCount = tests.filter(t => t.passed).length;
            const scores = tests.map(t => t.matchScore);

            // Calculate score distribution
            const scoreDistribution: Record<number, number> = {};
            for (let i = 0; i <= AUDIO_CONFIG.NUM_PULSES; i++) {
                scoreDistribution[i] = 0;
            }
            scores.forEach(s => {
                scoreDistribution[s] = (scoreDistribution[s] || 0) + 1;
            });

            // Collect failed pattern examples
            const failedPatterns = tests
                .filter(t => !t.passed)
                .map(t => t.detectedPattern)
                .slice(0, 3); // Keep first 3 examples

            configSummaries.push({
                label,
                volume: tests[0].volume,
                totalTests: tests.length,
                passCount,
                passRate: (passCount / tests.length) * 100,
                avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
                scoreDistribution,
                failedPatterns
            });
        });

        // Sort by pass rate descending
        configSummaries.sort((a, b) => b.passRate - a.passRate);

        const totalPassed = testResults.filter(r => r.passed).length;

        return {
            configSummaries,
            bestConfig: configSummaries.length > 0 ? configSummaries[0].label : null,
            worstConfig: configSummaries.length > 0 ? configSummaries[configSummaries.length - 1].label : null,
            totalPassRate: testResults.length > 0 ? (totalPassed / testResults.length) * 100 : 0,
            totalTests: testResults.length
        };
    }, []);

    const recordResult = (result: TestResult) => {
        setResults(prev => [...prev, result]);
        pendingResultRef.current = null;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        retryCountRef.current = 0; // Reset retries on successful result processing

        // Schedule next test or advance config
        if (currentTestNumber < testsPerConfig) {
            // More tests for this config
            setCurrentTestNumber(prev => prev + 1);
        } else {
            // Move to next config
            const nextIndex = currentConfigIndex + 1;
            if (nextIndex < selectedVolumes.length) {
                setCurrentConfigIndex(nextIndex);
                setCurrentTestNumber(1);
            } else {
                // All done!
                finishTesting();
            }
        }
    };

    const handleSystemError = (label: string, volume: number, reason: string) => {
        if (retryCountRef.current < MAX_RETRIES) {
            retryCountRef.current++;
            log.info(`⚠️ System error (${reason}), retrying test ${currentTestNumber} (Attempt ${retryCountRef.current + 1}/${MAX_RETRIES + 1})...`);

            // Clean up old request ref so we can retry
            pendingResultRef.current = null;
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            timeoutRef.current = null;

            // Wait a bit then retry
            setTimeout(() => runSingleTest(), 2000);
        } else {
            log.error(`❌ Test failed after ${MAX_RETRIES} retries: ${reason}. Skipping.`);
            // Record as "System Fail"
            recordResult({
                configLabel: label,
                volume,
                passed: false,
                matchScore: 0,
                emittedPattern: 'SYSTEM_ERR',
                detectedPattern: reason,
                timestamp: Date.now()
            });
        }
    };

    // Watch for test completion (verified/failed status)
    useEffect(() => {
        if (!isRunningRef.current || !pendingResultRef.current) return;
        if (!myRequest) return;

        // Ensure we're looking at the request we just made
        if (myRequest.id !== pendingResultRef.current.queueId) return;

        if (myRequest.status === 'verified' || myRequest.status === 'failed') {
            const { volume, label } = pendingResultRef.current;

            // Record the result
            const result: TestResult = {
                configLabel: label,
                volume,
                passed: myRequest.status === 'verified',
                matchScore: myRequest.matchCount ?? 0,
                emittedPattern: myRequest.emittedPattern?.join('') ?? '',
                detectedPattern: myRequest.detectedPattern?.join('') ?? '',
                timestamp: Date.now(),
                diagnostics: myRequest.diagnosticData
            };

            log.info(`[AutoTest] Test ${currentTestNumber}/${testsPerConfig} @ ${label}: ${result.passed ? 'PASSED' : 'FAILED'} (${result.matchScore}/${AUDIO_CONFIG.NUM_PULSES})`);
            recordResult(result);
        }
    }, [myRequest, currentTestNumber, testsPerConfig, currentConfigIndex, selectedVolumes.length]);

    // Run next test when test number or config changes
    useEffect(() => {
        if (!isRunningRef.current) return;
        if (pendingResultRef.current) return; // Still waiting for result
        if (currentTestNumber === 0) return; // Not started yet

        // If this is a new test number (not a retry), reset retry count
        if (retryCountRef.current === 0) {
            runSingleTest();
        }
    }, [currentTestNumber, currentConfigIndex]);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, []);

    // Run a single test at current config
    const runSingleTest = async () => {
        if (!isRunningRef.current) return;

        const volume = selectedVolumes[currentConfigIndex];
        const baseLabel = VOLUME_PRESETS.find(p => p.value === volume)?.label || `${volume * 100}%`;
        const label = useOutputFilter ? baseLabel : `${baseLabel} (No Filter)`;

        setProgressText(`Running test ${currentTestNumber}/${testsPerConfig} @ ${label}...${retryCountRef.current > 0 ? ` (Retry ${retryCountRef.current})` : ''}${isLocalMode ? ' [LOCAL]' : ''}`);

        if (isLocalMode) {
            // LOCAL MODE: Use device's own speaker and mic
            await runLocalTest(volume, label);
        } else {
            // REMOTE MODE: Use Firebase queue
            await runRemoteTest(volume, label);
        }
    };

    // Run test in local mode (speaker -> mic on same device)
    const runLocalTest = async (volume: number, label: string) => {
        if (!localEmitterRef.current || !localListenerRef.current) {
            handleSystemError(label, volume, 'Local audio not initialized');
            return;
        }

        try {
            // Start recording
            localListenerRef.current.startRecording();
            await new Promise(r => setTimeout(r, 200));
            localListenerRef.current.clearPeaks();

            // Generate and emit pattern
            const pattern = generatePattern();
            const config: EmitterConfig = { ...baseConfig, volume, useOutputFilter };
            await localEmitterRef.current.emit(pattern, config);

            // Wait for audio to settle
            await new Promise(r => setTimeout(r, 300));

            // Stop and analyze
            const peaks = localListenerRef.current.stopAndAnalyze();
            const diagnostics = localListenerRef.current.getDiagnostics();
            const detectedPattern = peaks.map(p => p.type);

            // Compare
            const comparison = comparePatterns(pattern, detectedPattern);

            const result: TestResult = {
                configLabel: label,
                volume,
                passed: comparison.passed,
                matchScore: comparison.matchCount,
                emittedPattern: pattern.join(''),
                detectedPattern: detectedPattern.join(''),
                timestamp: Date.now(),
                diagnostics: {
                    peaks: diagnostics.peaks.map(p => ({
                        type: p.type,
                        amplitude: p.amplitude,
                        frequency: p.frequency,
                        snr: p.snr
                    })),
                    noiseFloor: diagnostics.noiseFloor
                }
            };

            log.info(`[AutoTest] LOCAL Test ${currentTestNumber}/${testsPerConfig} @ ${label}: ${result.passed ? 'PASSED' : 'FAILED'} (${result.matchScore}/${AUDIO_CONFIG.NUM_PULSES})`);
            recordResult(result);

        } catch (e) {
            handleSystemError(label, volume, `Local test error: ${e}`);
        }
    };

    // Run test in remote mode (via Firebase)
    const runRemoteTest = async (volume: number, label: string) => {
        // Update config with this volume and filter setting
        onConfigChange({
            ...baseConfig,
            volume,
            useOutputFilter
        });

        // Small delay to ensure config is applied
        await new Promise(r => setTimeout(r, 100));

        // Request emit (which will trigger the verification flow)
        const queueId = await onRequestEmit();

        if (!queueId) {
            if (isRunningRef.current) {
                handleSystemError(label, volume, 'Request Failed');
            }
            return;
        }

        // Set timeout
        pendingResultRef.current = { volume, label, queueId };

        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => {
            if (isRunningRef.current && pendingResultRef.current?.queueId === queueId) {
                handleSystemError(label, volume, 'Timeout');
            }
        }, 12000); // 12 seconds timeout (generous)
    };

    // Start testing
    const startTesting = async () => {
        if (selectedVolumes.length === 0) {
            alert('Please select at least one volume level to test.');
            return;
        }
        if (!isLocalMode && !hasSelectedSession) {
            alert('Please select a Class first to test with, or enable Local Test mode.');
            return;
        }

        log.info(`[AutoTest] Starting ${testsPerConfig * selectedVolumes.length} tests across ${selectedVolumes.length} configs${isLocalMode ? ' (LOCAL MODE)' : ''}`);

        // If local mode, init audio FIRST before starting loop logic
        if (isLocalMode) {
            try {
                localEmitterRef.current = new UltrasonicEmitter();
                await localEmitterRef.current.init();
                localListenerRef.current = new UltrasonicListener();
                await localListenerRef.current.init();
            } catch (e) {
                log.error(`[AutoTest] Failed to init local audio: ${e}`);
                return;
            }
        }

        // Now safe to start the loop
        setIsRunning(true);
        isRunningRef.current = true;
        setResults([]);
        setSummary(null);
        setShowResults(false);
        setCurrentConfigIndex(0);
        setCurrentTestNumber(1); // This triggers the useEffect
        pendingResultRef.current = null;
        retryCountRef.current = 0;
    };

    // Stop testing
    const stopTesting = async () => {
        log.info('[AutoTest] Testing stopped by user');
        isRunningRef.current = false;
        setIsRunning(false);
        pendingResultRef.current = null;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);

        // Cleanup local mode resources
        if (localEmitterRef.current) {
            await localEmitterRef.current.cleanup();
            localEmitterRef.current = null;
        }
        if (localListenerRef.current) {
            await localListenerRef.current.cleanup();
            localListenerRef.current = null;
        }

        // Generate summary from partial results
        if (results.length > 0) {
            setSummary(calculateSummary(results));
            setShowResults(true);
        }
    };

    // Finish testing (all tests complete)
    const finishTesting = () => {
        log.success(`[AutoTest] All tests complete! ${results.length + 1} tests run`);
        isRunningRef.current = false;
        setIsRunning(false);
        setProgressText('');
        pendingResultRef.current = null;

        // Wait for last result to be added
        setTimeout(() => {
            setResults(prev => {
                const final = calculateSummary(prev);
                setSummary(final);
                setShowResults(true);
                return prev;
            });
        }, 100);
    };

    // Copy results to clipboard
    const copyResults = () => {
        if (!summary) return;

        const lines: string[] = [
            '=== AUTO-TEST RESULTS ===',
            `Date: ${new Date().toLocaleString()}`,
            `Total Tests: ${summary.totalTests}`,
            `Overall Pass Rate: ${summary.totalPassRate.toFixed(1)}%`,
            `Best Config: ${summary.bestConfig}`,
            `Worst Config: ${summary.worstConfig}`,
            '',
            '--- Per-Config Results ---'
        ];

        summary.configSummaries.forEach(config => {
            lines.push('');
            lines.push(`${config.label}:`);
            lines.push(`  Pass Rate: ${config.passCount}/${config.totalTests} (${config.passRate.toFixed(0)}%)`);
            lines.push(`  Avg Score: ${config.avgScore.toFixed(1)}/${AUDIO_CONFIG.NUM_PULSES}`);
            lines.push(`  Score Distribution: ${Object.entries(config.scoreDistribution).map(([s, c]) => `${s}→${c}`).join(', ')}`);
            if (config.failedPatterns.length > 0) {
                lines.push(`  Failed Patterns: ${config.failedPatterns.join(', ')}`);
            }
        });

        lines.push('');
        lines.push('--- Raw Results ---');
        results.forEach((r, i) => {
            lines.push(`${i + 1}. [${r.configLabel}] ${r.passed ? 'PASS' : 'FAIL'} (${r.matchScore}/${AUDIO_CONFIG.NUM_PULSES}) E:${r.emittedPattern} D:${r.detectedPattern}`);
            if (r.diagnostics) {
                const peaks = r.diagnostics.peaks.map(p => `${p.type}(${p.amplitude.toFixed(0)}dB, SNR:${p.snr.toFixed(0)})`).join(' ');
                lines.push(`    Diagnostics: Noise Floor: ${r.diagnostics.noiseFloor.toFixed(1)}dB | Peaks: ${peaks}`);
            }
        });

        navigator.clipboard.writeText(lines.join('\n'))
            .then(() => log.success('Results copied to clipboard!'))
            .catch(() => log.error('Failed to copy results'));
    };

    // Render score distribution as bars
    const renderScoreDistribution = (dist: Record<number, number>, total: number) => {
        return (
            <div className="score-distribution">
                {Object.entries(dist).map(([score, count]) => (
                    <div key={score} className="score-bar" title={`Score ${score}: ${count} tests`}>
                        <span className="score-label">{score}/{AUDIO_CONFIG.NUM_PULSES}</span>
                        <div className="bar-container">
                            <div
                                className={`bar-fill ${Number(score) >= PASS_THRESHOLD ? 'pass' : 'fail'}`}
                                style={{ width: `${(count / total) * 100}%` }}
                            />
                        </div>
                        <span className="score-count">{count}</span>
                    </div>
                ))}
            </div>
        );
    };

    return (
        <section className="autotest-panel">
            <div className="autotest-header">
                <h3>Auto-Test Configuration</h3>
            </div>

            {/* Config Selection */}
            <div className="config-section">
                <div className="volume-selection">
                    <label>Volume Levels to Test:</label>
                    <div className="checkbox-group">
                        {VOLUME_PRESETS.map(preset => (
                            <label key={preset.value} className="volume-checkbox">
                                <input
                                    type="checkbox"
                                    checked={selectedVolumes.includes(preset.value)}
                                    onChange={() => toggleVolume(preset.value)}
                                    disabled={isRunning}
                                />
                                <span className={preset.value === 0 ? 'muted' : ''}>
                                    {preset.label}
                                </span>
                            </label>
                        ))}
                    </div>
                </div>

                {/* Local Mode Toggle */}
                <div className="local-mode-toggle">
                    <label className="local-checkbox">
                        <input
                            type="checkbox"
                            checked={isLocalMode}
                            onChange={(e) => {
                                setIsLocalMode(e.target.checked);
                                if (e.target.checked) {
                                    onDeselectSession();
                                }
                            }}
                            disabled={isRunning}
                        />
                        <span><Volume2 className="inline-icon" size={14} /> Local Test Mode</span>
                        <small>(Use device's own speaker & mic, no teacher needed)</small>
                    </label>
                </div>

                {/* Output Filter Toggle */}
                <div className="local-mode-toggle">
                    <label className="local-checkbox">
                        <input
                            type="checkbox"
                            checked={useOutputFilter}
                            onChange={(e) => setUseOutputFilter(e.target.checked)}
                            disabled={isRunning}
                        />
                        <span><VolumeX className="inline-icon" size={14} /> Output Filter (17kHz)</span>
                        <small>(Dual highpass filter reduces audible pops, disable to A/B test)</small>
                    </label>
                </div>

                <div className="tests-per-config">
                    <label>Tests per Config:</label>
                    <input
                        type="number"
                        value={testsPerConfig}
                        onChange={(e) => setTestsPerConfig(Math.max(1, parseInt(e.target.value) || 1))}
                        min={1}
                        max={50}
                        disabled={isRunning}
                    />
                    <span className="test-count-info">
                        Total: {testsPerConfig * selectedVolumes.length} tests
                    </span>
                </div>
            </div>

            {/* Controls */}
            <div className="test-controls">
                {!isRunning ? (
                    <button
                        className="start-btn"
                        onClick={startTesting}
                        disabled={selectedVolumes.length === 0}
                    >
                        Start Auto-Test
                    </button>
                ) : (
                    <button className="stop-btn" onClick={stopTesting}>
                        Stop Testing
                    </button>
                )}

                {results.length > 0 && !isRunning && (
                    <button
                        className="results-btn"
                        onClick={() => setShowResults(!showResults)}
                    >
                        <BarChart className="inline-icon" size={14} /> {showResults ? 'Hide' : 'Show'} Results
                    </button>
                )}
            </div>

            {/* Progress Indicator */}
            {isRunning && (
                <div className="progress-section">
                    <div className="progress-bar">
                        <div
                            className="progress-fill"
                            style={{
                                width: `${((currentConfigIndex * testsPerConfig + currentTestNumber) /
                                    (selectedVolumes.length * testsPerConfig)) * 100}%`
                            }}
                        />
                    </div>
                    <div className="progress-text">{progressText}</div>
                    <div className="progress-stats">
                        Config {currentConfigIndex + 1}/{selectedVolumes.length} •
                        Test {currentTestNumber}/{testsPerConfig} •
                        Completed: {results.length}
                    </div>
                </div>
            )}

            {/* Results Summary */}
            {showResults && summary && (
                <div className="results-section">
                    <div className="results-header">
                        <h4><BarChart className="inline-icon" size={18} /> Test Results Summary</h4>
                        <button className="copy-btn" onClick={copyResults}><Clipboard className="inline-icon" size={14} /> Copy Results</button>
                    </div>

                    {/* Overall Stats */}
                    <div className="overall-stats">
                        <div className="stat-card">
                            <span className="stat-value">{summary.totalTests}</span>
                            <span className="stat-label">Total Tests</span>
                        </div>
                        <div className="stat-card">
                            <span className={`stat-value ${summary.totalPassRate >= 80 ? 'good' : summary.totalPassRate >= 50 ? 'medium' : 'poor'}`}>
                                {summary.totalPassRate.toFixed(1)}%
                            </span>
                            <span className="stat-label">Overall Pass Rate</span>
                        </div>
                        <div className="stat-card best">
                            <span className="stat-value"><Trophy className="inline-icon" size={20} /> {summary.bestConfig}</span>
                            <span className="stat-label">Best Config</span>
                        </div>
                        <div className="stat-card worst">
                            <span className="stat-value"><AlertTriangle className="inline-icon" size={20} /> {summary.worstConfig}</span>
                            <span className="stat-label">Worst Config</span>
                        </div>
                    </div>

                    {/* Per-Config Results */}
                    <div className="config-results">
                        {summary.configSummaries.map((config, idx) => (
                            <div key={config.label} className={`config-result-card ${idx === 0 ? 'best' : ''}`}>
                                <div className="config-header">
                                    <span className="config-name">
                                        {idx === 0 && <Trophy className="inline-icon" size={14} />}
                                        {config.label}
                                    </span>
                                    <span className={`pass-rate ${config.passRate >= 80 ? 'good' : config.passRate >= 50 ? 'medium' : 'poor'}`}>
                                        {config.passCount}/{config.totalTests} ({config.passRate.toFixed(0)}%)
                                    </span>
                                </div>

                                <div className="config-stats">
                                    <div className="avg-score">
                                        Avg Score: <strong>{config.avgScore.toFixed(1)}/{AUDIO_CONFIG.NUM_PULSES}</strong>
                                    </div>
                                </div>

                                <div className="distribution-section">
                                    <span className="section-label">Score Distribution:</span>
                                    {renderScoreDistribution(config.scoreDistribution, config.totalTests)}
                                </div>

                                {config.failedPatterns.length > 0 && (
                                    <div className="failed-patterns">
                                        <span className="section-label">Failed Pattern Examples:</span>
                                        <div className="pattern-list">
                                            {config.failedPatterns.map((p, i) => (
                                                <code key={i}>{p || '(empty)'}</code>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* Raw Results Table */}
                    <details className="raw-results">
                        <summary>View All Test Results ({results.length})</summary>
                        <table className="results-table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Config</th>
                                    <th>Result</th>
                                    <th>Score</th>
                                    <th>Emitted</th>
                                    <th>Detected</th>
                                </tr>
                            </thead>
                            <tbody>
                                {results.map((r, i) => (
                                    <tr key={i} className={r.passed ? 'pass-row' : 'fail-row'}>
                                        <td>{i + 1}</td>
                                        <td>{r.configLabel}</td>
                                        <td>{r.passed ? <CheckCircle size={14} style={{ color: '#40c057' }} /> : <XCircle size={14} style={{ color: '#ff6b6b' }} />}</td>
                                        <td>{r.matchScore}/{AUDIO_CONFIG.NUM_PULSES}</td>
                                        <td>
                                            <code>{r.emittedPattern}</code>
                                            {r.diagnostics && (
                                                <div className="diag-info">
                                                    <small>Floor: {r.diagnostics.noiseFloor.toFixed(0)}dB</small>
                                                </div>
                                            )}
                                        </td>
                                        <td>
                                            <code>{r.detectedPattern || '(none)'}</code>
                                            {r.diagnostics && (
                                                <div className="diag-peaks">
                                                    {r.diagnostics.peaks.map((p, k) => (
                                                        <span key={k} title={`Freq: ${p.frequency.toFixed(0)}Hz, Amp: ${p.amplitude.toFixed(1)}dB, SNR: ${p.snr.toFixed(1)}dB`}>
                                                            {p.type}<small style={{ fontSize: '0.6em', opacity: 0.7 }}>{p.amplitude.toFixed(0)}</small>
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </details>
                </div>
            )}
        </section>
    );
}
