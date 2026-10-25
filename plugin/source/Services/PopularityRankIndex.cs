using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace JellyMusicDiscovery.Services;

public sealed class PopularityRankIndex
{
    public sealed record TrackRank(
        Guid ItemId,
        string[] ArtistKeys,
        string[] ArtistNames,
        string Title,
        long DeezerTrackId,
        long DeezerArtistId,
        string? Isrc,
        int Rank,
        int? DurationSeconds,
        string MatchMethod,
        DateTime UpdatedUtc);

    public sealed record ArtistScan(DateTime ScannedUtc, int LibraryTrackCount, bool MatchedDeezerArtist);

    private sealed class PersistedState
    {
        public Dictionary<Guid, TrackRank> Tracks { get; set; } = new();
        public Dictionary<string, ArtistScan> Artists { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly object _sync = new();
    private readonly ILogger<PopularityRankIndex> _log;
    private readonly string? _filePath;
    private readonly Dictionary<Guid, TrackRank> _tracks = new();
    private readonly Dictionary<string, ArtistScan> _artists = new(StringComparer.OrdinalIgnoreCase);

    public PopularityRankIndex(ILogger<PopularityRankIndex> log)
    {
        _log = log;
        try
        {
            var folder = Plugin.Instance?.DataFolderPath;
            if (string.IsNullOrWhiteSpace(folder))
            {
                _log.LogWarning("[mdiscover-popularity] plugin data folder unavailable; ranks will be in-memory only");
                return;
            }

            Directory.CreateDirectory(folder);
            _filePath = Path.Combine(folder, "deezer-popularity.json");
            Load();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "[mdiscover-popularity] could not initialize disk cache");
        }
    }

    public int TrackCount
    {
        get { lock (_sync) return _tracks.Count; }
    }

    public int ArtistCount
    {
        get { lock (_sync) return _artists.Count; }
    }

    public static string NormalizeText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var decomposed = value.Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(decomposed.Length);
        foreach (var character in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(character) == UnicodeCategory.NonSpacingMark) continue;
            if (char.IsLetterOrDigit(character)) builder.Append(char.ToLowerInvariant(character));
        }
        return builder.ToString();
    }

    public TrackRank? GetTrack(Guid itemId)
    {
        lock (_sync) return _tracks.GetValueOrDefault(itemId);
    }

    public IReadOnlyList<TrackRank> GetTracksForArtist(string normalizedArtist, int limit)
    {
        lock (_sync)
        {
            return _tracks.Values
                .Where(track => track.ArtistKeys.Contains(normalizedArtist, StringComparer.Ordinal))
                .OrderByDescending(track => track.Rank)
                .ThenBy(track => track.Title, StringComparer.OrdinalIgnoreCase)
                .Take(limit)
                .ToArray();
        }
    }

    public IReadOnlyList<TrackRank> GetTopTracks(int limit)
    {
        lock (_sync)
        {
            return _tracks.Values
                .OrderByDescending(track => track.Rank)
                .ThenBy(track => track.Title, StringComparer.OrdinalIgnoreCase)
                .Take(Math.Clamp(limit, 1, 5000))
                .ToArray();
        }
    }

    public bool NeedsArtistScan(string artistKey, int libraryTrackCount, DateTime nowUtc, TimeSpan refreshAfter)
    {
        lock (_sync)
        {
            return !_artists.TryGetValue(artistKey, out var scan)
                || scan.LibraryTrackCount != libraryTrackCount
                || nowUtc - scan.ScannedUtc >= refreshAfter;
        }
    }

    public void SetTrack(TrackRank track)
    {
        lock (_sync)
        {
            if (_tracks.TryGetValue(track.ItemId, out var existing))
            {
                if (string.Equals(existing.MatchMethod, "isrc", StringComparison.Ordinal) && !string.Equals(track.MatchMethod, "isrc", StringComparison.Ordinal)) return;
                if (string.Equals(existing.MatchMethod, track.MatchMethod, StringComparison.Ordinal) && existing.Rank >= track.Rank) return;
            }
            _tracks[track.ItemId] = track;
        }
    }

    public void MarkArtistScanned(string artistKey, int libraryTrackCount, bool matchedDeezerArtist)
    {
        lock (_sync)
        {
            _artists[artistKey] = new ArtistScan(DateTime.UtcNow, libraryTrackCount, matchedDeezerArtist);
        }
    }

    public void Flush()
    {
        if (_filePath is null) return;

        lock (_sync)
        {
            try
            {
                var state = new PersistedState
                {
                    Tracks = new Dictionary<Guid, TrackRank>(_tracks),
                    Artists = new Dictionary<string, ArtistScan>(_artists, StringComparer.OrdinalIgnoreCase),
                };
                var temporaryPath = _filePath + ".tmp";
                using (var stream = File.Create(temporaryPath))
                {
                    JsonSerializer.Serialize(stream, state, JsonOptions);
                }
                File.Move(temporaryPath, _filePath, overwrite: true);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "[mdiscover-popularity] failed to persist {TrackCount} ranks", _tracks.Count);
            }
        }
    }

    private void Load()
    {
        if (_filePath is null || !File.Exists(_filePath)) return;
        try
        {
            using var stream = File.OpenRead(_filePath);
            var state = JsonSerializer.Deserialize<PersistedState>(stream, JsonOptions);
            if (state is null) return;
            lock (_sync)
            {
                foreach (var pair in state.Tracks) _tracks[pair.Key] = pair.Value;
                foreach (var pair in state.Artists) _artists[pair.Key] = pair.Value;
            }
            _log.LogInformation("[mdiscover-popularity] loaded {TrackCount} track ranks and {ArtistCount} artist checkpoints", _tracks.Count, _artists.Count);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "[mdiscover-popularity] could not read cache; starting empty");
        }
    }
}
