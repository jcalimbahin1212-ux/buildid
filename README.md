# BuildID

A WebRTC-based remote-control system. A desktop app (the **host**) streams its screen and audio to a web page (the **viewer**), and the viewer's mouse/keyboard input is injected back into the host.

The website and signaling server are one Node.js service. The host is an Electron app so a single codebase works on Windows, macOS, and Linux. Any modern browser (including a Chromebook) can be a viewer.

```
┌──────────────┐   WebRTC media + input data channel   ┌──────────────┐
│  Desktop     │ ◀───────────────────────────────────▶ │  Browser     │
│  (Electron)  │                                       │  (any device)│
└──────┬───────┘                                       └──────┬───────┘
       │                                                      │
       │              Socket.IO signaling only                │
       └──────────────────►  Node.js server  ◄────────────────┘
                            (Express + Socket.IO)
```

## Features

- WebRTC peer-to-peer transport (low latency, hardware-accelerated decode)
- 6-character pairing codes with TTL + JWT-bound viewer tokens
- Audio + video capture (system loopback on supported OSes)
- Configurable framerate (30/60 fps) and bitrate (up to 12 Mbps)
- Codec preference order: H.264 → VP9 → VP8
- Unreliable, unordered data channel for lowest-latency input
- Native input injection via `@nut-tree-fork/nut-js`
- HTTPS + TURN ready

## Project layout

```
BuildID/
├── server/        # Express + Socket.IO signaling server, also serves the web viewer
│   ├── src/
│   └── public/    # The web client (vanilla JS, no build step)
├── desktop/       # Electron host app
│   ├── main.js
│   ├── preload.js
│   ├── renderer/  # WebRTC + capture UI
│   └── src/input.js
├── .env.example
└── package.json   # workspace root
```

## Setup

Requires Node.js 18+.

```powershell
cd C:\Users\Predator\Desktop\BuildID
copy .env.example .env
npm install
```

Edit `.env` and at minimum set a long random `SESSION_SECRET`.

## Run

In two terminals:

```powershell
# Terminal 1 — signaling server + website
npm run server
```

Open http://localhost:8080 in any browser (this is the viewer).

```powershell
# Terminal 2 — desktop host (the machine to be controlled)
npm run desktop
```

The host window shows a 6-character code. Enter that code on the website and click **Connect**. The viewer screen will display the host's desktop and forward mouse/keyboard input.

## Production deployment notes

- **TLS is required** for `getUserMedia` on the viewer when accessed over the internet. Set `TLS_CERT` and `TLS_KEY` in `.env`, or place the server behind a reverse proxy that terminates TLS (recommended: nginx / Caddy).
- **TURN server is required** for connections crossing strict NATs. Add a TURN entry to `ICE_SERVERS` in `.env`. coturn is the standard self-hosted option.
- **Native modules**: `@nut-tree-fork/nut-js` uses prebuilt binaries; if you package the host with `electron-builder`, run `npm run rebuild` first.
- **Linux audio capture** typically requires PulseAudio/PipeWire loopback configuration. Wayland may require `xdg-desktop-portal` for screen capture.
- **macOS** asks for Screen Recording and Accessibility permissions on first capture/input.

## Security model

- The signaling server only relays SDP and ICE; it never sees media or input.
- Link codes expire (default 10 min) and are bound to a JWT issued at claim time.
- Only one viewer may attach to a code at a time; the host can rotate the code at any time.
- All input is gated behind the **Send input** toggle in the viewer UI.
- Helmet sets a strict CSP. Tighten `script-src` further with a nonce in production if you modify the client.

## Known limitations / next steps

- No persistent accounts. Add a user/auth layer (e.g. OAuth) before exposing this publicly.
- IME / non-Latin keyboard input falls back to single-character mapping; full IME would need a text-input data channel.
- Multi-monitor: only the chosen source's display is mapped for input. Selecting a window source maps input to the display the window lives on at start time.
- Clipboard sync, file transfer, and gamepad input are not yet implemented.
