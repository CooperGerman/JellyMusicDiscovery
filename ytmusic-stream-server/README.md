# ytmusic-stream-server

Tiny FastAPI service that bridges Jellyfin Music Discovery to YouTube Music
for on-demand audio streaming.

Runs on port `8077` by default.

## Endpoints

- `GET /health` — sanity check
- `GET /search?artist=X&title=Y` — best YT Music match (videoId, title, artist, etc.)
- `GET /stream?artist=X&title=Y` — 302 redirect to a direct audio URL
- `GET /stream/by-video/{videoId}` — 302 redirect for a known videoId

## Deploy on the Pi (Portainer)

Either:
- Add a stack in Portainer that points at this `docker-compose.yml`, or
- Build & run via SSH:

```bash
cd /portainer/Files/AppData/Stacks/ytmusic-stream-server
docker compose up -d --build
```

## Plugin config

Set `YtMusicStreamServerUrl` to `http://<pi>:8077` in the Music Discovery
plugin config page. The stream service allows the default Jellyfin browser
origin `http://media-server:8096`. If Jellyfin is opened using a different
LAN hostname or IP, set `CORS_ORIGINS` on this service to a comma-separated
list of the browser-facing Jellyfin origins, for example:

```yaml
environment:
	CORS_ORIGINS: http://192.168.1.20:8096,http://media-server:8096
```
