using System;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace JellyMusicDiscovery.Frontend;

/// <summary>
/// Registers the request-overlay script with the File Transformation plugin so
/// index.html gets the script injected without us touching Jellyfin's own files.
/// File Transformation may install/start after us, so we retry for a while.
/// </summary>
public sealed class WebClientTransformationRegistration : BackgroundService
{
    private static readonly Guid TransformationId = Guid.Parse("bc436ea4-3d52-4a9c-a724-0aec2b72f215");
    private readonly ILogger<WebClientTransformationRegistration> _log;

    public WebClientTransformationRegistration(ILogger<WebClientTransformationRegistration> log)
    {
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        for (var attempt = 0; attempt < 60 && !stoppingToken.IsCancellationRequested; attempt++)
        {
            var fileTransformation = AssemblyLoadContext.All
                .SelectMany(context => context.Assemblies)
                .FirstOrDefault(assembly => assembly.FullName?.Contains("FileTransformation", StringComparison.OrdinalIgnoreCase) == true);
            var pluginInterface = fileTransformation?.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
            var register = pluginInterface?.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);

            if (register is not null)
            {
                try
                {
                    var payloadType = register.GetParameters().FirstOrDefault()?.ParameterType;
                    var parse = payloadType?.GetMethod("Parse", new[] { typeof(string) });
                    if (payloadType is null || parse is null)
                    {
                        _log.LogWarning("File Transformation was found, but its registration payload API was not recognized.");
                        return;
                    }

                    var payloadJson = JsonSerializer.Serialize(new
                    {
                        id = TransformationId,
                        // Must be the literal key other plugins use ("index.html"), not a
                        // regex. File Transformation keeps one pipeline PER EXACT dictionary
                        // key and only falls back to regex matching when no exact key exists
                        // for the request path — registering "^index\.html$" here silently
                        // never ran because an exact "index.html" key (from another plugin)
                        // always wins the lookup first.
                        fileNamePattern = "index.html",
                        callbackAssembly = typeof(WebClientScriptTransformation).Assembly.FullName,
                        callbackClass = typeof(WebClientScriptTransformation).FullName,
                        callbackMethod = nameof(WebClientScriptTransformation.TransformIndexHtml),
                    });
                    var payload = parse.Invoke(null, new object[] { payloadJson });
                    register.Invoke(null, new[] { payload });
                    _log.LogInformation("Registered the Music Discovery web-card request buttons.");
                }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "Could not register the Music Discovery web-card transformation.");
                }
                return;
            }

            await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken).ConfigureAwait(false);
        }

        if (!stoppingToken.IsCancellationRequested)
            _log.LogInformation("File Transformation was not found; Music Discovery request buttons are unavailable in Jellyfin Web.");
    }
}

/// <summary>
/// Static callback invoked by File Transformation. Injects the overlay script
/// into Jellyfin Web's index.html exactly once (guarded by a marker attribute).
/// </summary>
public static class WebClientScriptTransformation
{
    private const string InjectionMarker = "data-jellymusicdiscovery-request-ui";
    private const string ScriptResourceName = "JellyMusicDiscovery.Frontend.js.icons.js";

    public static string TransformIndexHtml(object payload)
    {
        using var payloadDocument = JsonDocument.Parse(payload.ToString() ?? "{}");
        if (!payloadDocument.RootElement.TryGetProperty("contents", out var contentsElement)) return string.Empty;

        var contents = contentsElement.GetString() ?? string.Empty;
        if (contents.Contains(InjectionMarker, StringComparison.Ordinal)) return contents;

        using var stream = typeof(WebClientScriptTransformation).Assembly.GetManifestResourceStream(ScriptResourceName);
        if (stream is null) return contents;
        using var reader = new System.IO.StreamReader(stream, Encoding.UTF8);
        var script = reader.ReadToEnd();
        var injected = $"<script {InjectionMarker}=\"true\">{script}</script>";
        var bodyEnd = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        return bodyEnd < 0
            ? contents + injected
            : contents.Insert(bodyEnd, injected);
    }
}
