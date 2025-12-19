// Firebase Configuration and Firestore Helpers

import { initializeApp } from 'firebase/app';
import {
    getFirestore,
    collection,
    doc,
    setDoc,
    getDocs,
    updateDoc,
    deleteDoc,
    onSnapshot,
    query,
    where,
    orderBy,
    serverTimestamp,
    Timestamp,
    QuerySnapshot
} from 'firebase/firestore';
import type { Unsubscribe, DocumentData } from 'firebase/firestore';
import { log } from '../utils/logger';
import type { PulseType, EmitterConfig } from '../audio/audioEngine';

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ============== TYPES ==============
export type QueueStatus = 'waiting' | 'ready' | 'emitting' | 'listening' | 'submitted' | 'verified' | 'failed';

export interface Session {
    id: string;
    teacherId: string;
    teacherName: string;
    passcode: string;
    active: boolean;
    createdAt: Timestamp;
    lastActive?: Timestamp; // Heartbeat timestamp for presence
}

// Session is considered stale if no heartbeat for this many seconds
const SESSION_STALE_SECONDS = 15;

export interface QueueEntry {
    id: string;
    sessionId: string;
    studentId: string;
    studentName: string;
    status: QueueStatus;
    batchId?: string;
    config: EmitterConfig;
    emittedPattern?: PulseType[];
    detectedPattern?: PulseType[];
    matchCount?: number;
    passed?: boolean;
    createdAt: Timestamp;
    verifiedAt?: Timestamp;
    diagnosticData?: {
        peaks: {
            type: string;
            amplitude: number;
            frequency: number;
            snr: number;
        }[];
        noiseFloor: number;
    };
}

// ============== SESSION FUNCTIONS ==============

// Close any existing active sessions for this teacher before creating new one
async function closeExistingSessions(teacherId: string): Promise<void> {
    const q = query(
        collection(db, 'sessions'),
        where('teacherId', '==', teacherId),
        where('active', '==', true)
    );

    const snapshot = await getDocs(q);
    const closePromises = snapshot.docs.map((d: DocumentData) =>
        updateDoc(doc(db, 'sessions', d.id), { active: false })
    );

    if (closePromises.length > 0) {
        await Promise.all(closePromises);
        log.info(`Closed ${closePromises.length} existing session(s)`);
    }
}

export async function createSession(teacherId: string, teacherName: string): Promise<{ id: string; passcode: string }> {
    // Close any existing sessions for this teacher first (prevents duplicates)
    await closeExistingSessions(teacherId);

    const passcode = Math.floor(100000 + Math.random() * 900000).toString();

    const sessionRef = doc(collection(db, 'sessions'));
    const session: Omit<Session, 'id'> = {
        teacherId,
        teacherName,
        passcode,
        active: true,
        createdAt: serverTimestamp() as Timestamp,
        lastActive: serverTimestamp() as Timestamp
    };

    await setDoc(sessionRef, session);
    log.success(`Session created: ${sessionRef.id} (Code: ${passcode})`);
    return { id: sessionRef.id, passcode };
}

// Update session heartbeat (call periodically to show presence)
export async function updateSessionHeartbeat(sessionId: string): Promise<void> {
    const sessionRef = doc(db, 'sessions', sessionId);
    await updateDoc(sessionRef, { lastActive: serverTimestamp() });
}

export async function endSession(sessionId: string): Promise<void> {
    const sessionRef = doc(db, 'sessions', sessionId);
    await updateDoc(sessionRef, { active: false });

    // Also clean up any pending queue entries for this session
    const q = query(
        collection(db, 'queue'),
        where('sessionId', '==', sessionId)
    );
    const snapshot = await getDocs(q);
    const deletePromises = snapshot.docs.map((d: DocumentData) =>
        deleteDoc(doc(db, 'queue', d.id))
    );

    if (deletePromises.length > 0) {
        await Promise.all(deletePromises);
        log.debug(`Cleaned up ${deletePromises.length} queue entries`);
    }

    log.info(`Session ended: ${sessionId}`);
}

// Cleanup all inactive sessions older than given hours (for maintenance)
export async function cleanupOldSessions(hoursOld: number = 24): Promise<number> {
    const cutoff = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
    const q = query(
        collection(db, 'sessions'),
        where('active', '==', false)
    );

    const snapshot = await getDocs(q);
    let deleted = 0;

    for (const d of snapshot.docs) {
        const data = d.data();
        if (data.createdAt?.toDate() < cutoff) {
            await deleteDoc(doc(db, 'sessions', d.id));
            deleted++;
        }
    }

    if (deleted > 0) {
        log.info(`Cleaned up ${deleted} old sessions`);
    }
    return deleted;
}

// DEV UTIL: Clear ALL sessions (both active and inactive)
export async function clearAllSessions(): Promise<number> {
    const snapshot = await getDocs(collection(db, 'sessions'));
    let deleted = 0;

    for (const d of snapshot.docs) {
        await deleteDoc(doc(db, 'sessions', d.id));
        deleted++;
    }

    log.success(`Cleared ${deleted} sessions`);
    return deleted;
}

export function subscribeToActiveSessions(
    callback: (sessions: Session[]) => void
): Unsubscribe {
    const q = query(
        collection(db, 'sessions'),
        where('active', '==', true),
        orderBy('createdAt', 'desc')
    );

    return onSnapshot(q, (snapshot: QuerySnapshot) => {
        const now = Date.now();
        const sessions = snapshot.docs
            .map(d => ({
                id: d.id,
                ...d.data()
            }) as Session)
            .filter(s => {
                // Filter out stale sessions (no heartbeat in last N seconds)
                if (!s.lastActive) return true; // Legacy sessions without lastActive
                const lastActiveTime = s.lastActive.toDate().getTime();
                const ageSeconds = (now - lastActiveTime) / 1000;
                return ageSeconds < SESSION_STALE_SECONDS;
            });
        callback(sessions);
    });
}

// Look up a session by its 6-digit passcode
export async function getSessionByCode(code: string): Promise<Session | null> {
    const q = query(
        collection(db, 'sessions'),
        where('passcode', '==', code),
        where('active', '==', true)
    );
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;

    // Return the first match (should be unique in practice for active sessions)
    const d = snapshot.docs[0];
    return { id: d.id, ...d.data() } as Session;
}

// ============== QUEUE FUNCTIONS ==============
export async function joinQueue(
    sessionId: string,
    studentId: string,
    studentName: string,
    config: EmitterConfig
): Promise<string> {
    const queueRef = doc(collection(db, 'queue'));
    const entry: Omit<QueueEntry, 'id'> = {
        sessionId,
        studentId,
        studentName,
        status: 'waiting',
        config,
        createdAt: serverTimestamp() as Timestamp
    };

    await setDoc(queueRef, entry);
    log.info(`Joined queue: ${queueRef.id}`);
    return queueRef.id;
}

export async function updateQueueStatus(
    queueId: string,
    status: QueueStatus,
    additionalData?: Partial<QueueEntry>
): Promise<void> {
    const queueRef = doc(db, 'queue', queueId);
    try {
        await updateDoc(queueRef, {
            status,
            ...additionalData,
            ...(status === 'verified' || status === 'failed' ? { verifiedAt: serverTimestamp() } : {})
        });
        log.debug(`Queue ${queueId.slice(0, 8)} → ${status}${additionalData?.detectedPattern ? ` (with ${additionalData.detectedPattern.length} peaks)` : ''}`);
    } catch (e) {
        log.error(`❌ Failed to update queue ${queueId.slice(0, 8)} to ${status}: ${e}`);
        throw e; // Re-throw so caller knows it failed
    }
}

export function subscribeToQueue(
    sessionId: string,
    callback: (entries: QueueEntry[]) => void
): Unsubscribe {
    const q = query(
        collection(db, 'queue'),
        where('sessionId', '==', sessionId),
        orderBy('createdAt', 'asc')
    );

    return onSnapshot(q, (snapshot: QuerySnapshot) => {
        const entries = snapshot.docs.map(d => ({
            id: d.id,
            ...d.data()
        })) as QueueEntry[];
        callback(entries);
    });
}

export function subscribeToMyRequest(
    queueId: string,
    callback: (entry: QueueEntry | null) => void
): Unsubscribe {
    const queueRef = doc(db, 'queue', queueId);

    return onSnapshot(queueRef, (snapshot) => {
        if (snapshot.exists()) {
            callback({ id: snapshot.id, ...snapshot.data() } as QueueEntry);
        } else {
            callback(null);
        }
    });
}

export async function deleteQueueEntry(queueId: string): Promise<void> {
    await deleteDoc(doc(db, 'queue', queueId));
    log.debug(`Queue entry deleted: ${queueId}`);
}

// ============== UTILITY ==============
export function generateDeviceId(): string {
    let deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
        deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('deviceId', deviceId);
    }
    return deviceId;
}

export function getCachedName(): string | null {
    return localStorage.getItem('userName');
}

export function setCachedName(name: string): void {
    localStorage.setItem('userName', name);
}
