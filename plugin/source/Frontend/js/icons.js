// Adds explicit Lidarr request actions to discovery cards in Jellyfin Web.

(function () {
  const STUB_TAG = 'mdiscover-stub';
  const POLL_INTERVAL_MS = 800;
  const BUTTON_CLASS = 'mdiscover-request-button';
  const STYLE_ID = 'mdiscover-request-styles';

  function getApi() {
    return window.ApiClient ?? null;
  }

  function pluginRequestUrl(kind, itemId) {
    const path = kind === 'artist'
      ? `mdiscover/request/artist/${itemId}`
      : `mdiscover/request/album/${itemId}`;
    return getApi()?.getUrl(path) ?? `/${path}`;
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .mdiscover-request-host { position: relative !important; }
      .${BUTTON_CLASS} {
        position: absolute; z-index: 20; left: 8px; right: 8px; bottom: 8px;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        min-height: 36px; border: 0; border-radius: 5px; padding: 7px 12px;
        color: #fff; background: #6941c6; font: inherit; font-weight: 600;
        cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.5);
        opacity: 0; transition: opacity 0.15s ease-in-out;
        pointer-events: none;
      }
      .mdiscover-request-host:hover .${BUTTON_CLASS},
      .mdiscover-request-host:focus-within .${BUTTON_CLASS} {
        opacity: 1; pointer-events: auto;
      }
      .${BUTTON_CLASS}:disabled { cursor: default; background: #25834c; }
      .${BUTTON_CLASS}-icon { width: 16px; height: 16px; flex-shrink: 0; fill: currentColor; }
    `;
    document.head.appendChild(style);
  }

  function requestKind(type) {
    if (type === 'MusicArtist') return 'artist';
    if (type === 'MusicAlbum' || type === 'Audio') return 'album';
    return null;
  }

  function decorate(card, item) {
    if (card.dataset.mdiscoverDecorated === '1') return;
    const kind = requestKind(item.type);
    if (!kind) return;

    installStyles();
    card.dataset.mdiscoverDecorated = '1';
    // Match Jellyfin Enhanced's proven pattern: anchor absolutely-positioned
    // overlay buttons to .cardBox (the outer wrapper), not .cardScalable (the
    // inner image-scaling box, which clips/transforms its own content).
    const host = card.querySelector('.cardBox') ?? card;
    host.style.position = 'relative';
    host.classList.add('mdiscover-request-host');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    const label = 'Request';
    const iconSvg = '<svg class="' + BUTTON_CLASS + '-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1zM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>';
    button.innerHTML = iconSvg + '<span>' + label + '</span>';
    button.setAttribute('aria-label', kind === 'artist' ? 'Request artist' : 'Request album');
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (kind === 'artist' && !window.confirm(`Request the full discography for ${item.name}? Lidarr may monitor and search many albums.`)) return;
      button.disabled = true;
      button.innerHTML = '<span>Requesting…</span>';
      try {
        const api = getApi();
        const body = await api.ajax({ type: 'POST', url: pluginRequestUrl(kind, item.id), dataType: 'json' });
        button.innerHTML = '<span>Requested</span>';
        toast(body?.message ?? body?.Message ?? 'Request sent to Lidarr.');
      } catch (errOrResponse) {
        button.disabled = false;
        button.innerHTML = iconSvg + '<span>' + label + '</span>';
        let message = 'Request failed.';
        if (errOrResponse && typeof errOrResponse.json === 'function') {
          const errBody = await errOrResponse.json().catch(() => null);
          message = errBody?.message ?? errBody?.Message ?? `Request failed (${errOrResponse.status}).`;
        } else if (errOrResponse?.message) {
          message = errOrResponse.message;
        }
        toast(message);
      }
    });
    host.appendChild(button);
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 16px;background:#222;color:#fff;border-radius:6px;z-index:10000;font-size:14px;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  async function scan() {
    const api = getApi();
    if (!api) return;

    const cards = document.querySelectorAll('.card[data-id], [data-id].card');
    if (cards.length === 0) return;

    const idsToFetch = [];
    const pending = [];
    cards.forEach(c => {
      if (c.dataset.mdiscoverScanned === '1') return;
      const id = c.dataset.id;
      if (!id) return;
      c.dataset.mdiscoverScanned = '1';
      if (c.dataset.mdiscoverScannedId !== id) {
        delete c.dataset.mdiscoverScanned;
        delete c.dataset.mdiscoverDecorated;
        c.querySelectorAll(`.${BUTTON_CLASS}`).forEach(button => button.remove());
        c.dataset.mdiscoverScannedId = id;
      }
      if (c.dataset.mdiscoverScanned === '1' || c.dataset.mdiscoverChecking === '1') return;
      c.dataset.mdiscoverChecking = '1';
      idsToFetch.push(id);
      pending.push(c);
    });
    if (idsToFetch.length === 0) return;

    try {
      const r = await api.getItems(api.getCurrentUserId(), {
        Ids: idsToFetch.join(','),
        Fields: 'Tags,ProviderIds',
      });
      const byId = new Map((r?.Items ?? []).map(i => [String(i.Id).toLowerCase(), i]));
      pending.forEach(card => {
        delete card.dataset.mdiscoverChecking;
        const item = byId.get(String(card.dataset.id).toLowerCase());
        if (!item || !(item.Tags ?? []).includes(STUB_TAG)) return;
        decorate(card, {
          id: item.Id,
          type: item.Type,
          name: item.Name,
        });
      });
    } catch (e) {
      // Soft-fail; we'll try again on next poll.
    }
    pending.forEach(card => delete card.dataset.mdiscoverChecking);
  }

  setInterval(scan, POLL_INTERVAL_MS);
})();
