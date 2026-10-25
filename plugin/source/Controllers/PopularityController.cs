using System;
using System.Collections.Generic;
using System.Linq;
using JellyMusicDiscovery.Services;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace JellyMusicDiscovery.Controllers;

[ApiController]
[Authorize]
[Route("mdiscover/popularity")]
public sealed class PopularityController : ControllerBase
{
    private const int MaxBatchSize = 500;
    private const string UserIdClaim = "Jellyfin-UserId";

    private readonly ILibraryManager _library;
    private readonly IUserManager _userManager;
    private readonly PopularityRankIndex _index;

    public PopularityController(ILibraryManager library, IUserManager userManager, PopularityRankIndex index)
    {
        _library = library;
        _userManager = userManager;
        _index = index;
    }

    [HttpGet("status")]
    public ActionResult<PopularityProviderStatus> GetStatus()
    {
        var version = typeof(PopularityController).Assembly.GetName().Version?.ToString(4) ?? "0.0.0.0";
        return Ok(new PopularityProviderStatus(version, _index.TrackCount));
    }

    [HttpGet]
    public ActionResult<PopularityBatchResponse> Get([FromQuery] Guid[] itemIds)
    {
        if (itemIds is null || itemIds.Length == 0) return Ok(new PopularityBatchResponse(new Dictionary<string, PopularityScore>(), _index.TrackCount));
        if (itemIds.Length > MaxBatchSize) return BadRequest($"At most {MaxBatchSize} item IDs may be requested.");

        var userIdValue = User.Claims.FirstOrDefault(claim => string.Equals(claim.Type, UserIdClaim, StringComparison.OrdinalIgnoreCase))?.Value;
        if (!Guid.TryParse(userIdValue, out var userId)) return Unauthorized();

        var scores = new Dictionary<string, PopularityScore>(StringComparer.OrdinalIgnoreCase);
        foreach (var itemId in itemIds.Distinct())
        {
            if (_library.GetItemById<Audio>(itemId, userId) is null) continue;
            if (_index.GetTrack(itemId) is not { } rank) continue;
            scores[itemId.ToString("N")] = new PopularityScore(rank.Rank, rank.UpdatedUtc, rank.MatchMethod);
        }

        return Ok(new PopularityBatchResponse(scores, _index.TrackCount));
    }

    [HttpGet("artist")]
    public ActionResult<ArtistPopularityResponse> GetArtistTracks([FromQuery] string artist, [FromQuery] int limit = 50)
    {
        if (string.IsNullOrWhiteSpace(artist)) return BadRequest("An artist name is required.");
        if (!TryGetAuthenticatedUserId(out var userId)) return Unauthorized();

        var tracks = _index.GetTracksForArtist(PopularityRankIndex.NormalizeText(artist), Math.Clamp(limit, 1, 100))
            .Where(track => _library.GetItemById<Audio>(track.ItemId, userId) is not null)
            .Select(track => new ArtistPopularityTrack(
                track.ItemId.ToString("N"),
                track.Title,
                track.ArtistNames,
                track.Rank,
                track.UpdatedUtc,
                track.MatchMethod))
            .ToArray();

        return Ok(new ArtistPopularityResponse(tracks, _index.TrackCount));
    }

    [HttpGet("top")]
    public ActionResult<TopPopularityResponse> GetTopTracks([FromQuery] int limit = 500)
    {
        if (!TryGetAuthenticatedUserId(out var userId)) return Unauthorized();
        var requestedLimit = Math.Clamp(limit, 1, 5000);
        var user = _userManager.GetUserById(userId);
        if (user is null) return Unauthorized();

        var candidates = _index.GetTopTracks(5000);
        var query = new InternalItemsQuery(user)
        {
            ItemIds = candidates.Select(track => track.ItemId).ToArray(),
            IncludeItemTypes = new[] { BaseItemKind.Audio },
            Recursive = true,
            Limit = candidates.Count,
            EnableTotalRecordCount = false,
        };
        _library.ConfigureUserAccess(query, user);
        var visibleIds = _library.GetItemIds(query).ToHashSet();
        var tracks = new List<ArtistPopularityTrack>(requestedLimit);
        foreach (var track in candidates)
        {
            if (!visibleIds.Contains(track.ItemId)) continue;
            tracks.Add(new ArtistPopularityTrack(
                track.ItemId.ToString("N"),
                track.Title,
                track.ArtistNames,
                track.Rank,
                track.UpdatedUtc,
                track.MatchMethod));
            if (tracks.Count >= requestedLimit) break;
        }

        return Ok(new TopPopularityResponse(tracks, _index.TrackCount));
    }

    private bool TryGetAuthenticatedUserId(out Guid userId)
    {
        var value = User.Claims.FirstOrDefault(claim =>
            string.Equals(claim.Type, UserIdClaim, StringComparison.OrdinalIgnoreCase))?.Value;
        return Guid.TryParse(value, out userId);
    }
}

public sealed record PopularityScore(int DeezerRank, DateTime UpdatedUtc, string MatchMethod);

public sealed record PopularityBatchResponse(
    IReadOnlyDictionary<string, PopularityScore> Scores,
    int IndexedTrackCount);

public sealed record ArtistPopularityTrack(
    string ItemId,
    string Title,
    IReadOnlyList<string> Artists,
    int DeezerRank,
    DateTime UpdatedUtc,
    string MatchMethod);

public sealed record ArtistPopularityResponse(
    IReadOnlyList<ArtistPopularityTrack> Tracks,
    int IndexedTrackCount);

public sealed record TopPopularityResponse(
    IReadOnlyList<ArtistPopularityTrack> Tracks,
    int IndexedTrackCount);

public sealed record PopularityProviderStatus(string Version, int IndexedTrackCount);
