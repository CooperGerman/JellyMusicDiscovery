// Adds explicit Lidarr request actions to discovery cards in Jellyfin Web.

(function () {
  const STUB_TAG = 'mdiscover-stub';
  const POLL_INTERVAL_MS = 800;
  const BUTTON_CLASS = 'mdiscover-request-button';
  const STYLE_ID = 'mdiscover-request-styles';
  const SEARCH_SECTION_CLASS = 'mdiscover-search-section';
  const SEARCH_SECTION_TITLE = 'Discover on JellyMusicDiscovery';
  const YOUTUBE_SECTION_CLASS = 'mdiscover-youtube-section';
  const YOUTUBE_SECTION_TITLE = 'Play from YouTube';
  const EMPTY_SEARCH_ROW_GRACE_MS = 4000;
  let lastSearchHash = '';
  let emptySearchRowSince = new WeakMap();

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
      .mdiscover-requestable-card .cardOverlayContainer [data-action="resume"] {
        display: none !important;
      }
      .mdiscover-request-action {
        position: absolute; z-index: 30; inset: 0;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px;
        opacity: 0; transition: opacity 0.15s ease-in-out; pointer-events: none;
      }
      .mdiscover-request-host:hover .mdiscover-request-action,
      .mdiscover-request-host:focus-within .mdiscover-request-action {
        opacity: 1; pointer-events: auto;
      }
      .mdiscover-request-type {
        color: #fff; background: rgba(18, 18, 24, 0.82); border-radius: 4px;
        padding: 4px 9px; font-size: 12px; font-weight: 600;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
      }
      .${BUTTON_CLASS} {
        position: static; z-index: auto; left: auto; right: auto; bottom: auto;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        min-width: 112px; min-height: 36px; border: 0; border-radius: 5px; padding: 7px 12px;
        color: #fff; background: #6941c6; font: inherit; font-weight: 600;
        cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.5);
        opacity: 1;
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

  function requestTypeLabel(type) {
    if (type === 'MusicArtist') return 'Artist';
    if (type === 'MusicAlbum') return 'Album';
    if (type === 'Audio') return 'Song';
    return 'Item';
  }

  function decorate(card, item) {
    if (card.dataset.mdiscoverDecorated === '1') return;
    const kind = requestKind(item.type);
    if (!kind) return;

    installStyles();
    card.dataset.mdiscoverDecorated = '1';
    card.classList.add('mdiscover-requestable-card');
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
    const action = document.createElement('div');
    action.className = 'mdiscover-request-action';
    const typeLabel = document.createElement('span');
    typeLabel.className = 'mdiscover-request-type';
    typeLabel.textContent = requestTypeLabel(item.type);
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
    action.append(typeLabel, button);
    host.appendChild(action);
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 16px;background:#222;color:#fff;border-radius:6px;z-index:10000;font-size:14px;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function createSearchSection(searchResults, sectionClass, title) {
    const template = searchResults.querySelector('.verticalSection:not(.jellyseerr-section):not(.' + SEARCH_SECTION_CLASS + '):not(.' + YOUTUBE_SECTION_CLASS + ')');
    const templateScroller = template?.querySelector('[is="emby-scroller"]');
    const templateItems = templateScroller?.querySelector('.itemsContainer');
    const headingTemplate = template?.querySelector('h2');
    if (!template || !templateScroller || !templateItems || !headingTemplate) return null;

    const section = template.cloneNode(false);
    section.classList.add(sectionClass);
    section.dataset.mdiscoverSearchSection = '1';

    const heading = headingTemplate.cloneNode(false);
    heading.textContent = title;
    section.appendChild(heading);

    const scrollButtons = template.querySelector('[is="emby-scrollbuttons"]');
    if (scrollButtons) section.appendChild(scrollButtons.cloneNode(true));

    const scroller = templateScroller.cloneNode(true);
    const items = scroller.querySelector('.itemsContainer');
    if (!items) return null;
    items.replaceChildren();
    items.removeAttribute('style');
    section.appendChild(scroller);
    return section;
  }

  function hideEmptySearchRows(rows) {
    const now = Date.now();
    rows.forEach(row => {
      const hasCards = row.querySelector('.card[data-id]') !== null;
      if (hasCards) {
        emptySearchRowSince.delete(row);
        if (row.hidden) row.hidden = false;
        delete row.dataset.mdiscoverHiddenRow;
        return;
      }

      if (!emptySearchRowSince.has(row)) emptySearchRowSince.set(row, now);
      const shouldHide = now - emptySearchRowSince.get(row) >= EMPTY_SEARCH_ROW_GRACE_MS;
      if (row.hidden !== shouldHide) row.hidden = shouldHide;
      if (shouldHide) row.dataset.mdiscoverHiddenRow = '1';
    });
  }

  function groupSearchResults() {
    const route = window.location.hash.split('?')[0];
    if (route !== '#/search') return;

    const searchResults = document.querySelector('#searchPage .searchResults');
    if (!searchResults) return;

    if (lastSearchHash && lastSearchHash !== window.location.hash) {
      searchResults.querySelector('.' + SEARCH_SECTION_CLASS)?.remove();
      searchResults.querySelector('.' + YOUTUBE_SECTION_CLASS)?.remove();
      emptySearchRowSince = new WeakMap();
      searchResults.querySelectorAll('[data-mdiscover-hidden-row="1"]').forEach(row => {
        row.hidden = false;
        delete row.dataset.mdiscoverHiddenRow;
      });
    }
    lastSearchHash = window.location.hash;

    const rows = [...searchResults.querySelectorAll('.verticalSection:not(.jellyseerr-section):not(.' + SEARCH_SECTION_CLASS + '):not(.' + YOUTUBE_SECTION_CLASS + ')')];

    const discoveryCards = [...searchResults.querySelectorAll('.card[data-mdiscover-result="1"]')];
    const youtubeCards = discoveryCards.filter(card => card.dataset.mdiscoverType === 'MusicVideo');
    const otherDiscoveryCards = discoveryCards.filter(card => card.dataset.mdiscoverType !== 'MusicVideo');
    hideEmptySearchRows(rows);
    function updateSection(sectionClass, title, cards) {
      let section = searchResults.querySelector('.' + sectionClass);
      if (cards.length === 0) {
        section?.remove();
        return;
      }
      if (!section) section = createSearchSection(searchResults, sectionClass, title);
      const items = section?.querySelector('.itemsContainer');
      if (!section || !items) return;

      cards.forEach(card => {
        if (card.parentElement === items) return;
        card.dataset.index = String(items.querySelectorAll('.card[data-id]').length);
        items.appendChild(card);
      });
      return section;
    }

    const discoverySection = updateSection(SEARCH_SECTION_CLASS, SEARCH_SECTION_TITLE, otherDiscoveryCards);
    const youtubeSection = updateSection(YOUTUBE_SECTION_CLASS, YOUTUBE_SECTION_TITLE, youtubeCards);
    const orderedSections = [discoverySection, youtubeSection].filter(Boolean);
    const children = [...searchResults.children];
    const anchorIndex = children.findIndex(child => child.matches('.verticalSection.jellyseerr-section'));
    const insertionIndex = anchorIndex < 0 ? children.length : anchorIndex;
    const currentSequence = children.slice(Math.max(0, insertionIndex - orderedSections.length), insertionIndex);
    const isInPosition = currentSequence.length === orderedSections.length
      && currentSequence.every((section, index) => section === orderedSections[index]);

    if (!isInPosition) {
      for (const section of orderedSections) {
        const beforeSection = [...searchResults.children]
          .find(child => child.matches('.verticalSection.jellyseerr-section')) ?? null;
        if (section.parentElement === searchResults && section.nextElementSibling === beforeSection) continue;
        searchResults.insertBefore(section, beforeSection);
      }
    }
    hideEmptySearchRows(rows);
  }

  async function scan() {
    const api = getApi();
    if (!api) return;

    const cards = document.querySelectorAll('.card[data-id], [data-id].card');
    if (cards.length === 0) {
      groupSearchResults();
      return;
    }

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
        c.querySelectorAll('.mdiscover-request-action').forEach(action => action.remove());
        c.classList.remove('mdiscover-requestable-card');
        delete c.dataset.mdiscoverResult;
        c.dataset.mdiscoverScannedId = id;
      }
      if (c.dataset.mdiscoverScanned === '1' || c.dataset.mdiscoverChecking === '1') return;
      c.dataset.mdiscoverChecking = '1';
      idsToFetch.push(id);
      pending.push(c);
    });
    if (idsToFetch.length === 0) {
      groupSearchResults();
      return;
    }

    try {
      const r = await api.getItems(api.getCurrentUserId(), {
        Ids: idsToFetch.join(','),
        Fields: 'Tags,ProviderIds',
      });
      const byId = new Map((r?.Items ?? []).map(i => [String(i.Id).toLowerCase(), i]));
      pending.forEach(card => {
        delete card.dataset.mdiscoverChecking;
        const item = byId.get(String(card.dataset.id).toLowerCase());
        if (!item || !(item.Tags ?? []).includes(STUB_TAG)) {
          delete card.dataset.mdiscoverResult;
          return;
        }
        card.dataset.mdiscoverResult = '1';
        card.dataset.mdiscoverType = item.Type ?? item.type ?? '';
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
    groupSearchResults();
  }

  setInterval(scan, POLL_INTERVAL_MS);
})();
