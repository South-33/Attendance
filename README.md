# Attendance - Ultrasonic Proximity Verification
> **Status:** ✅ Finalized "Fat Firework" Industrial Design
> **Theme:** 🧨 **Firework Brutalist** (Red / Industrial Silver / Deep Black)

## 🎯 Project Overview

A high-fidelity web application built for verifyable attendance through ultrasonic proximity detection. The system leverages inaudible high-frequency audio signatures to ensure physical presence without the need for GPS or specialized hardware.

### Design Philosophy
- **Firework Brutalist**: High-contrast industrial aesthetic using sharp square elements, thick borders, and a stark Red/Silver palette.
- **Stable Dashboards**: Optimized for minimal layout shift using `scrollbar-gutter: stable` and session initialization placeholders.
- **Snappy Transitions**: Custom `view-animate` system for mechanical, high-performance screen entry.

### Core Concept
- **Teacher**: Emits random 6-pulse pattern (e.g., `HLHHLH`)
- **Student**: Listens with microphone, detects frequencies, submits up to 10 peaks
- **Verification**: Teacher finds emitted pattern as subsequence in detected → 5/6 in order = pass

### Tech Stack
- **Frontend**: Vite + React + TypeScript
- **Backend**: Firebase Firestore (real-time sync)
- **Audio**: Web Audio API (OscillatorNode, AnalyserNode, BiquadFilterNode)

---

## 🆕 Recent Features

### Passcode Room System
- **Security**: Closed session looping (no public list of classes).
- **Teacher**: Generates unique **6-digit room code** (e.g. `384617`).
- **Student**: Enters code to find and join specific session.
- **Copy Feedback**: One-tap copying with "COPIED!" visual confirmation and snappier button physics.

### Real-time Roster Visibility
- **Instant Connect**: Students appear in the teacher's roster as soon as they join a room code, marked as 'waiting'.
- **Live Status**: Real-time feedback in the roster as students move through 'ready' → 'listening' → 'verified'.
- **Automatic Cleanup**: Students are automatically removed from the roster if they leave the page or close their tab.

### Teacher Session Presence System
- **Heartbeat**: Teacher sends `lastActive` timestamp every 5 seconds
- **Stale Detection**: Students only see sessions with activity in last 15 seconds
- **Tab Close Cleanup**: `beforeunload` event marks session as inactive immediately
- **Result**: Students don't see "ghost" sessions from teachers who left

### Two-Way Handshake Protocol
- **Deferred Mic Start**: Student's microphone only starts when teacher signals 'emitting'
- **Student Signals Back**: After mic init, student updates status to 'listening'
- **Teacher Waits**: Teacher polls for all batch students to be 'listening' (max 3s timeout)
- **Flow**: `ready` → teacher sets `emitting` → student starts mic → student sets `listening` → teacher emits
- **Deleted Request Handling**: If teacher ends session, student UI resets gracefully
- **Result**: No fixed delays, faster on fast networks, reliable on slow ones

### Hardware-Timed Emission
- **AudioContext.currentTime Scheduling**: All pulses scheduled upfront using hardware audio clock
- **Tab Throttling Immune**: Works correctly even if teacher's browser tab is backgrounded
- **Result**: Consistent pulse timing regardless of JavaScript timer throttling

### Smart Batching
- **Config-Based Grouping**: Students with identical audio config are batched together
- **Sequential Processing**: Different config groups are processed in order
- **Efficiency**: 10 students with default config = 1 emission; 3 students with different volumes = 3 emissions
- **Race Condition Fix**: After processing, teacher re-checks for any new 'ready' students that arrived during emission
- **Result**: Faster verification for typical classrooms, no missed requests during rapid testing

### Auto-Test Panel (Student)
Comprehensive testing tool for A/B testing audio configurations:
- **Volume Presets**: Test 100%, 75%, 50%, 25%, 0% (control)
- **Retry Logic**: Automatically retries failed tests up to 3 times
- **Detailed Diagnostics**: Shows amplitude (dB), SNR, noise floor for each peak
- **Copy Results**: Export full test report to clipboard
- **Local Test Mode**: Test using device's own speaker + mic (no teacher needed)

### Response Timeout
- After submitting pattern, student waits max 5 seconds for verification
- If no response, automatically retries the request
- Prevents students from getting stuck indefinitely

### Diagnostic Data
Each test captures detailed signal metrics:
- **Peak Amplitude**: How loud each detected frequency was (e.g., `-35dB`)
- **SNR**: Signal-to-Noise Ratio for each peak
- **Noise Floor**: Background noise level during detection
- **Result**: Helps diagnose why tests fail (too quiet vs clipping)

---

## 🔊 EMISSION LOGIC (Teacher)

**File:** `src/audio/audioEngine.ts` → `UltrasonicEmitter` class

```
1. Generate random pattern: ['H', 'L', 'H', 'H', 'L', 'H'] (6 pulses)
2. For each pulse:
   - H = 19000Hz, L = 17500Hz (sine wave)
   - Fade envelope (2ms in, 8ms out) prevents pops
   - Duration: 80ms per pulse
   - Gap: 50ms between pulses
3. Output Filter: Quad 16.5kHz highpass (48dB/oct brick-wall)
   - Blocks audible transients/pops below 16.5kHz
   - 1kHz headroom below 17.5kHz signal = no attenuation
4. Total emission: ~780ms
```

---

## 🎤 DETECTION LOGIC (Student)

**File:** `src/audio/audioEngine.ts` → `UltrasonicListener` class

### Audio Chain
```
Mic → Highpass(17kHz) → Lowpass(20kHz) → Gain(60x) → Limiter → FFT(8192)
```

### Detection Flow
```
1. Join Room via 6-digit Code
2. Start recording when status = 'ready'
3. Clear peaks when status = 'emitting' (removes pre-emission noise)
4. Every frame (~16ms):
   - FFT analysis (8192 bins → ~5.9Hz resolution)
   - SNR check: must be 2x above noise floor
   - Frequency validation: H = 19000±100Hz, L = 17500±100Hz
   - Peak merge: within 400Hz AND 50ms → same peak
5. On submit: cap at 10 strongest, sort by time, return pattern
```

---

## ✅ VERIFICATION LOGIC (Teacher)

**File:** `src/utils/patternUtils.ts` → `comparePatterns()`

### Subsequence Matching
```
Emitted:  HLHHLH (6 pulses)
Detected: LHLHHLLH (8 peaks with some noise)
           ↑↓↑↑↓↑
Found:     HLHHLH as subsequence → 6/6 match ✅
```

### Security
- **MAX_PEAKS = 10**: Prevents cheater flooding
- **Pass threshold**: 5/6 pulses in order
- **Guess rate**: ~10.9% for random guessing (improved from 18.75%)
- **Frequency tolerance**: ±100Hz (tightened for accuracy)

---

## ⚙️ Audio Configuration

| Parameter | Value | Notes |
|-----------|-------|-------|
| `FREQ_HIGH` | 19000 Hz | "H" pulse |
| `FREQ_LOW` | 17500 Hz | "L" pulse |
| `FREQ_TOLERANCE` | ±100 Hz | Valid detection range (tightened) |
| `PULSE_DURATION_MS` | 80 ms | Each pulse length |
| `PULSE_GAP_MS` | 50 ms | Silence between pulses |
| `PEAK_MERGE_TIME_MS` | 50 ms | Merge window (< gap) |
| `MAX_PEAKS` | 10 | Cap for security |
| `MIC_GAIN` | 60x | Amplification |
| `FFT_SIZE` | 8192 | Frequency resolution |
| `SNR_THRESHOLD` | 2x | Signal must be 2x noise |

---

## 🧪 Test Results (Local Mode - Phone speaker → Phone mic)

**Setup:** iPhone, Local Test Mode, Brick-wall filter enabled

| Config | Pass Rate | Avg Score | Notes |
|--------|-----------|-----------|-------|
| 100% | 100% (5/5) | 6.0/6 | Perfect |
| 75% | 100% (5/5) | 6.0/6 | Perfect |
| 50% | 100% (10/10) | 6.0/6 | **Recommended** ✅ |
| 25% | 90% (9/10) | 5.8/6 | Edge of reliable range |

**Recommendation:** Use **50% volume** with output filter - best balance of accuracy and battery/speaker life.

---

## 📁 Project Structure

```
AttendanceV2/
├── src/
│   ├── audio/audioEngine.ts    # Emitter + Listener + Diagnostics
│   ├── components/
│   │   ├── AutoTestPanel.tsx   # A/B testing UI + Local mode
│   │   └── LogPanel.tsx        # UI log display
│   ├── services/firebase.ts    # Firestore + Heartbeat
│   ├── utils/
│   │   ├── logger.ts           # Global logging
│   │   └── patternUtils.ts     # Subsequence matching
│   └── views/
│       ├── TeacherView.tsx     # Session, queue, emission, presence
│       └── StudentView.tsx     # Join, listen, submit, retry
└── README.md
```

---

## 🚀 Running

```bash
npm run dev                      # Start dev server
ngrok http 5173                  # Expose to phone
firebase deploy --only firestore # Deploy rules
```

---

- [x] **Fat Firework Brutalist UI** (Modern Industrial Aesthetic)
- [x] **Passcode Room System** (Join by 6-digit code)
- [x] **Immediate Roster Join** (Global presence tracking)
- [x] **Custom Brutalist Scrollbars** (Theme-locked UI)
- [x] **View Entry Animations** (Snap-up mechanical transitions)
- [x] **Subsequence Pattern Matching** (Audio Verification)
- [x] **FFT Analysis** (~5.9Hz frequency resolution)
- [x] **Auto-Test Panel** with diagnostics
- [x] **Teacher Presence System** (Heartbeat + Cleanup)
- [x] **Response Timeout** (30s safety auto-fail & user cancel)
- [x] **Brick-Wall Output Filter** (48dB/oct @ 16.5kHz)
- [x] Cross-device testing verified (iOS / Android / Laptop)
