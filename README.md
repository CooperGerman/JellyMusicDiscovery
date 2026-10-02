<div align="center">
  <img src="assets/logo.svg" alt="JellyMusicDiscovery" width="180"/>
</div>

# JellyMusicDiscovery

A Jellyfin server plugin for discovering music outside your library. It adds
search results and playlists from public music catalogs, plus lyrics for
discovery tracks. Install it once on the server; clients need no separate
plugin. YouTube Music playback and videos use a separate optional service.

<div align="center">
  <a href="https://buymeacoffee.com/drgit_stone" target="_blank">
    <img src=".github/BuyMeACoffee.png" alt="JellyMusicDiscovery" width="180"/>
  </a>
</div>

---
## Install in a minute

1. In Jellyfin, open **Dashboard → Plugins → Repositories** and add:

   `https://raw.githubusercontent.com/CooperGerman/JellyMusicDiscovery/main/manifest.json`

2. Open the **Catalog**, install **Music Discovery**, then restart Jellyfin
   if prompted.
3. Refresh the web app.

The catalog installs only the Jellyfin plugin. The YouTube companion and
download integrations are separate; see below for setup and test status.

## What this plugin and its companions do

The plugin runs on the Jellyfin server. Feature requirements are listed
below; optional companions are not installed by the catalog.

### 1. Discovery search — find music you don't currently have in your library
Type anything into Jellyfin's search bar. Alongside the tracks already
in your library, you'll see hits from **Deezer**, **iTunes
Search API**, and **MusicBrainz**. They're labeled visually so you know
they're not in your library yet.
- **Needs:** nothing extra. Built into the plugin itself, queries
  public/no-auth APIs at search time.


### 2. Play any music — even music you don't currently have in your library
Hit Play on a discovery result and it plays instantly, with no
download wait. Under the hood:
- The plugin redirects the player to `ytmusic-stream-server`, which
  uses **`yt-dlp`** (the youtube-dl successor) to find the matching
  track on YouTube Music, extract a direct audio CDN URL, and 302 the
  player there.
- iTunes/Deezer/MusicBrainz are *only used for finding the track exists*
  — once found, the audio stream is always sourced from YouTube Music.
  This is why no iTunes/Deezer accounts are needed.
- **Needs:** `ytmusic-stream-server` running (Docker container in this
  bundle) + `YtMusicStreamServerUrl` set in the plugin's settings.

### 3. Music videos — auto-populated per artist
Search for any artist in Jellyfin and scroll down to the **Videos** section, this will fill up with
that artist's music videos. Click one and it plays in Jellyfin's video
player, full screen if you want.
- The plugin's search/detail filters call
  `ytmusic-stream-server`'s `/search/videos?artist=` endpoint.
- The server uses `ytmusicapi` to find music videos and `yt-dlp` to
  resolve direct DASH (H.264 ≤1080p) + AAC streams; `ffmpeg` muxes
  them into a single playable mp4 on the fly.
- The plugin registers a synthetic `MusicVideo` library item per
  result so it shows up in the artist's Videos tab natively.
- **Needs:** same as feature 2 — `ytmusic-stream-server` + the URL set.
- **Scope:** music videos only. Not general video, not movies/TV ,
(Gelato and Jellyfin already do that).

### 4. Discovery playlists — auto-generated, three sources
Jellyfin's playlists feed gets new dynamic sections injected the moment
the plugin loads. There's nothing static to "import" — the plugin
fetches them live and refreshes periodically. Three sources:

**Deezer charts (8 playlists, no setup):**
🇺🇸 Top 50 USA · 🔥 Top 100 Global · 🎸 Top Rock · 🎤 Top Pop ·
🎧 Top Electronic · 🎵 Top Hip-Hop · 🤘 Top Metal · 🆕 New Releases.
Public Deezer chart APIs, no auth. Tracks *display* immediately; they
*play* only with `ytmusic-stream-server` (since audio comes from YT
Music, not Deezer — Deezer's only used for the catalog metadata).

**YouTube Music charts (12 playlists):**
- YT 🏋️ Workout · YT 🎉 Party · YT 🚗 Commute · YT ⚡ Energy
  Boosters · YT 😊 Feel Good *(mood-based — pulled from YT Music's
  mood categories)*
- YT 🎤 Hot Hits Pop · YT 🎸 Hot Hits Rock · YT 🖤 Hot Hits Emo ·
  YT 🎧 Hot Hits Electronic *(YT Music's weekly-updated "Hot Hits"
  curated playlists)*
- YT 💭 Forgotten Favorites · YT 🆕 New Releases · YT 🇯🇵 J-Pop
  *(broad search-backed playlists)*

Visible AND playable only when `ytmusic-stream-server` is configured;
without it the plugin silently omits these sections. Track lists
update on a TTL refresh — typically a few hours — so you'll see
fresh content periodically.

**📻 Internet radio (6 playlists, no setup):**
*Top US Stations · iHeartRadio · Hip-Hop / R&B · Pop / Top 40 · Rock ·
News & Talk*. Each station resolves to a direct stream URL
(mp3/aac/ogg) from radio-browser.info — the Jellyfin player connects
to that URL directly. Doesn't go through `ytmusic-stream-server` at
all, and works with zero additional setup. A `BlockedRadioStations`
config setting drops stations by substring match.

**TL;DR:** Install the plugin alone → 14 playlists appear immediately
(8 Deezer + 6 radio). The 6 radio playlists play right away; the 8
Deezer playlists need `ytmusic-stream-server` to be playable. Add
`ytmusic-stream-server` and you also get **12 YouTube Music playlists**
on top, for **26 total discovery playlists** auto-injected into your
Jellyfin home screen.

### 5. Synced lyrics for discovery tracks (built-in)
Click play on a discovery hit and the player UI shows **karaoke-style
synced lyrics** if `lrclib.net` has them — same source the popular
"LrcLib" Jellyfin plugin uses, but called directly so it works for
tracks that aren't in your library yet (Jellyfin's normal lyrics
pipeline only fires for real library items).

- **Built-in** — no extra container, no config. Queries lrclib.net
  anonymously, caches results in memory, falls back to plain (un-
  timestamped) lyrics if synced isn't available, 404s silently if
  neither exists.
- **No `.lrc` files written to disk.** Lyrics are served on the fly
  via Jellyfin's `/Audio/{id}/Lyrics` route.
- **Recommended companion for real library tracks:** install the
  standalone [LrcLib Jellyfin plugin](https://github.com/jellyfin/jellyfin-plugin-lrclib)
  too. This plugin handles lyrics for *discovery stubs*; the LrcLib
  plugin handles them for tracks already in your library. They
  coexist cleanly — different code paths, no conflict.

### 6. Optional downloads
The fork contains optional Lidarr/Soulseek integration code. It is not
required for core discovery or YouTube streaming; see the test-status note
below before enabling it.
## Optional: YouTube Music playback and videos

`ytmusic-stream-server` is a separate Docker service. It enables playback for
non-library discovery tracks, YouTube Music playlists, and music videos; it is
not installed by the Jellyfin catalog.

1. Start the companion service:

   ```bash
   cd ytmusic-stream-server
   docker compose up -d --build
   ```

2. In **Dashboard → Plugins → Music Discovery → Settings**, set **YT Music
   Stream Server URL** to an address reachable by the browser, for example
   `http://media-server:8077`.
3. Save and refresh Jellyfin.

The companion allows the default Jellyfin origin `http://media-server:8096`.
If you open Jellyfin through a different hostname or IP, set `CORS_ORIGINS`
in the companion's Compose environment to the browser-facing Jellyfin origin
or comma-separated list of origins, then recreate the service. See
[`ytmusic-stream-server/README.md`](ytmusic-stream-server/README.md).

Without this companion, discovery results still appear, but non-library
streaming, music videos, and YouTube Music playlists are unavailable.

---

## Requirements & compatibility

### Jellyfin
- **Server version: 12.1.x.** The plugin's `meta.json` declares
  `targetAbi=12.1.0.0` and the source is built against the
  `Jellyfin.Common/Controller/Model 12.1.0` packages. It will load on
  Jellyfin 12.1.x; older server ABIs require a separate build. The source
  targets .NET 10.0, as required by the Jellyfin 12.1 assemblies.
- **No special Jellyfin server config needed.** No external auth, no
  reverse-proxy gymnastics.
- **No extra Jellyfin plugins required.** Specifically: you do **not**
  need the iTunes Music plugin, the MusicBrainz metadata plugin, or
  any other discovery plugin installed alongside this one.

### Optional integrations and test status

`ytmusic-stream-server` requires Docker and internet access. No YouTube
account is required; it uses yt-dlp against public YouTube endpoints.

The optional Lidarr/Soularr/slskd/organizer download chain has **not been
tested end-to-end in this fork**. Its setup is documented in the
[original JellyMusicDiscovery repository](https://github.com/DrGitStone/JellyMusicDiscovery).

## What's in this bundle

```
JellyMusicDiscovery-v0.1.8.0/
├── README.md                       ← you are here (architecture + full stack)
├── Makefile                        ← root build/package entry point
├── manifest.json                   ← Jellyfin plugin-catalog manifest
├── plugin/
│   ├── JellyMusicDiscovery.zip     ← drop-in plugin (unzip into Jellyfin plugins dir)
│   ├── meta.json                   ← plugin metadata (version, GUID, ABI target)
│   ├── INSTALL.md                  ← step-by-step plugin install
│   └── source/                     ← full C# source
├── scripts/
│   └── package_plugin.py           ← assembles ZIP and refreshes manifest checksum
├── slskd-organizer/                ← optional download helper (not tested here)
│                                     into {Artist}/{Album}/{NN - Title}.{ext}
├── ytmusic-stream-server/          ← FastAPI service that streams YouTube Music
│                                     to Jellyfin for instant playback
└── patches/
    └── soularr-version-check.diff  ← optional Soularr compatibility reference
```

## Feature requirements

| Feature | Companion required? |
|---|---|
| Search discovery (Deezer, iTunes, MusicBrainz) | No |
| Internet radio and discovery playlists | No; Deezer tracks need the YouTube companion to play |
| Synced lyrics for discovery tracks | No |
| YouTube Music track playback, music videos, YouTube playlists | Yes: `ytmusic-stream-server` |
| Lidarr/Soularr/slskd auto-download | Optional; not tested in this fork. See the original repo above. |

The YouTube companion's [README](ytmusic-stream-server/README.md) covers its
Docker setup and troubleshooting. Set its URL in the plugin settings to an
address reachable by the client browser, not only by the Jellyfin container.

## Building from source

The plugin requires the .NET 10 SDK. From the repository root, run:

```bash
make package
# builds Release, updates plugin/artifacts/JellyMusicDiscovery.zip,
# refreshes plugin/JellyMusicDiscovery.zip, and updates manifest checksum/timestamp
```

The `csproj` has a `StripUnneededDlls` target that deletes the
Jellyfin/Microsoft/System DLLs Jellyfin already provides at runtime, so
the zip stays small (~310 KB). `TagLibSharp.dll` *is* shipped because
Jellyfin doesn't bundle it. Before a new release, update the plugin version
and add human-written bullet items to that version's `changelog` string in
`manifest.json`; `make package` preserves the changelog while refreshing its
checksum and timestamp.

## License / attribution

Self-hosted, no warranty, etc. Some files in this stack are derivative of
or interact with third-party projects:

- [Jellyfin](https://jellyfin.org) — GPLv2
- [Lidarr](https://lidarr.audio) — GPLv3
- [Soularr](https://github.com/mrusse/soularr) — patches in `patches/`
- [slskd](https://github.com/slskd/slskd) — AGPLv3
- [TagLibSharp](https://github.com/mono/taglib-sharp) — LGPLv2.1 (shipped
  in the plugin zip per its license terms)
- [ytmusicapi](https://github.com/sigma67/ytmusicapi) — MIT
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — Unlicense
