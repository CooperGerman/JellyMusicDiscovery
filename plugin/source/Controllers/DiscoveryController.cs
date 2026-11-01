using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using JellyMusicDiscovery.Services;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace JellyMusicDiscovery.Controllers;

/// <summary>
/// /mdiscover/* — discovery actions invoked by the web overlay JS.
/// </summary>
[ApiController]
[Route("mdiscover")]
[Authorize]
public class DiscoveryController : ControllerBase
{
    private readonly DiscoveryManager _discovery;
    private readonly DeezerClient _deezer;
    private readonly LidarrClient _lidarr;
    private readonly ILibraryManager _library;
    private readonly DiscoveryItemCache _cache;
    private readonly ILogger<DiscoveryController> _log;

    public DiscoveryController(
        DiscoveryManager discovery,
        DeezerClient deezer,
        LidarrClient lidarr,
        ILibraryManager library,
        DiscoveryItemCache cache,
        ILogger<DiscoveryController> log)
    {
        _discovery = discovery;
        _deezer = deezer;
        _lidarr = lidarr;
        _library = library;
        _cache = cache;
        _log = log;
    }

    /// <summary>
    /// POST /mdiscover/request/album/{itemId}
    /// Requests an album stub via Lidarr. Routes by available provider IDs:
    ///   - MBID present → use the MB-MBID lookup path
    ///   - DeezerAlbum present → use the artist+album text lookup path
    ///   - neither → fall back to the item's Name + Artists
    /// </summary>
    [HttpPost("request/album/{itemId}")]
    public async Task<IActionResult> RequestAlbum(string itemId, CancellationToken ct)
    {
        if (!Guid.TryParse(itemId, out var id)) return BadRequest("invalid id");

        // Discovery track requests use Lidarr's album-sized request model.
        if (_cache.TryGet(id, out var entry) && entry is not null)
        {
            if (entry.Kind == "album" || entry.Kind == "track")
            {
                if (string.IsNullOrWhiteSpace(entry.Artist) || string.IsNullOrWhiteSpace(entry.AlbumName))
                    return BadRequest(new { Message = "This result has no album metadata to request." });

                var result = await _lidarr.AddAlbumByTextAsync(entry.Artist, entry.AlbumName, ct).ConfigureAwait(false);
                if (result.Success) _lidarr.InvalidateAlbumStatus(entry.Artist, entry.AlbumName);
                return result.Success ? Ok(new { result.Message }) : StatusCode(502, new { result.Message });
            }
        }

        // Try the live library for real albums.
        var item = _library.GetItemById(id);
        if (item is not null)
        {
            var albumItem = item as MusicAlbum;
            var artistName = albumItem?.AlbumArtists?.FirstOrDefault() ?? albumItem?.Artists?.FirstOrDefault() ?? string.Empty;
            var albumName = item.Name ?? string.Empty;
            var mbid = item.GetProviderId(ProviderIds.MusicBrainzReleaseGroup);
            LidarrClient.RequestResult res;

            if (!string.IsNullOrEmpty(mbid))
                res = await _lidarr.AddAlbumByMbidAsync(mbid, ct).ConfigureAwait(false);
            else
            {
                res = await _lidarr.AddAlbumByTextAsync(artistName, albumName, ct).ConfigureAwait(false);
            }

            if (res.Success) _lidarr.InvalidateAlbumStatus(artistName, albumName);
            return res.Success ? Ok(new { res.Message }) : StatusCode(502, new { res.Message });
        }

        return NotFound("Unknown item id (not in library or recent search cache).");
    }

    /// <summary>POST /mdiscover/request/artist/{itemId} adds and monitors the full artist discography in Lidarr.</summary>
    [HttpPost("request/artist/{itemId}")]
    public async Task<IActionResult> RequestArtist(string itemId, CancellationToken ct)
    {
        if (!Guid.TryParse(itemId, out var id)) return BadRequest("invalid id");
        if (!_cache.TryGet(id, out var entry) || entry is not { Kind: "artist" } || string.IsNullOrWhiteSpace(entry.Artist))
            return NotFound("Unknown discovery artist.");

        var result = await _lidarr.AddArtistByNameAsync(entry.Artist, ct).ConfigureAwait(false);
        if (result.Success) _lidarr.InvalidateArtistStatus(entry.Artist);
        return result.Success ? Ok(new { result.Message }) : StatusCode(502, new { result.Message });
    }

    /// <summary>POST /mdiscover/lidarr/status — batch Lidarr match/monitor state for discovery cards.</summary>
    [HttpPost("lidarr/status")]
    public async Task<IActionResult> LidarrStatus([FromBody] Guid[]? itemIds, CancellationToken ct)
    {
        if (itemIds is null || itemIds.Length == 0) return Ok(new { items = Array.Empty<object>() });
        if (itemIds.Length > 50) return BadRequest("At most 50 discovery items may be checked at once.");

        var statuses = await Task.WhenAll(itemIds.Distinct().Select(async id =>
        {
            LidarrItemStatus status;
            if (!_cache.TryGet(id, out var entry) || entry is null)
            {
                status = LidarrItemStatus.NoMatch;
            }
            else if (entry.Kind == "artist" && !string.IsNullOrWhiteSpace(entry.Artist))
            {
                status = await _lidarr.GetArtistStatusAsync(entry.Artist, ct).ConfigureAwait(false);
            }
            else if ((entry.Kind == "album" || entry.Kind == "track")
                && !string.IsNullOrWhiteSpace(entry.Artist)
                && !string.IsNullOrWhiteSpace(entry.AlbumName))
            {
                status = await _lidarr.GetAlbumStatusAsync(entry.Artist, entry.AlbumName, ct).ConfigureAwait(false);
            }
            else
            {
                status = LidarrItemStatus.NoMatch;
            }

            return new { id = id.ToString("N"), status };
        })).ConfigureAwait(false);

        return Ok(new { items = statuses });
    }

    /// <summary>GET /mdiscover/album/{itemId}/tracks — lazy-materialize track stubs for a Deezer album stub.</summary>
    [HttpGet("album/{itemId}/tracks")]
    public async Task<IActionResult> AlbumTracks(string itemId, CancellationToken ct)
    {
        if (!Guid.TryParse(itemId, out var id)) return BadRequest("invalid id");
        if (_library.GetItemById(id) is not MusicAlbum album) return NotFound();

        // Deezer path: pull the actual tracklist from Deezer and materialize each.
        var dzAlbumId = album.GetProviderId(ProviderIds.DeezerAlbum);
        if (!string.IsNullOrEmpty(dzAlbumId) && long.TryParse(dzAlbumId, out var dzId))
        {
            var tracks = await _deezer.GetAlbumTracksAsync(dzId, ct).ConfigureAwait(false);
            if (tracks is null) return Ok(new { count = 0, items = Array.Empty<object>() });
            var stubs = tracks.Data
                .Select(t => _discovery.EnsureTrackStubFromDeezer(t, album, ct))
                .Select(t => new
                {
                    id = t.Id.ToString("N"),
                    name = t.Name,
                    runTimeTicks = t.RunTimeTicks,
                })
                .ToArray();
            return Ok(new { count = stubs.Length, items = stubs });
        }

        // MB path is the original behaviour, kept for `SearchSource = musicbrainz`.
        return Ok(new { count = 0, items = Array.Empty<object>() });
    }

    /// <summary>GET /mdiscover/health — sanity check.</summary>
    [HttpGet("health")]
    [AllowAnonymous]
    public IActionResult Health() => Ok(new
    {
        ok = true,
        plugin = Plugin.Instance?.Name,
        version = "0.1.0",
        searchSource = Plugin.Instance?.Configuration?.SearchSource,
    });
}
