import './HelpPanel.css';

interface HelpPanelProps {
    isOpen: boolean;
    onClose: () => void;
    type: 'teacher' | 'student';
}

export function HelpPanel({ isOpen, onClose, type }: HelpPanelProps) {
    if (!isOpen) return null;

    return (
        <div className="help-overlay" onClick={onClose}>
            <div className="help-panel" onClick={e => e.stopPropagation()}>
                <header className="help-header">
                    <h3>// SYSTEM MANUAL</h3>
                    <button onClick={onClose} className="close-help-btn">✕</button>
                </header>

                <div className="help-content">
                    {type === 'teacher' ? (
                        <>
                            <section className="help-section">
                                <h4>01. BROADCAST ROOM CODE</h4>
                                <p>Your session begins with a unique 6-digit code. Display this to your students; it's their key to joining your local network environment.</p>
                            </section>

                            <section className="help-section">
                                <h4>02. AUTOMATED QUEUEING</h4>
                                <p>
                                    As students join, they enter a <strong>READY</strong> state. The system is fully autonomous: it groups students based on hardware configurations and executes ultrasonic handshakes without further teacher input.
                                </p>
                            </section>

                            <section className="help-section">
                                <h4>03. REAL-TIME VERIFICATION</h4>
                                <p>
                                    The "Student Queue" updates live. Green (Verified) indicates successful proximity detection via sonar-like pulse matching.
                                </p>
                            </section>

                            <div className="help-note">
                                {'>'} Some hardware like low end speakers may have a hard time emitting the ultrasonic sounds.
                            </div>
                        </>
                    ) : (
                        <>
                            <section className="help-section">
                                <h4>01. JOIN THE SESSION</h4>
                                <p>Enter the 6-digit room code from the teacher's screen to establish a real-time WebSocket connection to the class.</p>
                            </section>

                            <section className="help-section">
                                <h4>02. MIC ACTIVATION</h4>
                                <p>Tap <strong>REQUEST EMIT</strong>. This triggers a microphone permission request and prepares the FFT analyser to catch the high-frequency signature.</p>
                            </section>

                            <section className="help-section">
                                <h4>03. TWO-WAY HANDSHAKE</h4>
                                <p>
                                    Once in the queue, wait. Your device will signal the teacher when it's ready. The teacher's device then emits a 19kHz pulse pattern which your phone verifies instantly.
                                </p>
                            </section>

                            <div className="help-note">
                                {'>'} PRO-TIP: Ensure Teacher's device is unmuted and the Student's microphone is not obstructed.
                            </div>
                        </>
                    )}
                </div>

                <footer className="help-footer">
                    <span>ATTENDANCE V2 // SYS_HELP</span>
                </footer>
            </div>
        </div>
    );
}
