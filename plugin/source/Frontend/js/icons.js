// Adds explicit Lidarr request actions to discovery cards in Jellyfin Web.

(function () {
  const STUB_TAG = 'mdiscover-stub';
  const PENDING_CLASS = 'mdiscover-pending';
  const POLL_INTERVAL_MS = 800;
  const BUTTON_CLASS = 'mdiscover-request-button';
  const STYLE_ID = 'mdiscover-request-styles';
  const SEARCH_SECTION_CLASS = 'mdiscover-search-section';
  const SEARCH_SECTION_TITLE = 'Discover on JellyMusicDiscovery';
  const YOUTUBE_SECTION_CLASS = 'mdiscover-youtube-section';
  const YOUTUBE_SECTION_TITLE = 'Play from YouTube';
  let lastSearchHash = '';
  let searchGroupingQueued = false;
  let searchGeneration = 0;

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
      .${PENDING_CLASS} { visibility: hidden !important; }
      .mdiscover-lidarr-status {
        position: absolute; z-index: 25; top: 6px; left: 6px;
        display: inline-flex; align-items: center; gap: 5px; max-width: calc(100% - 12px);
        padding: 4px 7px; border-radius: 4px; color: #fff;
        background: rgba(18, 18, 24, 0.88); font-size: 11px; font-weight: 650;
        line-height: 1.2; pointer-events: none; text-shadow: 0 1px 2px rgba(0,0,0,0.8);
      }
      .mdiscover-lidarr-status-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mdiscover-lidarr-status-icon { width: 14px; height: 14px; flex: 0 0 14px; }
      .mdiscover-lidarr-status[data-state="requested"] { background: rgba(20, 105, 58, 0.94); }
      .mdiscover-lidarr-status[data-state="matched"],
      .mdiscover-lidarr-status[data-state="unmonitored"] { background: rgba(120, 78, 16, 0.94); }
      .mdiscover-lidarr-status[data-state="no-match"],
      .mdiscover-lidarr-status[data-state="unconfigured"] { background: rgba(150, 35, 40, 0.94); }
      .mdiscover-lidarr-status[data-state="unavailable"],
      .mdiscover-lidarr-status[data-state="unknown"] { background: rgba(76, 76, 86, 0.94); }
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
        opacity: 1;
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
        opacity: 1; pointer-events: auto;
      }
      .${BUTTON_CLASS}:disabled { cursor: default; background: #25834c; }
      .${BUTTON_CLASS}[data-lidarr-state="no-match"],
      .${BUTTON_CLASS}[data-lidarr-state="unconfigured"] { background: #8d292e; }
      .${BUTTON_CLASS}[data-lidarr-state="unavailable"],
      .${BUTTON_CLASS}[data-lidarr-state="unknown"] { background: #555560; }
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

  function normalizeLidarrStatus(status) {
    if (!status) return null;
    return {
      configured: Boolean(status.configured ?? status.Configured),
      available: Boolean(status.available ?? status.Available),
      matched: Boolean(status.matched ?? status.Matched),
      inLidarr: Boolean(status.inLidarr ?? status.InLidarr),
      monitored: Boolean(status.monitored ?? status.Monitored),
    };
  }

  function getLidarrStatusPresentation(status) {
    status = normalizeLidarrStatus(status);
    if (!status) return { state: 'unknown', label: 'Lidarr status unavailable', symbol: '?' };
    if (!status.configured) return { state: 'unconfigured', label: 'Lidarr not configured', symbol: '×' };
    if (!status.available) return { state: 'unavailable', label: 'Lidarr unavailable', symbol: '?' };
    if (!status.matched) return { state: 'no-match', label: 'No Lidarr match', symbol: '×' };
    if (status.monitored) return { state: 'requested', label: 'Requested · monitored', symbol: '✓' };
    if (status.inLidarr) return { state: 'unmonitored', label: 'In Lidarr · not monitored', symbol: '!' };
    return { state: 'matched', label: 'Lidarr match · not requested', symbol: '✓' };
  }

  function renderLidarrStatus(element, status) {
    const presentation = getLidarrStatusPresentation(status);
    element.dataset.state = presentation.state;
    element.title = presentation.label;
    element.setAttribute('aria-label', presentation.label);
    const icon = document.createElement('span');
    icon.className = 'mdiscover-lidarr-status-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = presentation.symbol;
    const label = document.createElement('span');
    label.className = 'mdiscover-lidarr-status-label';
    label.textContent = presentation.label;
    element.replaceChildren(icon, label);
  }

  function decorate(card, item, lidarrStatus) {
    if (card.dataset.mdiscoverDecorated === '1') return;
    lidarrStatus = normalizeLidarrStatus(lidarrStatus);
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

    const statusBadge = document.createElement('span');
    statusBadge.className = 'mdiscover-lidarr-status';
    renderLidarrStatus(statusBadge, lidarrStatus);
    host.appendChild(statusBadge);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    const definiteNoMatch = lidarrStatus?.configured && lidarrStatus?.available && !lidarrStatus?.matched;
    const unavailableConfiguration = lidarrStatus && !lidarrStatus.configured;
    button.disabled = Boolean(lidarrStatus?.monitored || definiteNoMatch || unavailableConfiguration);
    button.dataset.lidarrState = getLidarrStatusPresentation(lidarrStatus).state;
    const label = lidarrStatus?.monitored ? 'Requested'
      : definiteNoMatch || unavailableConfiguration ? 'Unavailable'
        : 'Request';
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
        const statusResponse = await api.ajax({
          type: 'POST',
          url: api.getUrl('mdiscover/lidarr/status'),
          data: JSON.stringify([item.id]),
          contentType: 'application/json',
          dataType: 'json',
        }).catch(() => null);
        const statusRow = (statusResponse?.items ?? statusResponse?.Items ?? [])[0];
        const updatedStatus = normalizeLidarrStatus(statusRow?.status ?? statusRow?.Status);
        if (updatedStatus) {
          renderLidarrStatus(statusBadge, updatedStatus);
          button.disabled = Boolean(updatedStatus.monitored);
          button.dataset.lidarrState = getLidarrStatusPresentation(updatedStatus).state;
          button.innerHTML = updatedStatus.monitored ? '<span>Requested</span>' : iconSvg + '<span>Request</span>';
        } else {
          button.innerHTML = '<span>Requested</span>';
          button.disabled = true;
        }
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
    rows.forEach(row => {
      const hasLocalCards = [...row.querySelectorAll('.card[data-id]')]
        .some(card => card.dataset.mdiscoverResult !== '1' && !card.classList.contains(PENDING_CLASS));
      row.hidden = !hasLocalCards;
      if (hasLocalCards) {
        delete row.dataset.mdiscoverHiddenRow;
      } else {
        row.dataset.mdiscoverHiddenRow = '1';
      }
    });
  }

  function normalizeItemId(id) {
    return String(id ?? '').replaceAll('-', '').toLowerCase();
  }

  function normalizeSearchValue(value) {
    let normalized = [...String(value ?? '').toLocaleLowerCase()]
      .filter(character => /[\p{L}\p{N}]/u.test(character))
      .join('');
    if (normalized.startsWith('the') && normalized.length > 3) normalized = normalized.slice(3);
    return normalized;
  }

  function searchNameMatchScore(query, candidate) {
    const queryKey = normalizeSearchValue(query);
    const candidateKey = normalizeSearchValue(candidate);
    if (!queryKey || !candidateKey) return 100;
    if (candidateKey === queryKey) return 0;
    if (candidateKey.startsWith(queryKey)) return 1;
    if (candidateKey.includes(queryKey)) return 2;
    return 100;
  }

  function discoveryRelevanceScore(query, item) {
    const type = item.Type ?? item.type;
    const name = item.Name ?? item.name;
    const typeOrder = type === 'MusicArtist' ? 0 : type === 'Audio' ? 1 : 2;
    const titleScore = searchNameMatchScore(query, name);
    if (titleScore < 100) return titleScore * 100 + typeOrder;

    const artistNames = [
      item.AlbumArtist ?? item.albumArtist,
      ...(item.Artists ?? item.artists ?? []),
      ...(item.ArtistItems ?? item.artistItems ?? []).map(artist => artist?.Name ?? artist?.name),
      ...(item.AlbumArtists ?? item.albumArtists ?? []).map(artist => artist?.Name ?? artist?.name),
    ];
    const artistScore = Math.min(100, ...artistNames.map(name => searchNameMatchScore(query, name)));
    return artistScore < 100 ? 1_000 + artistScore * 100 + typeOrder : 10_000 + typeOrder;
  }

  function getSearchQuery() {
    return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('query') ?? '';
  }

  async function fetchLidarrStatuses(api, items) {
    const statuses = new Map();
    for (let start = 0; start < items.length; start += 20) {
      const batch = items.slice(start, start + 20);
      try {
        const response = await api.ajax({
          type: 'POST',
          url: api.getUrl('mdiscover/lidarr/status'),
          data: JSON.stringify(batch.map(entry => entry.item.id)),
          contentType: 'application/json',
          dataType: 'json',
        });
        (response?.items ?? response?.Items ?? []).forEach(entry => {
          const id = entry?.id ?? entry?.Id;
          const status = entry?.status ?? entry?.Status;
          if (id && status) statuses.set(normalizeItemId(id), normalizeLidarrStatus(status));
        });
      } catch (_) {
        // Request actions remain available when Lidarr status is unavailable.
      }
    }
    return statuses;
  }

  function isNativeSearchSection(section) {
    return section?.classList.contains('verticalSection')
      && !section.classList.contains('jellyseerr-section')
      && !section.classList.contains(SEARCH_SECTION_CLASS)
      && !section.classList.contains(YOUTUBE_SECTION_CLASS);
  }

  function queueSearchGrouping() {
    if (searchGroupingQueued) return;
    searchGroupingQueued = true;
    queueMicrotask(() => {
      searchGroupingQueued = false;
      groupSearchResults();
    });
  }

  function markPendingDiscoveryCard(card) {
    if (card.dataset.mdiscoverResult === '1') return false;
    const hasDiscoveryImage = [...card.querySelectorAll('.cardImageContainer')]
      .some(image => /[?&]tag=deezer-/i.test(image.style.backgroundImage));
    if (hasDiscoveryImage) {
      if (card.classList.contains(PENDING_CLASS)) return false;
      installStyles();
      card.classList.add(PENDING_CLASS);
      return true;
    } else {
      if (!card.classList.contains(PENDING_CLASS)) return false;
      card.classList.remove(PENDING_CLASS);
      return true;
    }
  }

  function markPendingDiscoveryCards(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    let changed = false;
    if (node.matches('.card[data-id]')) changed = markPendingDiscoveryCard(node) || changed;
    node.querySelectorAll('.card[data-id]').forEach(card => {
      changed = markPendingDiscoveryCard(card) || changed;
    });
    return changed;
  }

  function loadDiscoveryImages(cards) {
    cards.forEach(card => {
      card.querySelectorAll('.cardImageContainer[data-src]').forEach(image => {
        const source = image.dataset.src;
        if (!source || image.style.backgroundImage !== 'none') return;

        // Moving cards into the unified row can happen after Jellyfin's
        // lazy-image observer has scanned them. Load the image explicitly so
        // client plugins observing the same search DOM do not leave a blank
        // discovery card.
        const escapedSource = source.replace(/(["\\])/g, '\\$1');
        image.style.backgroundImage = `url("${escapedSource}")`;
        image.classList.remove('lazy-hidden');
      });
    });
  }

  function containsNativeSearchSection(node) {
    if (node.matches?.('.verticalSection') && isNativeSearchSection(node)) return true;
    return [...(node.querySelectorAll?.('.verticalSection') ?? [])].some(isNativeSearchSection);
  }

  const pendingDiscoveryObserver = new MutationObserver(records => {
    let shouldRegroup = false;
    records.forEach(record => {
      if (record.type === 'attributes') {
        if (record.target.matches('.cardImageContainer')) {
          const card = record.target.closest('.card[data-id]');
          if (card) {
            shouldRegroup = markPendingDiscoveryCard(card) || shouldRegroup;
            const row = card.closest('.verticalSection');
            if (isNativeSearchSection(row) && row.hidden && !card.classList.contains(PENDING_CLASS))
              shouldRegroup = true;
          }
        }
        return;
      }
      if (record.removedNodes.length) {
        const row = record.target.closest?.('.verticalSection');
        if (isNativeSearchSection(row)) shouldRegroup = true;
      }
      record.addedNodes.forEach(node => {
        shouldRegroup = markPendingDiscoveryCards(node) || shouldRegroup;
        shouldRegroup = containsNativeSearchSection(node) || shouldRegroup;
        const cards = node.nodeType === Node.ELEMENT_NODE
          ? (node.matches('.card[data-id]') ? [node] : [...node.querySelectorAll('.card[data-id]')])
          : [];
        shouldRegroup = cards.some(card => {
          const row = card.closest('.verticalSection');
          return isNativeSearchSection(row) && row.hidden && !card.classList.contains(PENDING_CLASS);
        }) || shouldRegroup;
      });
    });
    if (shouldRegroup) queueSearchGrouping();
  });
  pendingDiscoveryObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
  if (markPendingDiscoveryCards(document.documentElement)) queueSearchGrouping();

  function groupSearchResults() {
    const route = window.location.hash.split('?')[0];
    if (route !== '#/search') return;

    const searchResults = document.querySelector('#searchPage .searchResults');
    if (!searchResults) return;

    if (lastSearchHash && lastSearchHash !== window.location.hash) {
      searchResults.querySelector('.' + SEARCH_SECTION_CLASS)?.remove();
      searchResults.querySelector('.' + YOUTUBE_SECTION_CLASS)?.remove();
    }
    lastSearchHash = window.location.hash;

    const rows = [...searchResults.querySelectorAll('.verticalSection:not(.jellyseerr-section):not(.' + SEARCH_SECTION_CLASS + '):not(.' + YOUTUBE_SECTION_CLASS + ')')];

    const discoveryCards = [...searchResults.querySelectorAll('.card[data-mdiscover-result="1"]')]
      .sort((first, second) =>
        Number(first.dataset.mdiscoverRelevance ?? 100_000)
        - Number(second.dataset.mdiscoverRelevance ?? 100_000));
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
      loadDiscoveryImages(cards);
      return section;
    }

    const discoverySection = updateSection(SEARCH_SECTION_CLASS, SEARCH_SECTION_TITLE, otherDiscoveryCards);
    const youtubeSection = updateSection(YOUTUBE_SECTION_CLASS, YOUTUBE_SECTION_TITLE, youtubeCards);
    const orderedSections = [discoverySection, youtubeSection].filter(Boolean);
    const isSection = child => child.matches('.verticalSection');
    const currentSections = [...searchResults.children].filter(isSection);
    const nativeSections = currentSections.filter(section =>
      !section.classList.contains('jellyseerr-section')
      && !section.classList.contains(SEARCH_SECTION_CLASS)
      && !section.classList.contains(YOUTUBE_SECTION_CLASS));
    const seerrSections = currentSections.filter(section => section.classList.contains('jellyseerr-section'));
    const desiredSections = [...nativeSections, ...orderedSections, ...seerrSections];
    const orderIsCorrect = currentSections.length === desiredSections.length
      && currentSections.every((section, index) => section === desiredSections[index]);

    if (!orderIsCorrect) {
      desiredSections.forEach((section, index) => {
        const currentAtIndex = [...searchResults.children].filter(isSection)[index] ?? null;
        if (currentAtIndex !== section) searchResults.insertBefore(section, currentAtIndex);
      });
    }
    hideEmptySearchRows(rows);
  }

  window.addEventListener('hashchange', () => {
    searchGeneration += 1;
    queueSearchGrouping();
  });
  document.addEventListener('input', event => {
    if (event.target instanceof Element && event.target.matches('#searchPage #searchTextInput'))
      searchGeneration += 1;
  });
  queueSearchGrouping();

  async function scan() {
    const api = getApi();
    if (!api) return;
    const scanGeneration = searchGeneration;
    const scanHash = window.location.hash;
    const searchQuery = getSearchQuery();

    const cards = document.querySelectorAll('.card[data-id], [data-id].card');
    if (cards.length === 0) return;

    const idsToFetch = [];
    const pending = [];
    const readyCards = [];
    let layoutChanged = false;
    cards.forEach(c => {
      const id = c.dataset.id;
      if (!id) return;
      if (c.dataset.mdiscoverScannedId !== id || c.dataset.mdiscoverScannedQuery !== searchQuery) {
        delete c.dataset.mdiscoverScanned;
        delete c.dataset.mdiscoverDecorated;
        c.querySelectorAll('.mdiscover-request-action').forEach(action => action.remove());
        c.querySelectorAll('.mdiscover-lidarr-status').forEach(status => status.remove());
        c.classList.remove('mdiscover-requestable-card');
        delete c.dataset.mdiscoverResult;
        c.dataset.mdiscoverScannedId = id;
        c.dataset.mdiscoverScannedQuery = searchQuery;
      }
      layoutChanged = markPendingDiscoveryCard(c) || layoutChanged;
      const row = c.closest('.verticalSection');
      if (isNativeSearchSection(row) && row.hidden
          && !c.classList.contains(PENDING_CLASS) && c.dataset.mdiscoverResult !== '1')
        layoutChanged = true;
      if (c.dataset.mdiscoverScanned === '1' || c.dataset.mdiscoverChecking === '1') return;
      c.dataset.mdiscoverChecking = '1';
      idsToFetch.push(id);
      pending.push(c);
    });
    if (layoutChanged) groupSearchResults();
    if (idsToFetch.length === 0) return;

    try {
      const r = await api.getItems(api.getCurrentUserId(), {
        Ids: idsToFetch.join(','),
        Fields: 'Tags,ProviderIds',
      });
      if (scanGeneration !== searchGeneration || scanHash !== window.location.hash) return;
      const byId = new Map((r?.Items ?? []).map(i => [String(i.Id).toLowerCase(), i]));
      const discoveryItems = [];
      const retryCards = new Set();
      pending.forEach(card => {
        const item = byId.get(String(card.dataset.id).toLowerCase());
        if (!item) {
          retryCards.add(card);
          return;
        }
        if (!(item.Tags ?? []).includes(STUB_TAG)) {
          card.classList.remove(PENDING_CLASS);
          delete card.dataset.mdiscoverResult;
          return;
        }
        installStyles();
        card.classList.add(PENDING_CLASS);
        discoveryItems.push({
          card,
          item: {
            id: item.Id,
            type: item.Type,
            name: item.Name,
          },
        });
      });
      const lidarrStatuses = await fetchLidarrStatuses(api, discoveryItems);
      if (scanGeneration !== searchGeneration || scanHash !== window.location.hash) return;
      discoveryItems.forEach(({ card, item }) => {
        card.dataset.mdiscoverResult = '1';
        card.dataset.mdiscoverType = item.type ?? '';
        card.dataset.mdiscoverRelevance = String(discoveryRelevanceScore(searchQuery, item));
        decorate(card, item, lidarrStatuses.get(normalizeItemId(item.id)) ?? null);
        readyCards.push(card);
      });
      pending.forEach(card => {
        if (retryCards.has(card)) return;
        card.dataset.mdiscoverScanned = '1';
      });
    } catch (e) {
      // Soft-fail; we'll try again on next poll.
    } finally {
      pending.forEach(card => delete card.dataset.mdiscoverChecking);
    }
    groupSearchResults();
    readyCards.forEach(card => card.classList.remove(PENDING_CLASS));
  }

  setInterval(scan, POLL_INTERVAL_MS);
})();
