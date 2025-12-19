// Global Logger - UI-friendly logging system
// Replaces console.log with a subscribable log store

export type LogLevel = 'info' | 'success' | 'error' | 'debug';

export interface LogEntry {
    id: string;
    timestamp: Date;
    level: LogLevel;
    message: string;
}

type LogSubscriber = (logs: LogEntry[]) => void;

class Logger {
    private logs: LogEntry[] = [];
    private subscribers: Set<LogSubscriber> = new Set();
    private maxLogs = 500;

    private addLog(level: LogLevel, message: string): void {
        const entry: LogEntry = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date(),
            level,
            message
        };

        this.logs.push(entry);

        // Trim old logs
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(-this.maxLogs);
        }

        // Notify subscribers
        this.subscribers.forEach(sub => sub([...this.logs]));

        // Also log to console for debugging
        const prefix = `[${level.toUpperCase()}]`;
        switch (level) {
            case 'error':
                console.error(prefix, message);
                break;
            case 'success':
                console.log(`%c${prefix} ${message}`, 'color: green');
                break;
            case 'debug':
                console.debug(prefix, message);
                break;
            default:
                console.log(prefix, message);
        }
    }

    info(message: string): void {
        this.addLog('info', message);
    }

    success(message: string): void {
        this.addLog('success', message);
    }

    error(message: string): void {
        this.addLog('error', message);
    }

    debug(message: string): void {
        this.addLog('debug', message);
    }

    subscribe(callback: LogSubscriber): () => void {
        this.subscribers.add(callback);
        // Immediately call with current logs
        callback([...this.logs]);

        // Return unsubscribe function
        return () => {
            this.subscribers.delete(callback);
        };
    }

    getLogs(): LogEntry[] {
        return [...this.logs];
    }

    getLogsAsText(): string {
        return this.logs.map(entry => {
            const time = entry.timestamp.toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                fractionalSecondDigits: 3
            });
            return `[${time}] [${entry.level.toUpperCase()}] ${entry.message}`;
        }).join('\n');
    }

    clear(): void {
        this.logs = [];
        this.subscribers.forEach(sub => sub([]));
    }
}

// Singleton instance
export const log = new Logger();
