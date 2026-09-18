# Intelligent Gmail Attention Manager

[![Privacy](https://img.shields.io/badge/privacy-100%25%20local--only-blue.svg)](https://github.com/vasurnjn/gmail-extension)
[![Manifest V3](https://img.shields.io/badge/chrome%20extension-MV3-orange.svg)](https://github.com/vasurnjn/gmail-extension)
[![Gmail API](https://img.shields.io/badge/gmail%20scope-read--only-green.svg)](https://github.com/vasurnjn/gmail-extension)
[![License](https://img.shields.io/badge/license-ISC-lightgrey.svg)](LICENSE)

An intelligent, privacy-first, on-device Chrome extension built to cut through institutional email overload and guarantee that critical career placement drives, exam deadlines, scheduled meetings, and actionable academic notices are never missed.

Designed for university students, researchers, and professionals who receive high volumes of emails daily and need deterministic, explainable alerts for what truly matters.

---

## Key Features

- **100% Local-Only Intelligence**: All email parsing, categorization, importance/urgency scoring, temporal extraction, change detection, and proximity scheduling run purely inside your browser. Zero external AI/ML APIs, zero third-party servers, and zero telemetry.
- **Strictly Read-Only Gmail Access**: Exclusively requests `https://www.googleapis.com/auth/gmail.readonly`. The extension never requests write, send, delete, or modify permissions. All user-attention decisions (`handled`, `snoozed`, `dismissed`) remain strictly local.
- **AttentionItem Architecture**: Decouples physical incoming emails from ongoing attention milestones. Multiple updates or repeated follow-ups for the same event/recruitment link into a single canonical Attention Item with persistent lifecycle tracking.
- **Explainable Milestone Scoring**: Computes deterministic Importance (0–100) and Urgency (0–100) scores using named milestone weights and domain heuristics.
- **Deep Temporal & Event Understanding**: Identifies deadlines, event windows, physical venues, and relative times with confidence tiers (`HIGH`, `MEDIUM`, `LOW`). Suppresses rigid alarms for ambiguous dates.
- **Change & Repetition Intelligence**: Differentiates incoming communications into `NEW`, `REPEAT`, `UPDATE`, `CONFLICT`, and `CANCELLED`.
- **Multi-Stage Proximity Reminders**: Automatically registers local Chrome alarms for `48h`, `24h`, `3h`, and `30m` prior to critical events and deadlines.
- **Dynamic Desktop Notifications**: Rich notifications feature descriptive titles and messages detailing the canonical entity, specific action, exact time, and venue, with quick action buttons (`Mark Handled`, `Snooze 1h`, `Dismiss`).
- **Bulk Actions**: Quick "Mark all as handled" option with inline safety confirmation.
- **Multi-Account Switching**: Seamlessly switch between Google accounts with isolated storage and persistent attention state.
- **Adaptive UI**: Clean Preact Side Panel and Popup interfaces with native Dark, Light, and System themes.

---

## Architecture Overview

```
[ Gmail API (read-only) ]
         │ (Incremental Sync via History API & Safety Sweeps)
         ▼
[ Local Message Parser ] ──▶ Body Text Truncation & RFC 822 Header Sanitizer
         │
         ▼
[ Deterministic Classifier ] ──▶ Keyword, Regex, Multi-Category Evidence Scoring
         │
         ▼
[ Importance & Urgency Scorers ] ──▶ Weighted Milestone Overrides (0-100)
         │
         ▼
[ Temporal & Venue Analyzer ] ──▶ Scoped Anchor Resolution & Truthful Time Precision
         │
         ▼
[ Entity & Change Engine ] ──▶ NEW / REPEAT / UPDATE / CONFLICT / CANCELLED
         │
         ▼
[ Attention Item State Machine ] ──▶ UserAttentionState: unhandled | snoozed | handled | dismissed
         │
         ├──▶ [ Proximity Scheduler ] ──▶ 48h / 24h / 3h / 30m / Snooze Expiration
         │           │
         │           ▼
         │      [ Chrome Alarms & Dexie scheduledAlarms ]
         │
         └──▶ [ Attention Eligibility & Severity Model ] ──▶ critical | high | standard | silent
                     │
                     ▼
                [ Chrome Rich Notifications ] ──▶ [Mark Handled] [Snooze 1h]
```

---

## Local Storage Schema

The extension utilizes **Dexie.js** (IndexedDB) for high-performance, structured local querying:

| Table | Purpose |
|---|---|
| `emails` | Indexed local records of recent emails with classification results, temporal analysis, and attention scores. |
| `attentionItems` | Authoritative record of attention tasks, canonical entity links, lifecycle state, user attention state, and delivery keys. |
| `scheduledAlarms` | Active proximity and snooze alarms synchronized with the Chrome Alarms API. |
| `senders` | Local sender interaction metrics and reputation profiles. |
| `userFeedback` | Audit trail of user interactions (`handled`, `snoozed`, `dismissed`) for local adaptation. |
| `categoryWeights` | User-configured category priority multipliers. |

---

## Security & Permissions

| Permission | Justification |
|---|---|
| `storage` | Stores extension configuration, theme, and account-scoped attention history locally. |
| `alarms` | Triggers timely proximity reminders and background safety reconciliation checks. |
| `notifications` | Displays native desktop notifications for high-priority events. |
| `identity` | Secure OAuth 2.0 authorization using Google Identity Services. |
| `sidePanel` | Provides a side-by-side dashboard in Chrome for reviewing the Attention Queue while working. |
| `host_permissions` (`https://gmail.googleapis.com/*`) | Fetches message headers, snippets, and history records via official Google REST endpoints. |

---

## Getting Started

### Prerequisites
- Node.js 18+ and npm
- Google Chrome (v116+ recommended for Side Panel support)

### Installation & Build

1. Clone the repository:
   ```bash
   git clone https://github.com/vasurnjn/gmail-extension.git
   cd gmail-extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run tests:
   ```bash
   npm test
   ```

4. Verify TypeScript:
   ```bash
   npm run typecheck
   ```

5. Build the extension:
   ```bash
   npm run build
   ```
   The compiled unpacked extension is output to the `dist/` directory.

### Loading into Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `dist/` folder in the project root.
4. Pin the **Attention Manager** icon in your browser toolbar.
5. Click the extension icon to open the popup, or open the Chrome Side Panel to connect your Google account.

---

## License

This project is licensed under the [ISC License](LICENSE).
