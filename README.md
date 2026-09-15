# ChalyOBS

Engine de transmisión móvil para Chalyb — pareja un DJI Osmo Pocket 3 con un teléfono para hacer multistreaming a Kick / Twitch / YouTube / TikTok / Restream con chat unificado y control de permisos. Vive junto a ChalyClip dentro del registry de engines de Chalyb.

Roles cooperativos:
- **Camera Operator Mode** (Android): UVC preview of the Osmo, real-time chat overlay, stream-health display, optional stream-start permission.
- **Streamer Mode** (iOS or Android): remote preview, cross-platform chat with reply, profile + destination + permission management.

Built on **Expo SDK 54** / **React Native 0.81** / **TypeScript** with file-based routing via Expo Router. Auth + profile are sourced from the Chalyb Supabase project.

---

## Phases

| Phase | Where it runs | What's in it |
|---|---|---|
| **0** | Stock **Expo Go** on iOS + Android | Auth, profiles, role selector, full UI shell, real Kick chat (read), permission system, mock backend |
| **0.5** | Stock Expo Go | Kick OAuth 2.1 PKCE flow for sending chat messages |
| **1** | **Dev build** via EAS, iOS + Android | Real RTMP from phone camera (RootEncoder on Android, HaishinKit on iOS), secure stream-key vault, reconnect-on-drop, audio source select, local recording |
| **1.5** | Dev build, Android | `chalyb-usb-probe` diagnostic module — dumps Osmo's USB descriptors so the frame pump targets the actual endpoint shape |
| **2** | Dev build, **Android only** | Custom UVC integration for Osmo Pocket 3 via `CameraSource` interface; hot-swap source without restarting stream |
| **3** | Dev build, both | WebRTC low-latency remote preview between operator and streamer |

## Stack

| Layer | Choice | Why |
|---|---|---|
| App framework | Expo SDK 55 (managed) | One codebase, EAS Build, dev client + Expo Go support |
| Routing | Expo Router (file-based) | Tabs + nested groups for role-specific layouts |
| Language | TypeScript strict + `noUncheckedIndexedAccess` | — |
| Styling | StyleSheet + theme palette | No extra dep |
| State | React Context + `useReducer` slices | Zero deps; mirrors backend contract |
| Chat (base) | Kick via Pusher WebSocket | No auth needed for read; OAuth for send |
| Camera (Phase 0) | `expo-camera` | Phone-cam fallback that also works in Expo Go |
| Camera (Phase 2) | Local Expo module wrapping Android `UsbManager` + UVC pump | Built from scratch on confirmed endpoint shape |
| RTMP Android | RootEncoder (`pedroSG94/RootEncoder`) | Most actively maintained; has UVC ingest path for Phase 2 |
| RTMP iOS | HaishinKit.swift | Most actively maintained; matches RootEncoder feature set |
| Secrets | `expo-secure-store` | Keychain / Keystore in dev build |

## Quick start (Phase 0 — Expo Go)

```bash
npm install
npm run start:go     # stock Expo Go path (no native modules)
```

Scan the QR with **Expo Go** on your iPhone or Samsung S22 Ultra. Edit any `.tsx` and the app hot-reloads on the device.

## Google OAuth setup (one-time, Supabase dashboard)

ChalyOBS signs in via the Chalyb Supabase project. For the "Continuar con Google" button to bounce back to the app after sign-in, the runtime redirect URI must be in the project's redirect-URL allowlist.

1. Open https://supabase.com/dashboard/project/uqcbziwdgbnzehipzjxp/auth/url-configuration
2. Under **Redirect URLs**, add (one per line, wildcards allowed):
   - `chalybobs://**` — dev client + standalone builds
   - `exp://**` — Expo Go (the host:port part changes per LAN session)
3. Save.

The Diagnostics screen (⚙ icon → APLICACIÓN section → `oauth redirect`) shows the exact URI for the current runtime so you can verify the format matches what's in the allowlist.

## Dev build (Phase 1+ — required for RTMP / UVC)

```bash
npm install -g eas-cli
eas login

# Android dev client APK (~10 min in EAS free tier)
eas build --profile development --platform android

# iOS dev client (internal distribution; needs Apple Developer account)
eas build --profile development --platform ios
```

Install the resulting APK / IPA on your phone, open it, then:

```bash
npm start          # connects to the dev client (not Expo Go)
```

You only rebuild the dev client when native code changes (additions to `modules/*` or `app.json` plugins). JS edits hot-reload as usual.

### What lights up in the dev client (Phase 1+)

- `modules/chalyb-streaming` (Android, RootEncoder) — `streaming.start({ url, streamKey, ... })` opens Camera2, encodes H.264 + AAC via MediaCodec, publishes to RTMP. **Scaffolded** (module compiles + registers) in Phase 1.A; broadcast wiring lands in Phase 1.B.
- `modules/chalyb-uvc-camera` (Android only) — Osmo Pocket 3 USB-C UVC capture via raw `UsbManager`. Comes online in Phase 2.

In Expo Go (Phase 0) both modules are stubbed; the JS side reads `streaming.available === false` and the UI shows a "dev build required" banner instead of crashing.

## Project layout

```
app/                         Expo Router file-based routes
  _layout.tsx                  Root: theme + state providers + auth gate
  index.tsx                    Role/profile resolver
  auth/                        Login + profile picker
  lobby.tsx                    "I'm streamer" vs "I'm operator"
  (streamer)/                  Streamer-only screens
  (operator)/                  Operator-only screens
  diagnostics.tsx              Build info + runtime env + permission status

src/
  modules/                     Business logic (auth / profiles / camera /
                               streaming / chat / remote-preview /
                               permissions / settings / diagnostics)
  backend/                     BackendClient interface + mock impl
  chat/                        ChatProvider interface + per-platform impls
  ui/                          Components, theme, icons
  store/                       Auth + session + permissions slices

modules/                     Local Expo native modules (Phase 1+)
  chalyb-streaming/              RTMP broadcaster (iOS + Android)
  chalyb-uvc-camera/             UVC capture (Android only)
  chalyb-usb-probe/              Phase-1.5 diagnostic (descriptor dump)
```

## Feature matrix by platform

| Feature | Expo Go iOS | Expo Go Android | Dev client iOS | Dev client Android |
|---|---|---|---|---|
| Auth + profiles + UI | ✓ | ✓ | ✓ | ✓ |
| Kick chat (read) | ✓ | ✓ | ✓ | ✓ |
| Kick chat (send, OAuth) | ✓ | ✓ | ✓ | ✓ |
| Permission system | ✓ | ✓ | ✓ | ✓ |
| Phone camera preview | ✓ | ✓ | ✓ | ✓ |
| **RTMP broadcast** | — | — | ✓ | ✓ |
| **Osmo Pocket 3 (USB UVC)** | — (Apple platform limit) | — | — | ✓ |
| WebRTC remote preview | — | — | ✓ | ✓ |
| Local recording | — | — | ✓ | ✓ |

## License

Private. © Chalyb.
