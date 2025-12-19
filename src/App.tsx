// Main App - Router and Name Registration

import { useState, useEffect } from 'react';
import {
  Radio,
  Mic,
  Volume2,
  Activity,
  ArrowRight,
  UserCircle
} from 'lucide-react';
import { TeacherView } from './views/TeacherView';
import { StudentView } from './views/StudentView';
import { getCachedName, setCachedName, generateDeviceId } from './services/firebase';
import { log } from './utils/logger';
import './App.css';

type AppView = 'register' | 'role' | 'teacher' | 'student';

function App() {
  console.log('[App] Rendering...');
  const [view, setView] = useState<AppView>('register');
  const [name, setName] = useState('');
  const [deviceId] = useState(() => generateDeviceId());
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  useEffect(() => {
    // One-time cleanup of old inactive sessions on app load
    import('./services/firebase').then(({ cleanupOldSessions }) => {
      cleanupOldSessions(0); // Clean ALL inactive sessions
    });

    const cached = getCachedName();
    if (cached) {
      setName(cached);
      setView('role');
      log.info(`Welcome back, ${cached}!`);
    }
  }, []);

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      setCachedName(name.trim());
      log.info(`Registered as: ${name.trim()}`);
      setView('role');
    }
  };

  const handleSelectRole = async (role: 'teacher' | 'student') => {
    // Touch to unlock audio on mobile
    try {
      const ctx = new AudioContext();
      await ctx.resume();
      await ctx.close();
      log.debug('Audio unlocked');
    } catch (e) {
      log.debug('Audio unlock not needed');
    }

    setView(role);
  };

  const handleBack = () => {
    setView('role');
  };

  // Register View
  if (view === 'register') {
    return (
      <div className="app-container view-animate" key="view-register">
        <div className="register-card">
          <h1><Radio className="inline-icon" size={32} /> Attendance V2</h1>
          <p>Ultrasonic Proximity Verification</p>
          <form onSubmit={handleRegister}>
            <input
              type="text"
              placeholder="Enter your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={!name.trim()}>
              Continue <ArrowRight className="inline-icon" size={18} />
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Role Selection View
  if (view === 'role') {
    return (
      <div className="app-container view-animate" key="view-role">
        <div className="role-card">
          <h1><UserCircle className="inline-icon" size={32} /> Hi, {name}!</h1>
          <p>Select your role</p>
          <div className="role-buttons">
            <button className="role-btn teacher" onClick={() => handleSelectRole('teacher')}>
              <Radio className="role-icon" size={24} /> Teacher
              <span>Start a class session</span>
            </button>
            <button className="role-btn student" onClick={() => handleSelectRole('student')}>
              <Mic className="role-icon" size={24} /> Student
              <span>Join a class</span>
            </button>
          </div>
          <button className="change-name" onClick={() => setView('register')}>
            Change name
          </button>
        </div>

        <div className="how-it-works">
          <div className="steps-grid">
            {[
              {
                icon: <Radio size={24} />,
                banner: 'HOW',
                title: '1. Real-time Sync',
                desc: 'Firebase coordinates a secure session via a unique 6-digit room code.',
                details: 'Uses Firestore real-time listeners for sub-100ms latency. Implements a two-way handshake protocol (Ready → Emitting → Listening) to ensure both devices are perfectly synchronized before audio transmission begins.'
              },
              {
                icon: <Volume2 size={24} />,
                banner: 'IT',
                title: '2. Ultrasonic Emission',
                desc: 'Teacher emits a random 19kHz pulse pattern (inaudible to humans).',
                details: 'Utilizes Frequency Shift Keying (FSK) with two carrier frequencies: 17.5kHz (Low) and 19.0kHz (High). The system generates a random 6-bit pattern (e.g., HLHHLH) where each pulse is 80ms with 50ms silence gaps.'
              },
              {
                icon: <Activity size={24} />,
                banner: 'WORKS',
                title: '3. FFT Analysis',
                desc: 'Student devices use Fast Fourier Transform to verify the signature.',
                details: 'A Web Audio API analyser running 8192-bin FFT detects peaks in the ultrasonic range. The verification algorithm uses subsequence matching to validate the pattern, allowing it to pass even if some pulses are lost to noise.'
              }
            ].map((step, idx) => (
              <div
                key={idx}
                className={`step-item ${expandedStep === idx ? 'expanded' : ''}`}
                onClick={() => setExpandedStep(expandedStep === idx ? null : idx)}
              >
                <div className="step-icon">
                  {step.icon}
                  <span className="step-banner">{step.banner}</span>
                </div>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.desc}</p>
                  <div className="step-details">
                    <div className="step-rule"></div>
                    <p>{step.details}</p>
                  </div>
                  <span className="expand-hint">{expandedStep === idx ? 'Close details' : 'Click for details'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Teacher View
  if (view === 'teacher') {
    return (
      <TeacherView
        teacherId={deviceId}
        teacherName={name}
        onBack={handleBack}
      />
    );
  }

  // Student View
  if (view === 'student') {
    return (
      <StudentView
        studentId={deviceId}
        studentName={name}
        onBack={handleBack}
      />
    );
  }

  return null;
}

export default App;
