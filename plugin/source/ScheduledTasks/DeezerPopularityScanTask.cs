using System;
using System.Collections.Generic;
using System.Linq;
using JellyMusicDiscovery;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using JellyMusicDiscovery.Services;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace JellyMusicDiscovery.ScheduledTasks;

public sealed class DeezerPopularityScanTask : IScheduledTask
{
    private const int PageSize = 500;
    private const int ArtistSearchLimit = 5;
    private const int ArtistTopTrackLimit = 100;
    private const int CheckpointArtistCount = 25;
    private static readonly TimeSpan ArtistRefreshAge = TimeSpan.FromDays(30);
    private static readonly TimeSpan RequestDelay = TimeSpan.FromMilliseconds(150);

    private readonly ILibraryManager _library;
    private readonly DeezerClient _deezer;
    private readonly PopularityRankIndex _index;
    private readonly ILogger<DeezerPopularityScanTask> _log;

    public DeezerPopularityScanTask(
        ILibraryManager library,
        DeezerClient deezer,
        PopularityRankIndex index,
        ILogger<DeezerPopularityScanTask> log)
    {
        _library = library;
        _deezer = deezer;
        _index = index;
        _log = log;
    }

    public string Name => "Music Discovery: Index Deezer track popularity";
    public string Key => "MusicDiscoveryDeezerPopularity";
    public string Description => "Cache Deezer ranks for confidently matched tracks in the Jellyfin library.";
    public string Category => "Music Discovery";

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        progress.Report(0);
        var artists = ReadLibraryArtists(progress, cancellationToken);
        var now = DateTime.UtcNow;
        var artistsToScan = artists.Values
            .Where(group => _index.NeedsArtistScan(group.Key, group.TrackIds.Count, now, ArtistRefreshAge))
            .OrderBy(group => group.Key, StringComparer.Ordinal)
            .ToArray();

        _log.LogInformation(
            "[mdiscover-popularity] library has {ArtistCount} artists; scanning {ScanCount}, index has {TrackCount} tracks",
            artists.Count,
            artistsToScan.Length,
            _index.TrackCount);

        if (artistsToScan.Length == 0)
        {
            _index.Flush();
            progress.Report(100);
            return;
        }

        var completed = 0;
        var updatedTracks = 0;
        foreach (var artistGroup in artistsToScan)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var search = await _deezer.SearchArtistsForPopularityAsync(
                    artistGroup.Name,
                    ArtistSearchLimit,
                    cancellationToken).ConfigureAwait(false);
                await Task.Delay(RequestDelay, cancellationToken).ConfigureAwait(false);
                if (search is null)
                {
                    _log.LogWarning("[mdiscover-popularity] Deezer artist search failed for {Artist}; it will be retried later", artistGroup.Name);
                    continue;
                }

                var deezerArtist = search.Data
                    .Where(candidate => PopularityRankIndex.NormalizeText(candidate.Name) == artistGroup.Key)
                    .OrderByDescending(candidate => candidate.Fans ?? 0)
                    .FirstOrDefault();
                if (deezerArtist is null)
                {
                    _index.MarkArtistScanned(artistGroup.Key, artistGroup.TrackIds.Count, matchedDeezerArtist: false);
                }
                else
                {
                    var topTracks = await _deezer.GetArtistTopTracksAsync(
                        deezerArtist.Id,
                        ArtistTopTrackLimit,
                        cancellationToken).ConfigureAwait(false);
                    await Task.Delay(RequestDelay, cancellationToken).ConfigureAwait(false);
                    if (topTracks is null)
                    {
                        _log.LogWarning("[mdiscover-popularity] Deezer top-track lookup failed for {Artist}; it will be retried later", artistGroup.Name);
                        continue;
                    }

                    updatedTracks += IndexMatches(artistGroup, deezerArtist, topTracks.Data);
                    _index.MarkArtistScanned(artistGroup.Key, artistGroup.TrackIds.Count, matchedDeezerArtist: true);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                _index.Flush();
                throw;
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "[mdiscover-popularity] failed while scanning {Artist}; it will be retried later", artistGroup.Name);
                continue;
            }

            completed++;
            if (completed % CheckpointArtistCount == 0)
            {
                _index.Flush();
                _log.LogInformation("[mdiscover-popularity] scanned {Completed}/{Total} artists; matched {TrackCount} tracks", completed, artistsToScan.Length, updatedTracks);
            }
            progress.Report(20 + (80d * completed / artistsToScan.Length));
        }

        _index.Flush();
        progress.Report(100);
        _log.LogInformation("[mdiscover-popularity] scan complete; matched {TrackCount} tracks", updatedTracks);
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => Array.Empty<TaskTriggerInfo>();

    private Dictionary<string, LocalArtistGroup> ReadLibraryArtists(IProgress<double> progress, CancellationToken cancellationToken)
    {
        var artists = new Dictionary<string, LocalArtistGroup>(StringComparer.Ordinal);
        var startIndex = 0;
        var totalCount = 0;
        var isFirstPage = true;

        while (isFirstPage || startIndex < totalCount)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var page = _library.GetItemsResult(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Audio },
                Recursive = true,
                ExcludeTags = new[] { Tags.Stub },
                StartIndex = startIndex,
                Limit = PageSize,
                EnableTotalRecordCount = isFirstPage,
                GroupByPresentationUniqueKey = false,
            });

            if (isFirstPage)
            {
                totalCount = page.TotalRecordCount;
                isFirstPage = false;
            }

            if (page.Items.Count == 0) break;
            foreach (var item in page.Items.OfType<Audio>())
            {
                cancellationToken.ThrowIfCancellationRequested();
                var names = (item.Artists ?? Array.Empty<string>())
                    .Concat(item.AlbumArtists ?? Array.Empty<string>())
                    .Where(name => !string.IsNullOrWhiteSpace(name))
                    .Distinct(StringComparer.OrdinalIgnoreCase);
                var artistNames = names.ToArray();
                var artistKeys = artistNames
                    .Select(PopularityRankIndex.NormalizeText)
                    .Where(key => key.Length > 0)
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
                var localTrack = new LocalTrack(
                    item.Id,
                    item.Name ?? string.Empty,
                    item.RunTimeTicks is { } ticks ? (int?)Math.Round(TimeSpan.FromTicks(ticks).TotalSeconds) : null,
                    item.ProviderIds?.GetValueOrDefault("ISRC"),
                    artistKeys,
                    artistNames);

                foreach (var (name, key) in artistNames.Select(name => (name, PopularityRankIndex.NormalizeText(name))))
                {
                    if (key.Length == 0) continue;
                    if (!artists.TryGetValue(key, out var group))
                    {
                        group = new LocalArtistGroup(key, name.Trim());
                        artists.Add(key, group);
                    }
                    group.Tracks[localTrack.Id] = localTrack;
                }
            }

            startIndex += page.Items.Count;
            progress.Report(totalCount > 0 ? Math.Min(20, 20d * startIndex / totalCount) : 20);
        }

        return artists;
    }

    private int IndexMatches(LocalArtistGroup group, DeezerClient.DzArtist artist, IReadOnlyList<DeezerClient.DzTrack> deezerTracks)
    {
        var localByTitle = group.Tracks.Values
            .GroupBy(track => PopularityRankIndex.NormalizeText(track.Title))
            .Where(matches => matches.Key.Length > 0)
            .ToDictionary(matches => matches.Key, matches => matches.ToArray(), StringComparer.Ordinal);
        var matchesWritten = 0;

        foreach (var deezerTrack in deezerTracks)
        {
            if (deezerTrack.Id <= 0 || deezerTrack.Rank is not { } rank || rank <= 0) continue;
            if (!string.IsNullOrWhiteSpace(deezerTrack.Artist?.Name)
                && PopularityRankIndex.NormalizeText(deezerTrack.Artist.Name) != group.Key)
            {
                continue;
            }

            var titleKeys = new[] { deezerTrack.Title, deezerTrack.TitleShort }
                .Select(PopularityRankIndex.NormalizeText)
                .Where(key => key.Length > 0)
                .Distinct(StringComparer.Ordinal);
            var candidates = titleKeys
                .Where(localByTitle.ContainsKey)
                .SelectMany(key => localByTitle[key])
                .DistinctBy(track => track.Id)
                .ToArray();
            if (candidates.Length == 0) continue;

            var matched = candidates
                .Select(track => new { Track = track, Method = GetMatchMethod(track, deezerTrack) })
                .Where(candidate => candidate.Method is not null)
                .OrderBy(candidate => candidate.Method == "isrc" ? 0 : 1)
                .ThenBy(candidate => DurationDifference(candidate.Track.DurationSeconds, deezerTrack.Duration))
                .ToArray();
            if (matched.Length == 0) continue;

            var best = matched[0];
            _index.SetTrack(new PopularityRankIndex.TrackRank(
                best.Track.Id,
                best.Track.ArtistKeys,
                best.Track.ArtistNames,
                best.Track.Title,
                deezerTrack.Id,
                artist.Id,
                deezerTrack.Isrc,
                rank,
                deezerTrack.Duration,
                best.Method!,
                DateTime.UtcNow));
            matchesWritten++;
        }

        return matchesWritten;
    }

    private static string? GetMatchMethod(LocalTrack local, DeezerClient.DzTrack deezer)
    {
        if (!string.IsNullOrWhiteSpace(local.Isrc) && !string.IsNullOrWhiteSpace(deezer.Isrc))
        {
            return string.Equals(local.Isrc, deezer.Isrc, StringComparison.OrdinalIgnoreCase) ? "isrc" : null;
        }

        if (local.DurationSeconds.HasValue && deezer.Duration.HasValue)
        {
            var tolerance = Math.Max(5, local.DurationSeconds.Value * 0.03);
            if (Math.Abs(local.DurationSeconds.Value - deezer.Duration.Value) > tolerance) return null;
        }

        return "title-artist-duration";
    }

    private static double DurationDifference(int? left, int? right) =>
        left.HasValue && right.HasValue ? Math.Abs(left.Value - right.Value) : double.MaxValue;

    private sealed class LocalArtistGroup
    {
        public LocalArtistGroup(string key, string name)
        {
            Key = key;
            Name = name;
        }

        public string Key { get; }
        public string Name { get; }
        public Dictionary<Guid, LocalTrack> Tracks { get; } = new();
        public HashSet<Guid> TrackIds => Tracks.Keys.ToHashSet();
    }

    private sealed record LocalTrack(
        Guid Id,
        string Title,
        int? DurationSeconds,
        string? Isrc,
        string[] ArtistKeys,
        string[] ArtistNames);
}
