// LogPanel Component - Displays logs in UI with copy button

import { useState, useEffect, useRef } from 'react';
import { Clipboard, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { log } from '../utils/logger';
import type { LogEntry, LogLevel } from '../utils/logger';
import './LogPanel.css';

interface LogPanelProps {
    maxHeight?: string;
}

export function LogPanel({ maxHeight = '300px' }: LogPanelProps) {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isExpanded, setIsExpanded] = useState(true);
    const [copied, setCopied] = useState(false);
    const logContainerRef = useRef<HTMLDivElement>(null);
    const isNearBottomRef = useRef(true);

    useEffect(() => {
        const unsubscribe = log.subscribe(setLogs);
        return unsubscribe;
    }, []);

    const handleScroll = () => {
        if (!logContainerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
        const distanceToBottom = scrollHeight - scrollTop - clientHeight;
        isNearBottomRef.current = distanceToBottom < 50;
    };

    useEffect(() => {
        if (logContainerRef.current && isNearBottomRef.current && isExpanded) {
            logContainerRef.current.scrollTo({
                top: logContainerRef.current.scrollHeight,
                behavior: 'smooth'
            });
        }
    }, [logs, isExpanded]);

    const handleCopy = async () => {
        const text = log.getLogsAsText();
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleClear = () => {
        log.clear();
    };

    const getLevelColor = (level: LogLevel): string => {
        switch (level) {
            case 'error': return '#ff6b6b';
            case 'success': return '#51cf66';
            case 'debug': return '#868e96';
            default: return '#f8f9fa';
        }
    };

    return (
        <div className={`log-panel ${isExpanded ? 'expanded' : 'collapsed'}`}>
            <header className="log-header" onClick={() => setIsExpanded(!isExpanded)}>
                <div className="log-header-left">
                    <h3>Console Logs</h3>
                    <ChevronDown size={14} className="inline-icon" />
                </div>
                <div className="log-actions" onClick={e => e.stopPropagation()}>
                    <button onClick={handleCopy} title="Copy logs" className={`log-btn copy ${copied ? 'copied' : ''}`}>
                        <Clipboard size={14} className="inline-icon" />
                    </button>
                    <button onClick={handleClear} title="Clear logs" className="log-btn clear">
                        <Trash2 size={14} className="inline-icon" />
                    </button>
                </div>
            </header>

            <div
                className="log-content"
                style={{ maxHeight: isExpanded ? maxHeight : '0' }}
                ref={logContainerRef}
                onScroll={handleScroll}
            >
                {logs.length === 0 ? (
                    <div className="log-empty">No logs yet...</div>
                ) : (
                    logs.map((l, i) => (
                        <div key={i} className={`log-entry ${l.level}`}>
                            <span className="log-time">
                                {l.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                            <span className="log-message" style={{ color: getLevelColor(l.level) }}>
                                {l.message}
                            </span>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
