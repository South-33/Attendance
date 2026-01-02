// Teacher View - Session management, queue processing, emission

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    Radio,
    Key,
    Timer,
    Mic,
    Ear,
    Upload,
    CheckCircle,
    XCircle,
    ArrowLeft,
    Activity,
    UserCircle
} from 'lucide-react';
import { LogPanel } from '../components/LogPanel';
import { log } from '../utils/logger';
import { UltrasonicEmitter, AUDIO_CONFIG } from '../audio/audioEngine';
import type { EmitterConfig } from '../audio/audioEngine';
import { generatePattern, comparePatterns } from '../utils/patternUtils';
import {
    createSession,
    endSession,
    subscribeToQueue,
    updateQueueStatus,
    updateSessionHeartbeat
} from '../services/firebase';
import type { QueueEntry, QueueStatus } from '../services/firebase';
import { Timestamp } from 'firebase/firestore';
import './TeacherView.css';
import { HelpPanel } from '../components/HelpPanel';

interface TeacherViewProps {
    teacherId: string;
    teacherName: string;
    onBack: () => void;
}

export function TeacherView({ teacherId, teacherName, onBack }: TeacherViewProps) {
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [passcode, setPasscode] = useState<string | null>(null);
    const [queue, setQueue] = useState<QueueEntry[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [copied, setCopied] = useState(false);

    const emitterRef = useRef<UltrasonicEmitter | null>(null);
    const unsubscribeRef = useRef<(() => void) | null>(null);
    const creatingRef = useRef(false); // Guard against StrictMode double-call
    const heartbeatRef = useRef<number | null>(null);
    const verifyingRef = useRef<Set<string>>(new Set()); // Prevent double-verification
    const queueRef = useRef<QueueEntry[]>([]); // Always-current queue for async functions

    // Keep queueRef in sync with queue state
    useEffect(() => {
        queueRef.current = queue;
    }, [queue]);

    // Initialize session on mount
    useEffect(() => {
        const initSession = async () => {
            // Prevent double creation from StrictMode
            if (creatingRef.current) return;
            creatingRef.current = true;

            try {
                const session = await createSession(teacherId, teacherName);
                setSessionId(session.id);
                setPasscode(session.passcode);
                log.success(`Session started: ${session.id}`);

                // Initialize emitter
                emitterRef.current = new UltrasonicEmitter();
                await emitterRef.current.init();
            } catch (e) {
                log.error(`Failed to create session: ${e}`);
                creatingRef.current = false; // Reset on error
            }
        };

        initSession();

        return () => {
            if (unsubscribeRef.current) {
                unsubscribeRef.current();
            }
            if (emitterRef.current) {
                emitterRef.current.cleanup();
            }
            if (heartbeatRef.current) {
                clearInterval(heartbeatRef.current);
            }
        };
    }, [teacherId, teacherName]);

    // Heartbeat: Update lastActive every 5 seconds to show presence
    useEffect(() => {
        if (!sessionId) return;

        // Send heartbeat immediately, then every 5 seconds
        updateSessionHeartbeat(sessionId);
        heartbeatRef.current = window.setInterval(() => {
            updateSessionHeartbeat(sessionId);
        }, 5000);

        // Cleanup session on tab close
        const handleBeforeUnload = () => {
            // Use sendBeacon for reliable cleanup on tab close
            endSession(sessionId).catch(() => { });
        };

        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            if (heartbeatRef.current) {
                clearInterval(heartbeatRef.current);
            }
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, [sessionId]);

    // Subscribe to queue when session is created
    useEffect(() => {
        if (!sessionId) return;

        unsubscribeRef.current = subscribeToQueue(sessionId, (entries) => {
            setQueue(entries);
            // Detailed logging for debugging
            const statusCounts = entries.reduce((acc, e) => {
                acc[e.status] = (acc[e.status] || 0) + 1;
                return acc;
            }, {} as Record<string, number>);
            log.debug(`[Queue] Updated: ${entries.length} entries | ${Object.entries(statusCounts).map(([s, c]) => `${s}:${c}`).join(', ')}`);

            // Log if there are submitted entries without patterns (indicates issue)
            const submittedNoPattern = entries.filter(e => e.status === 'submitted' && (!e.detectedPattern || e.detectedPattern.length === 0));
            if (submittedNoPattern.length > 0) {
                log.debug(`[Queue] Waiting for ${submittedNoPattern.length} student(s) to submit patterns...`);
            }
        });

        return () => {
            if (unsubscribeRef.current) {
                unsubscribeRef.current();
            }
        };
    }, [sessionId]);

    // Helper: Create a hash of EmitterConfig for grouping
    const getConfigKey = (config: EmitterConfig): string => {
        return `${config.volume}_${config.freqLow}_${config.freqHigh}_${config.pulseDuration}_${config.pulseGap}_${config.useOutputFilter}_${config.filterCutoff}`;
    };

    // Process queue automatically when ready students are available
    // Use debounce to collect concurrent requests before processing
    const processTimeoutRef = useRef<number | null>(null);

    useEffect(() => {
        const readyStudents = queue.filter(e => e.status === 'ready');
        if (readyStudents.length > 0 && !isProcessing) {
            // Clear any pending timeout
            if (processTimeoutRef.current) {
                clearTimeout(processTimeoutRef.current);
            }
            // Wait 200ms to collect more students before processing
            // This handles the case where 2 students request at nearly the same time
            processTimeoutRef.current = window.setTimeout(() => {
                // Get fresh list after waiting (more students may have joined)
                const currentReady = queueRef.current.filter(e => e.status === 'ready');
                if (currentReady.length > 0) {
                    log.info(`[Queue] Collected ${currentReady.length} student(s), starting batch...`);
                    processQueue(currentReady);
                }
            }, 200);
        }

        return () => {
            if (processTimeoutRef.current) {
                clearTimeout(processTimeoutRef.current);
            }
        };
    }, [queue, isProcessing]);

    // Smart queue processing: group by config, process groups sequentially
    const processQueue = async (students: QueueEntry[]) => {
        if (isProcessing || students.length === 0) return;
        setIsProcessing(true);

        try {
            // Group students by their config
            const configGroups = new Map<string, QueueEntry[]>();
            for (const student of students) {
                const key = getConfigKey(student.config);
                if (!configGroups.has(key)) {
                    configGroups.set(key, []);
                }
                configGroups.get(key)!.push(student);
            }

            // Log grouping info
            if (configGroups.size === 1) {
                log.info(`[Process] Batching ${students.length} students (same config)`);
            } else {
                log.info(`[Process] Processing ${configGroups.size} config groups sequentially`);
            }

            // Process each config group sequentially
            for (const [configKey, group] of configGroups) {
                await processBatch(group, configKey);
            }

        } finally {
            setIsProcessing(false);

            // RACE CONDITION FIX: Check if any new 'ready' students arrived while we were processing
            // Use queueRef.current for the latest state (not the stale closure from when processQueue started)
            const newReadyStudents = queueRef.current.filter(e => e.status === 'ready');
            if (newReadyStudents.length > 0) {
                log.debug(`[Process] Found ${newReadyStudents.length} new ready student(s) after processing, starting next batch...`);
                // Small delay to let React update state, then process recursively
                setTimeout(() => {
                    // Re-check in case state changed during timeout
                    const stillReady = queueRef.current.filter(e => e.status === 'ready');
                    if (stillReady.length > 0) {
                        processQueue(stillReady);
                    }
                }, 50);
            }
        }
    };

    // Process a single batch of students with the same config
    const processBatch = async (students: QueueEntry[], configKey: string) => {
        const batchId = `batch_${Date.now()}`;
        const config = students[0].config;
        const studentIds = students.map(s => s.id);

        log.info(`[Batch] ${configKey}: ${students.length} student(s)`);

        try {
            // Generate pattern for this batch
            const pattern = generatePattern();
            log.info(`[Batch] Pattern: ${pattern.join('')}`);

            // Mark ALL students as emitting SIMULTANEOUSLY (prevents timing skew)
            await Promise.all(students.map(student =>
                updateQueueStatus(student.id, 'emitting', {
                    batchId,
                    emittedPattern: pattern
                })
            ));

            // HANDSHAKE: Wait for ALL students to signal 'listening' (mic ready)
            // Students update their status to 'listening' after mic init completes
            const HANDSHAKE_TIMEOUT = 3000; // Max 3 seconds to wait
            const startTime = Date.now();
            let allReady = false;

            log.debug(`[Handshake] Waiting for ${students.length} student(s) to be ready...`);

            while (Date.now() - startTime < HANDSHAKE_TIMEOUT) {
                // Use queueRef.current for latest state (not stale closure)
                const readyCount = queueRef.current.filter(
                    e => studentIds.includes(e.id) && e.status === 'listening'
                ).length;

                if (readyCount === students.length) {
                    allReady = true;
                    log.success(`[Handshake] All ${students.length} student(s) ready!`);
                    break;
                }

                // Wait 50ms before checking again
                await new Promise(r => setTimeout(r, 50));
            }

            if (!allReady) {
                const readyCount = queueRef.current.filter(
                    e => studentIds.includes(e.id) && e.status === 'listening'
                ).length;
                log.info(`[Handshake] Timeout: ${readyCount}/${students.length} students ready, proceeding anyway`);
            }

            // Small buffer after all ready to ensure recording has started
            await new Promise(r => setTimeout(r, 100));

            // Emit the pattern
            await emitterRef.current?.emit(pattern, config);

            // Small delay for Bluetooth audio latency (100-300ms typical)
            // Ensures the last pulse is fully transmitted before asking students to submit
            await new Promise(r => setTimeout(r, 150));

            // Signal ALL students to submit SIMULTANEOUSLY
            await Promise.all(students.map(student =>
                updateQueueStatus(student.id, 'submitted')
            ));

            log.info('[Batch] Waiting for student submissions...');

        } catch (e) {
            log.error(`[Batch] Process failed: ${e}`);
            await Promise.all(students.map(student =>
                updateQueueStatus(student.id, 'failed')
            ));
        }
    };

    // Verify a student's submission
    const verifyStudent = useCallback(async (entry: QueueEntry) => {
        if (!entry.emittedPattern || !entry.detectedPattern) {
            log.error(`[Verify] Missing patterns for ${entry.studentName}`);
            await updateQueueStatus(entry.id, 'failed');
            return;
        }

        const result = comparePatterns(entry.emittedPattern, entry.detectedPattern);

        log.info(`[Verify] ${entry.studentName}:`);
        result.details.forEach((d: string) => log.info(`  ${d}`));
        log.info(`[Verify] Score: ${result.matchCount}/${AUDIO_CONFIG.NUM_PULSES}, Passed: ${result.passed}`);

        await updateQueueStatus(entry.id, result.passed ? 'verified' : 'failed', {
            matchCount: result.matchCount,
            passed: result.passed,
            verifiedAt: Timestamp.now()
        });
    }, []);

    // Listen for submitted students and verify them
    useEffect(() => {
        const submittedWithPattern = queue.filter(
            e => e.status === 'submitted' && e.detectedPattern && e.detectedPattern.length > 0
        );

        submittedWithPattern.forEach(entry => {
            // Skip if already being verified
            if (verifyingRef.current.has(entry.id)) return;

            verifyingRef.current.add(entry.id);
            verifyStudent(entry).finally(() => {
                verifyingRef.current.delete(entry.id);
            });
        });
    }, [queue, verifyStudent]);

    const handleEndSession = async () => {
        if (sessionId) {
            try {
                await endSession(sessionId);
                log.info('Session ended');
            } catch (e) {
                log.debug('Session already ended or deleted');
            }
        }
        onBack();
    };

    const getStatusBadge = (status: QueueStatus) => {
        const badges: Record<QueueStatus, { label: string; icon: React.ReactNode }> = {
            'waiting': { label: 'Waiting', icon: <Timer size={14} /> },
            'ready': { label: 'Ready', icon: <Mic size={14} /> },
            'emitting': { label: 'Emitting', icon: <Radio size={14} /> },
            'listening': { label: 'Listening', icon: <Ear size={14} /> },
            'submitted': { label: 'Submitted', icon: <Upload size={14} /> },
            'verified': { label: 'Verified', icon: <CheckCircle size={14} /> },
            'failed': { label: 'Failed', icon: <XCircle size={14} /> }
        };
        const badge = badges[status] || { label: status, icon: null };
        return (
            <span className={`status-badge ${status}`} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {badge.icon}
                {badge.label}
            </span>
        );
    };

    return (
        <div className="teacher-view view-animate">
            <header className="view-header">
                <div className="header-left">
                    <button onClick={handleEndSession} className="back-btn"><ArrowLeft className="inline-icon" size={16} /> End Session</button>
                    <h1><Radio className="inline-icon" /> Teacher: {teacherName}</h1>
                </div>

                <div className="header-right">
                    <div className="session-badges-right">
                        <span className="session-id-tag">ID: {sessionId ? sessionId.slice(0, 4) : '----'}</span>
                        <span
                            className={`code-badge ${copied ? 'copied' : ''} ${!passcode ? 'initializing' : ''}`}
                            onClick={() => {
                                if (passcode) {
                                    navigator.clipboard.writeText(passcode);
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 2000);
                                    log.success('Code copied!');
                                }
                            }}
                            title={passcode ? "Click to copy" : "Initializing..."}
                        >
                            <Key className="inline-icon" size={16} />
                            {copied ? 'COPIED!' : <>CODE: <strong>{passcode || '......'}</strong></>}
                        </span>
                    </div>
                    <button
                        className="help-btn"
                        onClick={() => setShowHelp(true)}
                        title="Help / Manual"
                    >
                        HOW TO USE
                    </button>
                </div>
            </header>

            <main className="view-content">
                <div className="view-main-grid">
                    <section className="roster-section">
                        <div className="section-header">
                            <h2><Activity className="inline-icon" size={18} /> Class Roster ({queue.length})</h2>
                            <div className="status-summary">
                                <span className="count-verified">{queue.filter(e => e.status === 'verified').length} Verified</span>
                                <span className="count-pending">{queue.filter(e => e.status !== 'verified' && e.status !== 'failed').length} Pending</span>
                            </div>
                        </div>
                        {queue.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon"><UserCircle size={48} opacity={0.2} /></div>
                                <p>No students have joined yet.</p>
                                <small>Share the room code with your class to begin.</small>
                            </div>
                        ) : (
                            <div className="roster-table-container">
                                <table className="roster-table">
                                    <thead>
                                        <tr>
                                            <th>Student Name</th>
                                            <th>Status</th>
                                            <th>Match Score</th>
                                            <th>Last Update</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {[...queue].reverse().map(entry => (
                                            <tr key={entry.id} className={`status-row-${entry.status}`}>
                                                <td className="col-name">
                                                    <strong>{entry.studentName}</strong>
                                                    <small>{entry.id.slice(0, 8)}</small>
                                                </td>
                                                <td className="col-status">
                                                    {getStatusBadge(entry.status)}
                                                </td>
                                                <td className="col-score">
                                                    {entry.matchCount !== undefined ? (
                                                        <span className={`score-tag ${entry.passed ? 'pass' : 'fail'}`}>
                                                            {entry.matchCount}/{AUDIO_CONFIG.NUM_PULSES}
                                                        </span>
                                                    ) : (
                                                        <span className="score-placeholder">--</span>
                                                    )}
                                                </td>
                                                <td className="col-time">
                                                    {entry.verifiedAt ? (
                                                        entry.verifiedAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                                    ) : (
                                                        '--'
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    <div className="side-panels">
                        <section className="log-section">
                            <LogPanel maxHeight="350px" />
                        </section>
                    </div>
                </div>
            </main>

            <HelpPanel
                isOpen={showHelp}
                onClose={() => setShowHelp(false)}
                type="teacher"
            />
        </div>
    );
}
