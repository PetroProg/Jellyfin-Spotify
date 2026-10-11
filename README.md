<div align="center">

# 🎵 Jellyfy (Jellyfin-Spotify)
### *Self-Hosted Music Streaming with Spotify Aesthetics & Catppuccin Mocha Palette*

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_18-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-000000?style=for-the-badge&logo=fastify&logoColor=white)](https://fastify.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![Jellyfin](https://img.shields.io/badge/Jellyfin_Core-00A4DC?style=for-the-badge&logo=jellyfin&logoColor=white)](https://jellyfin.org/)
[![Catppuccin](https://img.shields.io/badge/Theme-Catppuccin_Mocha-CBA6F7?style=for-the-badge)](https://catppuccin.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

</div>

---

## 🌟 Overview

**Jellyfy** is a modern, lightweight, self-hosted cloud music streaming service designed as an open-source Spotify alternative. It bridges the gap between private media storage and seamless cloud music consumption, featuring a sleek **Catppuccin Mocha** user interface, instant background playback, one-click playlist imports, and high-performance direct audio streaming.

Engineered with resource efficiency in mind, **Jellyfy** runs smoothly even on ultra-low-power home servers (such as dual-core Intel Celeron / Raspberry Pi) without CPU transcoding bottlenecks.

---

## ✨ Features

- 🎨 **Catppuccin Mocha Aesthetic**: Beautiful, distraction-free dark interface with smooth micro-interactions across desktop and mobile.
- 📱 **Installable Progressive Web App (PWA)**:
  - Add to Home Screen on iOS & Android with standalone app experience.
  - Native lock screen & notification controls via the **Web MediaSession API**.
  - Service worker background caching and instant cache invalidation upon updates.
- ⚡ **Direct Stream (Zero Transcoding)**:
  - Pure direct streaming with HTTP range requests (`Accept-Ranges: bytes`).
  - Near-zero CPU utilization — keeps your home server cool and responsive.
- 📥 **Spotify Playlist & Track Import**:
  - Automatically fetches metadata, tracklists, high-resolution cover arts, and official albums.
  - Non-blocking, low-priority background downloads (`nice -n 19`, `ionice class 3`) that prevent system stalls.
  - Intelligent resume capability for paused or interrupted jobs.
- 💖 **Liked Songs & Dynamic Playlists**:
  - Instant optimistic heart-toggles across desktop & mobile player interfaces.
  - Spotify-style playlist manager: create playlists, customize covers, and assign tracks with one click.
  - Sort tracks by title, artist, album, date added, or duration.
- 🔀 **Smart Shuffle & Recommendation Engine**:
  - Automatically enqueues context-aware artist recommendations when the playlist finishes.
  - Per-device persistent volume state and playback controls.
- 🚫 **Blacklist Management**:
  - Flag tracks with *"Never Play Again"* directly from context menus, with full overview in Settings.
- 👥 **Multi-User Support**:
  - Secure JWT-based authentication with bcrypt hashing.
  - Isolated libraries, favorites, and playlists for each user.
- 🔒 **Tailscale & Remote Access Ready**:
  - Works out of the box behind Tailscale HTTPS (`*.ts.net`) or reverse proxies (Nginx, Caddy, Traefik).

---

## 🏗️ Architecture & Tech Stack

```
┌────────────────────────────────────────────────────────┐
│                   React 18 PWA Client                   │
│   (Vite, TailwindCSS Catppuccin Mocha, Zustand, PWA)   │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTP / REST & Streaming
┌──────────────────────────▼─────────────────────────────┐
│                 Fastify Backend Service                 │
│         (Node.js 20, better-sqlite3 WAL, JWT)          │
├──────────────────────────┬─────────────────────────────┤
│   yt-dlp + ffmpeg Worker │    Spotify Web API Sync     │
│    (Throttled Nice-19)   │    (OEmbed + Metadata API)  │
└────────────┬─────────────┴──────────────┬──────────────┘
             │                            │
             ▼                            ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│      Music Storage       │  │      Jellyfin Core       │
│      (/app/music)        │  │     (Audio Library)      │
└──────────────────────────┘  └──────────────────────────┘
```

| Layer | Technologies |
|---|---|
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS, Lucide Icons, Zustand |
| **Backend** | Node.js 20, Fastify, `@fastify/jwt`, `better-sqlite3` (WAL mode) |
| **Audio & Media** | `yt-dlp`, `ffmpeg`, Native HTML5 Audio, Web MediaSession |
| **Media Server** | Jellyfin (Headless Direct Play audio backend) |
| **Containerization** | Docker, Docker Compose (Alpine-based multi-stage builds) |

---

## 🚀 Quick Start

### 1. Prerequisites
- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/)
- (Optional) [Tailscale](https://tailscale.com/) for zero-config encrypted remote access

### 2. Clone the Repository
```bash
git clone https://github.com/PetroProg/Jellyfin-Spotify.git
cd Jellyfin-Spotify
```

### 3. Docker Compose Setup

Review and adjust `docker-compose.yml` if needed:

```yaml
version: '3.8'

services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    container_name: jellyfin-audio
    restart: unless-stopped
    ports:
      - "8096:8096"
    volumes:
      - ./data/jellyfin/config:/config
      - ./data/jellyfin/cache:/cache
      - ./music:/music:ro
    environment:
      - JELLYFIN_FFmpeg__AllowTranscoding=false
    deploy:
      resources:
        limits:
          memory: 450M

  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: jellyfin-spotify-app
    restart: unless-stopped
    ports:
      - "5050:5050"
    volumes:
      - ./data:/app/data
      - ./music:/app/music
    environment:
      - NODE_ENV=production
      - PORT=5050
      - DB_PATH=/app/data/app.db
      - MUSIC_DIR=/app/music
      - JELLYFIN_URL=http://jellyfin:8096
      - JWT_SECRET=change-this-to-a-secure-random-secret
    depends_on:
      - jellyfin
    deploy:
      resources:
        limits:
          memory: 250M
```

### 4. Build and Run
```bash
docker compose up -d --build
```

The application will be accessible at:
👉 **`http://<SERVER_IP>:5050`**

---

## 🔑 Spotify Web API Integration (Optional)

Jellyfy parses public Spotify playlists **out of the box** without any API keys. 

To enable enhanced metadata lookups and official recommendations:
1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Click **Create App** (e.g. name it `Jellyfy-Music`).
3. Copy your **Client ID** and **Client Secret**.
4. In the Jellyfy web interface, open **Settings** (`Настройки`) and paste your credentials.

---

## 🔒 Remote Access via Tailscale HTTPS

To expose the web player securely over Tailscale with automated valid SSL certificates:

```bash
tailscale serve --bg --https=10443 http://127.0.0.1:5050
```

Now you can access your music player on any device in your Tailnet:
`https://<node-name>.<tailnet-domain>.ts.net:10443`

---

## 📂 Project Structure

```
Jellyfin-Spotify/
├── backend/
│   ├── src/
│   │   ├── db.ts             # SQLite schema and WAL configuration
│   │   ├── downloader.ts     # Throttled yt-dlp download queue
│   │   ├── jellyfin.ts       # Jellyfin API sync helpers
│   │   ├── spotify.ts        # Spotify API and oEmbed scraping
│   │   ├── recommendations.ts# Artist-based smart recommendations
│   │   └── index.ts          # Fastify REST endpoints & streaming
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── api/              # API HTTP client
│   │   ├── components/       # UI components (Players, Modals, Menus)
│   │   ├── pages/            # Views (Home, Playlists, Liked, Settings)
│   │   ├── store/            # Zustand player and auth stores
│   │   ├── types.ts          # TypeScript type definitions
│   │   ├── App.tsx           # Main application routing & shell
│   │   └── main.tsx
│   ├── tailwind.config.js    # Catppuccin color scheme configuration
│   ├── vite.config.ts        # Vite PWA build configuration
│   └── package.json
├── docker-compose.yml
├── Dockerfile
└── README.md
```

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">
  <sub>Crafted with ❤️ for music enthusiasts and self-hosters.</sub>
</div>
