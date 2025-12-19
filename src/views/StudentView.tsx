// Student View - Join sessions, listen for pulses, submit results

import { useState, useEffect, useRef, useCallback } from 'react';
import {
    Mic,
    Radio,
    Timer,
    Ear,
    Upload,
    CheckCircle,
    XCircle,
    AlertTriangle,
    ArrowLeft,
    RefreshCw,
    Beaker,
    Check
} from 'lucide-react';
import { LogPanel } from '../components/LogPanel';
import { AutoTestPanel } from '../components/AutoTestPanel';
import { log } from '../utils/logger';
import { UltrasonicListener, AUDIO_CONFIG } from '../audio/audioEngine';
import type { EmitterConfig } from '../audio/audioEngine';
import {
    subscribeToMyRequest,
    joinQueue,
    updateQueueStatus,
    getSessionByCode,
    deleteQueueEntry
} from '../services/firebase';
import type { Session, QueueEntry } from '../services/firebase';
import './TeacherView.css'; // Shared styles
import { HelpPanel } from '../components/HelpPanel';

interface StudentViewProps {
    studentId: string;
    studentName: string;
    onBack: () => void;
}

const DEFAULT_CONFIG: EmitterConfig = {
    volume: 0.75,
    freqLow: AUDIO_CONFIG.FREQ_LOW,
    freqHigh: AUDIO_CONFIG.FREQ_HIGH,
    pulseDuration: AUDIO_CONFIG.PULSE_DURATION_MS,
    pulseGap: AUDIO_CONFIG.PULSE_GAP_MS
};

export function StudentView({ studentId, studentName, onBack }: StudentViewProps) {
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);
    const [queueId, setQueueId] = useState<string | null>(null);
    const [myRequest, setMyRequest] = useState<QueueEntry | null>(null);
    const [status, setStatus] = useState<string>('idle');
    const [config, setConfig] = useState<EmitterConfig>(DEFAULT_CONFIG);
    const [showAutoTest, setShowAutoTest] = useState(false);
    const [showHelp, setShowHelp] = useState(false);

    // New state for code joining
    const [roomCode, setRoomCode] = useState('');
    const [joinError, setJoinError] = useState('');
    const [isJoining, setIsJoining] = useState(false);
    const [showCancel, setShowCancel] = useState(false);

    const listenerRef = useRef<UltrasonicListener | null>(null);
    const unsubscribeRequestRef = useRef<(() => void) | null>(null);
    const hasSubmittedRef = useRef(false); // Prevent duplicate submissions
    const responseTimeoutRef = useRef<number | null>(null); // Timeout for teacher response
    const readyTimeoutRef = useRef<number | null>(null); // Timeout when stuck in 'ready' state
    const micReadyRef = useRef(false); // Track if mic is fully initialized
    const RESPONSE_TIMEOUT_MS = 5000; // 5 seconds to get a response
    const READY_TIMEOUT_MS = 30000; // 30 seconds max in 'ready' state before warning

    // Subscribe to my request status
    useEffect(() => {
        if (!queueId) return;

        log.info(`[Queue] Subscribing to updates for ${queueId.slice(0, 8)}...`);

        unsubscribeRequestRef.current = subscribeToMyRequest(queueId, (entry) => {
            setMyRequest(entry);
            if (entry) {
                log.debug(`[Queue] Update: status=${entry.status}, hasPattern=${!!entry.detectedPattern}`);
                handleStatusChange(entry);
            } else {
                // Request was deleted (teacher ended session or manual cleanup)
                // Reset state to allow student to try again
                log.error('[Queue] Request was deleted - session may have ended');
                clearTimeouts();
                cleanup().then(() => {
                    setQueueId(null);
                    setStatus('idle');
                    setSelectedSession(null);
                });
            }
        });

        // Cleanup on tab close
        const handleUnload = () => {
            if (queueId) {
                // Use a standard call (Firebase usually persists small writes on unload)
                deleteQueueEntry(queueId).catch(() => { });
            }
        };
        window.addEventListener('beforeunload', handleUnload);

        return () => {
            if (unsubscribeRequestRef.current) {
                unsubscribeRequestRef.current();
            }
            window.removeEventListener('beforeunload', handleUnload);
        };
    }, [queueId]);

    // Handle cancel button delay
    useEffect(() => {
        let timer: number | null = null;
        if (status === 'ready') {
            timer = window.setTimeout(() => {
                setShowCancel(true);
            }, 1000); // 1-second delay
        } else {
            setShowCancel(false);
        }
        return () => {
            if (timer) clearTimeout(timer);
        };
    }, [status]);

    // Helper to clear all pending timeouts
    const clearTimeouts = () => {
        if (responseTimeoutRef.current) {
            clearTimeout(responseTimeoutRef.current);
            responseTimeoutRef.current = null;
        }
        if (readyTimeoutRef.current) {
            clearTimeout(readyTimeoutRef.current);
            readyTimeoutRef.current = null;
        }
    };

    // Handle status changes from Firestore
    const handleStatusChange = useCallback(async (entry: QueueEntry) => {
        // Clear ready timeout if we're no longer in 'ready' state
        if (entry.status !== 'ready' && readyTimeoutRef.current) {
            clearTimeout(readyTimeoutRef.current);
            readyTimeoutRef.current = null;
        }
        log.debug(`[Status] ${entry.status}`);

        switch (entry.status) {
            case 'emitting':
                // Teacher is about to emit - NOW start the microphone
                setStatus('listening');
                micReadyRef.current = false; // Mark mic as not ready yet
                try {
                    if (!listenerRef.current) {
                        listenerRef.current = new UltrasonicListener();
                        await listenerRef.current.init();
                        listenerRef.current.startRecording();
                        log.info('🎤 Microphone started for emission');
                    } else {
                        // Listener exists but may have old peaks - clear them
                        listenerRef.current.clearPeaks();
                    }
                    micReadyRef.current = true; // Mic is now ready

                    // HANDSHAKE: Signal back to teacher that mic is ready
                    await updateQueueStatus(entry.id, 'listening');
                    log.debug('[Handshake] Signaled LISTENING to teacher');
                } catch (e) {
                    // Autoplay policy or mic permission issue
                    log.error(`[Audio] Failed to start microphone: ${e}`);
                    setStatus('error');
                    return;
                }
                break;

            case 'submitted':
                // Teacher wants us to submit our results
                // Only submit if we haven't already (prevents duplicate calls)
                if (!entry.detectedPattern && !hasSubmittedRef.current) {
                    hasSubmittedRef.current = true;
                    setStatus('submitting');
                    await submitDetectedPattern(entry.id);

                    // Start timeout - if no response in 5s, retry
                    if (responseTimeoutRef.current) clearTimeout(responseTimeoutRef.current);
                    responseTimeoutRef.current = window.setTimeout(() => {
                        log.error('[Timeout] Teacher response timeout - retrying...');
                        handleRetry();
                    }, RESPONSE_TIMEOUT_MS);
                } else if (entry.detectedPattern) {
                    // We already submitted, just wait for verification
                    setStatus('submitting');
                }
                break;

            case 'verified':
                // Clear timeout - we got a response!
                if (responseTimeoutRef.current) {
                    clearTimeout(responseTimeoutRef.current);
                    responseTimeoutRef.current = null;
                }
                setStatus('verified');
                log.success(`[Verify] Verified! Score: ${entry.matchCount}/${AUDIO_CONFIG.NUM_PULSES}`);
                await cleanup();
                break;

            case 'failed':
                // Clear timeout - we got a response!
                if (responseTimeoutRef.current) {
                    clearTimeout(responseTimeoutRef.current);
                    responseTimeoutRef.current = null;
                }
                setStatus('failed');
                log.error(`[Verify] Failed. Score: ${entry.matchCount || 0}/${AUDIO_CONFIG.NUM_PULSES}`);
                await cleanup();
                break;
        }
    }, []);

    const submitDetectedPattern = async (entryId: string) => {
        // Wait for mic to be ready (handles race condition where 'submitted' arrives before mic init completes)
        const maxWait = 2000; // Max 2s wait
        const startWait = Date.now();
        while (!micReadyRef.current && Date.now() - startWait < maxWait) {
            await new Promise(r => setTimeout(r, 50));
        }

        if (!listenerRef.current || !micReadyRef.current) {
            log.error('[Submit] Microphone not ready - cannot submit');
            return;
        }

        // Stop recording and get final analyzed peaks (capped, sorted)
        const peaks = listenerRef.current.stopAndAnalyze();
        const pattern = peaks.map(p => p.type);
        const diagnostics = listenerRef.current.getDiagnostics();

        log.info(`[Submit] Submitting pattern: ${pattern.join('')}`);

        await updateQueueStatus(entryId, 'submitted', {
            detectedPattern: pattern,
            diagnosticData: {
                peaks: diagnostics.peaks.map(p => ({
                    type: p.type,
                    amplitude: p.amplitude,
                    frequency: p.frequency,
                    snr: p.snr || 0 // Default to 0 if missing
                })),
                noiseFloor: diagnostics.noiseFloor
            }
        });
    };

    const cleanup = async () => {
        hasSubmittedRef.current = false; // Reset for next request
        micReadyRef.current = false; // Reset mic ready state
        clearTimeouts(); // Clear all pending timeouts
        if (listenerRef.current) {
            await listenerRef.current.cleanup();
            listenerRef.current = null;
        }
    };

    const handleRequestEmit = async (): Promise<string | null> => {
        if (!selectedSession || !queueId) {
            log.error('[Request] No session or queue ID found');
            return null;
        }

        try {
            setStatus('requesting');

            // Update existing entry to ready
            await updateQueueStatus(queueId, 'ready');
            setStatus('ready');
            log.success('[Request] Status updated to READY');

            // Start timeout - if stuck in 'ready' for too long, show warning
            readyTimeoutRef.current = window.setTimeout(() => {
                log.error('[Timeout] Still waiting for teacher after 30s');
                log.info('[Hint] Check if teacher session is active');
                setStatus('error'); // Reveal 'Try Again' button
            }, READY_TIMEOUT_MS);

            return queueId;

        } catch (e) {
            log.error(`[Request] Failed: ${e}`);
            setStatus('error');
            await cleanup();
            return null;
        }
    };

    const handleCancel = async () => {
        log.info('Request cancelled by user');
        if (queueId) {
            try {
                // Set back to waiting in DB so teacher knows we're not ready
                await updateQueueStatus(queueId, 'waiting');
            } catch (e) {
                log.debug('Failed to update status on cancel');
            }
        }
        await cleanup();
        setStatus('idle');
    };

    const handleRetry = async () => {
        await cleanup();
        // Keep queueId, but reset the internal status
        if (queueId) {
            try {
                await updateQueueStatus(queueId, 'waiting');
            } catch (e) { }
        }
        setMyRequest(null);
        setStatus('idle');
        log.info('Resetting session state...');
    };

    const handleJoinByCode = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!roomCode || roomCode.length < 6) return;

        setIsJoining(true);
        setJoinError('');

        try {
            const session = await getSessionByCode(roomCode);
            if (session) {
                setSelectedSession(session);
                log.success(`[Join] Joined room: ${session.teacherName}`);

                // IMMEDIATELY JOIN QUEUE to show up to teacher
                const id = await joinQueue(
                    session.id,
                    studentId,
                    studentName,
                    config
                );
                setQueueId(id);
            } else {
                setJoinError('Room not found. Check the code.');
            }
        } catch (err) {
            log.error(`[Join] Error: ${err}`);
            setJoinError('Error joining room.');
        } finally {
            setIsJoining(false);
        }
    };

    const getStatusDisplay = () => {
        switch (status) {
            case 'idle': return 'Tap "Request Emit"';
            case 'requesting': return <><RefreshCw className="inline-icon" size={14} /> Requesting...</>;
            case 'ready': return <><Timer className="inline-icon" size={14} /> In queue - waiting for teacher...</>;
            case 'listening': return <><Ear className="inline-icon" size={14} /> Listening for pulses...</>;
            case 'submitting': return <><Upload className="inline-icon" size={14} /> Submitting results...</>;
            case 'verified': return <><CheckCircle className="inline-icon" size={14} /> Verified!</>;
            case 'failed': return <><XCircle className="inline-icon" size={14} /> Verification failed</>;
            case 'error': return <><AlertTriangle className="inline-icon" size={14} /> Error occurred</>;
            default: return status;
        }
    };

    return (
        <div className="student-view view-animate">
            <header className="view-header">
                <div className="header-left">
                    <button onClick={onBack} className="back-btn"><ArrowLeft className="inline-icon" size={16} /> Back</button>
                    <h1><Mic className="inline-icon" /> Student: {studentName}</h1>
                </div>
                <button
                    className="help-btn"
                    onClick={() => setShowHelp(true)}
                    title="Help / Manual"
                >
                    HOW TO USE
                </button>
            </header>

            <main className="view-content">
                {/* Active Class */}
                <section className="sessions-section">
                    <h2 className="join-header">Class</h2>

                    {!selectedSession ? (
                        <div className="code-join-section">
                            <form onSubmit={handleJoinByCode} className="code-input-container">
                                <label className="room-code-label">ENTER ROOM CODE</label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    maxLength={6}
                                    placeholder="000000"
                                    className="code-input"
                                    value={roomCode}
                                    onChange={(e) => {
                                        const val = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
                                        setRoomCode(val);
                                        setJoinError('');
                                    }}
                                    autoFocus
                                />
                                <button
                                    type="submit"
                                    className="join-btn"
                                    disabled={roomCode.length !== 6 || isJoining}
                                >
                                    {isJoining ? 'Finding Room...' : 'Join Room'} <Check className="inline-icon" size={18} />
                                </button>
                                {joinError && <div className="error-message">{joinError}</div>}
                            </form>
                            <div className="code-hint">
                                In a real school, there would be no need for codes as the database already knows which student belongs to which class.
                            </div>
                        </div>
                    ) : (
                        <div className="session-item selected static-cursor">
                            <span className="teacher-name-display">
                                <Radio className="inline-icon" size={14} /> Connected to: <strong>{selectedSession.teacherName}</strong>
                            </span>
                            <button
                                onClick={() => {
                                    if (queueId) deleteQueueEntry(queueId);
                                    setSelectedSession(null);
                                    setRoomCode('');
                                    setQueueId(null);
                                    setStatus('idle');
                                }}
                                className="leave-btn"
                            >
                                Leave
                            </button>
                        </div>
                    )}
                </section>

                {/* Status */}
                <section className="status-display">
                    <div className={`status-text ${status === 'verified' ? 'result-success' : status === 'failed' ? 'result-failed' : ''} status-text-content`}>
                        <span>{getStatusDisplay()}</span>
                        {myRequest?.matchCount !== undefined && (
                            <span className="match-detail">({myRequest.matchCount}/{AUDIO_CONFIG.NUM_PULSES} matched)</span>
                        )}
                    </div>
                </section>

                {/* Controls */}
                <div className="controls">
                    <button
                        className="primary-btn"
                        onClick={() => {
                            if (status === 'idle') handleRequestEmit();
                            else if (['verified', 'failed', 'error'].includes(status)) handleRetry();
                        }}
                        disabled={!selectedSession || ['requesting', 'ready', 'listening', 'submitting'].includes(status)}
                    >
                        {status === 'idle' && (
                            <><Radio className="inline-icon" size={14} /> Request Emit</>
                        )}
                        {status === 'requesting' && (
                            <><RefreshCw className="inline-icon spinner" size={14} /> Requesting...</>
                        )}
                        {status === 'ready' && (
                            <><Timer className="inline-icon" size={14} /> In Queue</>
                        )}
                        {status === 'listening' && (
                            <><Ear className="inline-icon" size={14} /> Processing...</>
                        )}
                        {status === 'submitting' && (
                            <><Upload className="inline-icon" size={14} /> Submitting...</>
                        )}
                        {status === 'verified' && (
                            <><CheckCircle className="inline-icon" size={14} /> Success - Reset</>
                        )}
                        {status === 'failed' && (
                            <><XCircle className="inline-icon" size={14} /> Failed - Reset</>
                        )}
                        {status === 'error' && (
                            <><AlertTriangle className="inline-icon" size={14} /> Error - Reset</>
                        )}
                    </button>

                    {showCancel && status === 'ready' && (
                        <button className="primary-btn cancel-btn" onClick={handleCancel}>
                            <XCircle className="inline-icon" size={14} /> Cancel Request
                        </button>
                    )}

                    <button
                        className={`primary-btn ${showAutoTest ? 'active-toggle' : 'inactive-toggle'}`}
                        onClick={() => setShowAutoTest(!showAutoTest)}
                    >
                        <Beaker className="inline-icon" size={14} /> {showAutoTest ? 'Hide' : 'Show'} Auto-Test
                    </button>
                </div>

                {/* Auto-Test Panel */}
                {showAutoTest && (
                    <AutoTestPanel
                        onConfigChange={setConfig}
                        onRequestEmit={handleRequestEmit}
                        myRequest={myRequest}
                        baseConfig={config}
                        hasSelectedSession={!!selectedSession}
                        onDeselectSession={() => setSelectedSession(null)}
                    />
                )}

                {/* Log Panel */}
                <section className="log-section">
                    <LogPanel maxHeight="300px" />
                </section>
            </main>

            <HelpPanel
                isOpen={showHelp}
                onClose={() => setShowHelp(false)}
                type="student"
            />
        </div >
    );
}
