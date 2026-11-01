using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using JellyMusicDiscovery;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace JellyMusicDiscovery.Services;

/// <summary>
/// Incrementally adds Deezer popularity ranks when Jellyfin imports new audio.
/// A quiet-period timer coalesces large library imports into one pass.
/// </summary>
public sealed class PopularityLibraryWatcher : IHostedService, IDisposable
{
    private static readonly TimeSpan ImportDebounce = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan DeezerRequestDelay = TimeSpan.FromMilliseconds(150);
    private const int ArtistSearchLimit = 5;
    private const int ArtistTopTrackLimit = 100;

    private readonly ILibraryManager _library;
    private readonly DeezerClient _deezer;
    private readonly PopularityRankIndex _index;
    private readonly ILogger<PopularityLibraryWatcher> _log;
    private readonly ConcurrentDictionary<Guid, byte> _pendingItemIds = new();
    private readonly SemaphoreSlim _processing = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Timer _debounceTimer;

    public PopularityLibraryWatcher(
        ILibraryManager library,
        DeezerClient deezer,
        PopularityRankIndex index,
        ILogger<PopularityLibraryWatcher> log)
    {
        _library = library;
        _deezer = deezer;
        _index = index;
        _log = log;
        _debounceTimer = new Timer(OnDebounceElapsed, null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _library.ItemAdded += OnItemAdded;
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _library.ItemAdded -= OnItemAdded;
        _shutdown.Cancel();
        _debounceTimer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        await _processing.WaitAsync(cancellationToken).ConfigureAwait(false);
        _processing.Release();
    }

    private void OnItemAdded(object? sender, ItemChangeEventArgs args)
    {
        if (args.Item is not Audio audio || audio.IsDiscoveryStub()) return;

        _pendingItemIds[audio.Id] = 0;
        _debounceTimer.Change(ImportDebounce, Timeout.InfiniteTimeSpan);
    }

    private void OnDebounceElapsed(object? state) => _ = ProcessPendingAsync();

    private async Task ProcessPendingAsync()
    {
        if (_shutdown.IsCancellationRequested || !await _processing.WaitAsync(0).ConfigureAwait(false)) return;
        var tracks = new List<Audio>();
        try
        {
            var itemIds = _pendingItemIds.Keys.ToArray();
            tracks.Capacity = itemIds.Length;
            foreach (var id in itemIds)
            {
                if (!_pendingItemIds.TryRemove(id, out _)) continue;
                if (_library.GetItemById(id) is Audio audio && !audio.IsDiscoveryStub())
                    tracks.Add(audio);
                else
                    _pendingItemIds[id] = 0;
            }

            if (tracks.Count == 0) return;
            await IndexNewTracksAsync(tracks, _shutdown.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "[mdiscover-popularity] incremental library indexing failed");
            QueueTracks(tracks);
        }
        finally
        {
            _processing.Release();
            if (!_shutdown.IsCancellationRequested && !_pendingItemIds.IsEmpty)
                _debounceTimer.Change(ImportDebounce, Timeout.InfiniteTimeSpan);
        }
    }

    private async Task IndexNewTracksAsync(IReadOnlyCollection<Audio> tracks, CancellationToken cancellationToken)
    {
        var groups = new Dictionary<string, LocalArtistGroup>(StringComparer.Ordinal);
        foreach (var item in tracks)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var names = (item.Artists ?? Array.Empty<string>())
                .Concat(item.AlbumArtists ?? Array.Empty<string>())
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            var artistKeys = names
                .Select(PopularityRankIndex.NormalizeText)
                .Where(key => key.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (artistKeys.Length == 0) continue;

            var localTrack = new LocalTrack(
                item.Id,
                item.Name ?? string.Empty,
                item.RunTimeTicks is { } ticks ? (int?)Math.Round(TimeSpan.FromTicks(ticks).TotalSeconds) : null,
                item.ProviderIds?.GetValueOrDefault("ISRC"),
                artistKeys,
                names);

            foreach (var name in names)
            {
                var key = PopularityRankIndex.NormalizeText(name);
                if (key.Length == 0) continue;
                if (!groups.TryGetValue(key, out var group))
                {
                    group = new LocalArtistGroup(key, name.Trim());
                    groups.Add(key, group);
                }
                group.Tracks[localTrack.Id] = localTrack;
            }
        }

        var updatedTracks = 0;
        foreach (var group in groups.Values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var search = await _deezer.SearchArtistsForPopularityAsync(
                    group.Name,
                    ArtistSearchLimit,
                    cancellationToken).ConfigureAwait(false);
                await Task.Delay(DeezerRequestDelay, cancellationToken).ConfigureAwait(false);
                if (search is null)
                {
                    QueueTracks(group.Tracks.Values);
                    continue;
                }

                var artist = search.Data
                    .Where(candidate => PopularityRankIndex.NormalizeText(candidate.Name) == group.Key)
                    .OrderByDescending(candidate => candidate.Fans ?? 0)
                    .FirstOrDefault();
                if (artist is null) continue;

                var topTracks = await _deezer.GetArtistTopTracksAsync(
                    artist.Id,
                    ArtistTopTrackLimit,
                    cancellationToken).ConfigureAwait(false);
                await Task.Delay(DeezerRequestDelay, cancellationToken).ConfigureAwait(false);
                if (topTracks is null)
                {
                    QueueTracks(group.Tracks.Values);
                    continue;
                }

                updatedTracks += IndexMatches(group, artist, topTracks.Data);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "[mdiscover-popularity] incremental rank lookup failed for {Artist}", group.Name);
                QueueTracks(group.Tracks.Values);
            }
        }

        _index.Flush();
        _log.LogInformation(
            "[mdiscover-popularity] incrementally processed {TrackCount} new tracks across {ArtistCount} artists; matched {MatchedCount}",
            tracks.Count,
            groups.Count,
            updatedTracks);
    }

    private void QueueTracks(IEnumerable<LocalTrack> tracks)
    {
        foreach (var track in tracks) _pendingItemIds[track.Id] = 0;
    }

    private void QueueTracks(IEnumerable<Audio> tracks)
    {
        foreach (var track in tracks) _pendingItemIds[track.Id] = 0;
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
                && PopularityRankIndex.NormalizeText(deezerTrack.Artist.Name) != group.Key) continue;

            var titleKeys = new[] { deezerTrack.Title, deezerTrack.TitleShort }
                .Select(PopularityRankIndex.NormalizeText)
                .Where(key => key.Length > 0)
                .Distinct(StringComparer.Ordinal);
            var candidates = titleKeys
                .Where(localByTitle.ContainsKey)
                .SelectMany(key => localByTitle[key])
                .DistinctBy(track => track.Id)
                .ToArray();
            var matched = candidates
                .Select(track => new { Track = track, Method = GetMatchMethod(track, deezerTrack) })
                .Where(candidate => candidate.Method is not null)
                .OrderBy(candidate => candidate.Method == "isrc" ? 0 : 1)
                .ThenBy(candidate => DurationDifference(candidate.Track.DurationSeconds, deezerTrack.Duration))
                .FirstOrDefault();
            if (matched is null) continue;

            _index.SetTrack(new PopularityRankIndex.TrackRank(
                matched.Track.Id,
                matched.Track.ArtistKeys,
                matched.Track.ArtistNames,
                matched.Track.Title,
                deezerTrack.Id,
                artist.Id,
                deezerTrack.Isrc,
                rank,
                deezerTrack.Duration,
                matched.Method!,
                DateTime.UtcNow));
            matchesWritten++;
        }

        return matchesWritten;
    }

    private static string? GetMatchMethod(LocalTrack local, DeezerClient.DzTrack deezer)
    {
        if (!string.IsNullOrWhiteSpace(local.Isrc) && !string.IsNullOrWhiteSpace(deezer.Isrc))
            return string.Equals(local.Isrc, deezer.Isrc, StringComparison.OrdinalIgnoreCase) ? "isrc" : null;

        if (local.DurationSeconds.HasValue && deezer.Duration.HasValue)
        {
            var tolerance = Math.Max(5, local.DurationSeconds.Value * 0.03);
            if (Math.Abs(local.DurationSeconds.Value - deezer.Duration.Value) > tolerance) return null;
        }
        return "title-artist-duration";
    }

    private static double DurationDifference(int? left, int? right) =>
        left.HasValue && right.HasValue ? Math.Abs(left.Value - right.Value) : double.MaxValue;

    public void Dispose()
    {
        _debounceTimer.Dispose();
        _processing.Dispose();
        _shutdown.Dispose();
    }

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
    }

    private sealed record LocalTrack(Guid Id, string Title, int? DurationSeconds, string? Isrc, string[] ArtistKeys, string[] ArtistNames);
}