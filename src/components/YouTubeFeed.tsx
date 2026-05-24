import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  ImageOff,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  DEFAULT_DOWNLOAD_ADVANCED,
  DownloadJob,
  type DownloadAdvancedOptions,
} from '../lib/github';
import { cn } from '../lib/utils';
import type { ArchiveItem } from '../lib/useArchive';
import { toPersianErrorMessage } from '../lib/errors';
import { useDownloadSubmit } from '../lib/useDownloadSubmit';
import {
  isYoutubeProxyAvailable,
  loadYoutubeProxySettings,
  loadYoutubeSubscriptions,
  saveYoutubeSubscriptions,
  youtubeProxyImage,
  youtubeProxyResolveSubscription,
  youtubeProxySearch,
  youtubeProxySubscriptionFeed,
  type YouTubeFeedItem,
  type YouTubeSubscription,
} from '../lib/youtubeProxy';

interface YouTubeFeedProps {
  onAddPending: (job: DownloadJob) => void;
  onPatchJob: (jobId: string, updates: Partial<DownloadJob>) => void;
  hasConfig: boolean;
  networkError: string | null;
  downloadBusy: boolean;
  archiveItems: ArchiveItem[];
}

const QUALITIES = [
  { value: '480p', label: '480P' },
  { value: '720p', label: '720P' },
  { value: '1080p', label: '1080P' },
  { value: 'best', label: 'BEST' },
] as const;

const FORMATS = [
  { value: 'mp4', label: 'MP4' },
  { value: 'mp3', label: 'MP3' },
] as const;

const FEED_TIMELINE_STORAGE_KEY = 'cns_youtube_feed_timeline_v1';
const FEED_TIMELINE_NEW_TTL_MS = 72 * 60 * 60 * 1000;

function youtubeWatchUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function itemKey(item: YouTubeFeedItem) {
  return item.videoId || item.url;
}

function slugForSubscription(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function isValidChannelId(value?: string) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(value?.trim() ?? '');
}

function channelIdForSubscription(sub: YouTubeSubscription) {
  const channelId = sub.channelId?.trim() || (sub.kind === 'channel' ? sub.value.trim() : '');
  return isValidChannelId(channelId) ? channelId : '';
}

function normalizeSubscriptionForState(sub: YouTubeSubscription): YouTubeSubscription {
  const label = sub.label.trim() || sub.value.trim() || sub.channelId?.trim() || 'کانال';
  const channelId = channelIdForSubscription(sub);
  if (sub.kind === 'channel' && channelId) {
    return {
      ...sub,
      id: `channel:${channelId}`,
      kind: 'channel',
      label,
      value: channelId,
      channelId,
    };
  }
  if (sub.kind === 'channel') {
    const value = sub.value.trim() || label;
    return {
      ...sub,
      id: sub.id || `channel:${slugForSubscription(value)}`,
      kind: 'channel',
      label,
      value,
      channelId: undefined,
    };
  }
  const value = sub.value.trim() || label;
  return {
    ...sub,
    id: sub.id.startsWith('search:') ? sub.id : `search:${slugForSubscription(value)}`,
    kind: 'search',
    label,
    value,
    channelId: undefined,
  };
}

function subscriptionDedupeKey(sub: YouTubeSubscription) {
  const normalized = normalizeSubscriptionForState(sub);
  if (normalized.kind === 'channel') {
    return `channel:${normalized.channelId ?? normalized.value}`.toLowerCase();
  }
  return `search:${normalized.value.trim().toLowerCase()}`;
}

function subscriptionsEqual(a: YouTubeSubscription[], b: YouTubeSubscription[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function subscriptionKeyForList(items: YouTubeSubscription[]) {
  return items.map((sub) => `${sub.id}:${sub.value}`).join('|');
}

type FeedTimelineMemory = {
  sources: Record<string, string[]>;
  newVideoIds: Record<string, string>;
};

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeTimelineMemory(raw: unknown): FeedTimelineMemory {
  if (!raw || typeof raw !== 'object') {
    return { sources: {}, newVideoIds: {} };
  }
  const value = raw as Record<string, unknown>;
  const sourcesRaw = value.sources && typeof value.sources === 'object' ? value.sources as Record<string, unknown> : {};
  const newRaw = value.newVideoIds && typeof value.newVideoIds === 'object' ? value.newVideoIds as Record<string, unknown> : {};
  const sources: Record<string, string[]> = {};
  Object.entries(sourcesRaw).forEach(([key, entry]) => {
    if (!Array.isArray(entry)) return;
    sources[key] = entry.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 160);
  });
  const newVideoIds: Record<string, string> = {};
  Object.entries(newRaw).forEach(([key, entry]) => {
    if (typeof entry !== 'string' || entry.length === 0) return;
    newVideoIds[key] = entry;
  });
  return { sources, newVideoIds };
}

function loadFeedTimelineMemory(): FeedTimelineMemory {
  try {
    return normalizeTimelineMemory(safeParse(localStorage.getItem(FEED_TIMELINE_STORAGE_KEY), null));
  } catch {
    return { sources: {}, newVideoIds: {} };
  }
}

function saveFeedTimelineMemory(memory: FeedTimelineMemory) {
  try {
    localStorage.setItem(FEED_TIMELINE_STORAGE_KEY, JSON.stringify(memory));
  } catch {
  }
}

function sourceKeyForItem(item: YouTubeFeedItem): string | null {
  if (item.sourceId && item.sourceId.trim()) return item.sourceId.trim();
  if (item.channelId && item.channelId.trim()) return `channel:${item.channelId.trim()}`;
  return null;
}

function mergeUnique(ids: string[], existing: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    out.push(id);
    seen.add(id);
  }
  for (const id of existing) {
    if (!id || seen.has(id)) continue;
    out.push(id);
    seen.add(id);
  }
  return out.slice(0, 160);
}

function mergeFeedItems(existing: YouTubeFeedItem[], incoming: YouTubeFeedItem[]) {
  const seen = new Set(existing.map(itemKey));
  const items = [...existing];
  let added = 0;
  incoming.forEach((item) => {
    const key = itemKey(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(item);
    added += 1;
  });
  return { items, added };
}

function pruneNewVideoIds(newVideoIds: Record<string, string>) {
  const now = Date.now();
  const entries = Object.entries(newVideoIds)
    .filter(([, seenAt]) => {
      const ts = Date.parse(seenAt);
      return Number.isFinite(ts) && now - ts <= FEED_TIMELINE_NEW_TTL_MS;
    })
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  return Object.fromEntries(entries.slice(0, 240));
}

function normalizeAdvancedForFormat(format: string, adv: DownloadAdvancedOptions): DownloadAdvancedOptions {
  if (format === 'mp3') {
    return { ...adv, container: 'default', codec: 'copy', bitrate: 'auto' };
  }
  if (adv.codec === 'copy') {
    return { ...adv, bitrate: 'auto' };
  }
  return adv;
}

export function YouTubeFeed({
  onAddPending,
  onPatchJob,
  hasConfig,
  networkError,
  downloadBusy,
  archiveItems,
}: YouTubeFeedProps) {
  const proxyAvailable = isYoutubeProxyAvailable();
  const [settings] = useState(() => loadYoutubeProxySettings());
  const [subscriptions, setSubscriptions] = useState<YouTubeSubscription[]>(() => loadYoutubeSubscriptions());
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [transientSource, setTransientSource] = useState<YouTubeSubscription | null>(null);
  const [subscriptionInput, setSubscriptionInput] = useState('');
  const [items, setItems] = useState<YouTubeFeedItem[]>([]);
  const [imageCache, setImageCache] = useState<Record<string, string>>({});
  const [failedImages, setFailedImages] = useState<Record<string, true>>({});
  const [timelineMemory, setTimelineMemory] = useState<FeedTimelineMemory>(() => loadFeedTimelineMemory());
  const [selected, setSelected] = useState<YouTubeFeedItem | null>(null);
  const [quality, setQuality] = useState<string>('480p');
  const [format, setFormat] = useState<string>('mp4');
  const [advanced] = useState<DownloadAdvancedOptions>(() => DEFAULT_DOWNLOAD_ADVANCED);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const migrationRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const firstTimelineLoadRef = useRef(true);
  const lastAutoLoadKeyRef = useRef('');
  const { submitDownload, isSubmitting } = useDownloadSubmit({ onAddPending, onPatchJob });

  const canUseProxy = proxyAvailable;
  const downloadDisabled = !hasConfig || !!networkError || downloadBusy || isSubmitting;
  const subscriptionKey = useMemo(() => subscriptionKeyForList(subscriptions), [subscriptions]);
  const activeViewLabel = activeQuery.trim()
    ? 'نتایج جستجو'
    : activeSourceId
      ? subscriptions.find((sub) => sub.id === activeSourceId)?.label ?? transientSource?.label ?? 'فید ذخیره‌شده'
      : 'فید همه کانال‌ها';
  const normalizedAdvanced = useMemo(
    () => normalizeAdvancedForFormat(format, advanced),
    [advanced, format]
  );

  useEffect(() => {
    const normalized = subscriptions.map(normalizeSubscriptionForState);
    if (!subscriptionsEqual(subscriptions, normalized)) {
      setSubscriptions(normalized);
      return;
    }
    saveYoutubeSubscriptions(normalized);
  }, [subscriptions]);

  useEffect(() => {
    if (!canUseProxy) return;
    const candidates = subscriptions.filter((sub) => {
      if (sub.kind === 'search') return sub.value.trim();
      return !channelIdForSubscription(sub) && (sub.value.trim() || sub.label.trim());
    });
    if (candidates.length === 0) return;
    const requestId = migrationRequestRef.current + 1;
    migrationRequestRef.current = requestId;
    let cancelled = false;

    const run = async () => {
      const resolvedById = new Map<string, YouTubeSubscription>();
      for (const sub of candidates.slice(0, 8)) {
        if (cancelled || requestId !== migrationRequestRef.current) return;
        try {
          const input = sub.value.trim() || sub.label.trim();
          const resolved = normalizeSubscriptionForState(
            await youtubeProxyResolveSubscription(input, settings.instance)
          );
          if (resolved.kind === 'channel') {
            resolvedById.set(sub.id, { ...resolved, addedAt: sub.addedAt || resolved.addedAt });
          }
        } catch {
        }
      }
      if (cancelled || resolvedById.size === 0 || requestId !== migrationRequestRef.current) return;
      setSubscriptions((prev) => {
        const seen = new Set<string>();
        const next = prev
          .map((sub) => resolvedById.get(sub.id) ?? sub)
          .map(normalizeSubscriptionForState)
          .filter((sub) => {
            const key = subscriptionDedupeKey(sub);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        return subscriptionsEqual(prev, next) ? prev : next;
      });
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [canUseProxy, settings.instance, subscriptions]);

  useEffect(() => {
    saveFeedTimelineMemory(timelineMemory);
  }, [timelineMemory]);

  const rememberTimeline = useCallback((nextItems: YouTubeFeedItem[]) => {
    setTimelineMemory((prev) => {
      const firstLoad = firstTimelineLoadRef.current;
      firstTimelineLoadRef.current = false;
      const now = new Date().toISOString();
      const sources = { ...prev.sources };
      const newVideoIds = pruneNewVideoIds(prev.newVideoIds);
      const idsBySource = new Map<string, string[]>();

      nextItems.forEach((item) => {
        const sourceKey = sourceKeyForItem(item);
        if (!sourceKey) return;
        const key = itemKey(item);
        if (!key) return;
        const list = idsBySource.get(sourceKey) ?? [];
        list.push(key);
        idsBySource.set(sourceKey, list);
      });

      idsBySource.forEach((ids, sourceKey) => {
        const previousIds = sources[sourceKey] ?? [];
        if (!firstLoad && previousIds.length > 0) {
          ids.forEach((id) => {
            if (!previousIds.includes(id) && !newVideoIds[id]) {
              newVideoIds[id] = now;
            }
          });
        }
        sources[sourceKey] = mergeUnique(ids, previousIds);
      });

      return { sources, newVideoIds };
    });
  }, []);

  const loadFeed = useCallback(async ({
    queryText = activeQuery,
    sourceId = activeSourceId,
    pageNumber = 1,
    append = false,
    sourceSubscription: explicitSourceSubscription,
  }: {
    queryText?: string;
    sourceId?: string | null;
    pageNumber?: number;
    append?: boolean;
    sourceSubscription?: YouTubeSubscription | null;
  } = {}) => {
    if (!canUseProxy) return;
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    if (append) {
      loadingMoreRef.current = true;
      setIsLoadingMore(true);
    } else {
      loadingMoreRef.current = false;
      setIsLoading(true);
      setPage(1);
    }
    setError(null);
    try {
      const trimmedQuery = queryText.trim();
      const sourceSubscription = sourceId
        ? explicitSourceSubscription
          ?? subscriptions.find((sub) => sub.id === sourceId)
          ?? (transientSource && transientSource.id === sourceId ? transientSource : null)
        : null;
      const resolvedSourceSubscription = sourceSubscription ? normalizeSubscriptionForState(sourceSubscription) : null;
      const feedSubscriptions = sourceSubscription ? [sourceSubscription] : subscriptions;
      const feedKey = subscriptionKeyForList(feedSubscriptions);
      const next = trimmedQuery
        ? await youtubeProxySearch(trimmedQuery, settings.instance, pageNumber)
        : await youtubeProxySubscriptionFeed(
          resolvedSourceSubscription ? [resolvedSourceSubscription] : subscriptions.map(normalizeSubscriptionForState),
          settings.instance,
          pageNumber
        );
      if (requestId !== loadRequestRef.current) return;
      if (append) {
        setItems((prev) => {
          const merged = mergeFeedItems(prev, next);
          setHasMore(next.length > 0 && merged.added > 0);
          return merged.items;
        });
      } else {
        setItems(next);
        setHasMore(next.length > 0);
      }
      setPage(pageNumber);
      if (!trimmedQuery && !append && pageNumber === 1) {
        rememberTimeline(next);
        if (sourceId) {
          lastAutoLoadKeyRef.current = `${feedKey}::${sourceId}`;
        }
      }
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      setError(toPersianErrorMessage(err));
      if (!append) setItems([]);
      setHasMore(false);
      loadingMoreRef.current = false;
    } finally {
      if (requestId === loadRequestRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
        loadingMoreRef.current = false;
      }
    }
  }, [activeQuery, activeSourceId, canUseProxy, rememberTimeline, settings.instance, subscriptions, transientSource]);

  const refreshActiveView = useCallback(() => {
    void loadFeed({
      queryText: activeQuery,
      sourceId: activeQuery.trim() ? null : activeSourceId,
      pageNumber: 1,
    });
  }, [activeQuery, activeSourceId, loadFeed]);

  const loadNextPage = useCallback(() => {
    if (!canUseProxy || isLoading || isLoadingMore || loadingMoreRef.current || !hasMore || error || items.length === 0) return;
    loadingMoreRef.current = true;
    void loadFeed({
      queryText: activeQuery,
      sourceId: activeQuery.trim() ? null : activeSourceId,
      pageNumber: page + 1,
      append: true,
    });
  }, [activeQuery, activeSourceId, canUseProxy, error, hasMore, isLoading, isLoadingMore, items.length, loadFeed, page]);

  useEffect(() => {
    if (!canUseProxy) return;
    if (activeQuery.trim()) return;
    const autoLoadKey = `${subscriptionKey}::${activeSourceId ?? 'all'}`;
    if (lastAutoLoadKeyRef.current === autoLoadKey) return;
    lastAutoLoadKeyRef.current = autoLoadKey;
    void loadFeed({ queryText: '', sourceId: activeSourceId, pageNumber: 1 });
  }, [activeQuery, activeSourceId, canUseProxy, loadFeed, subscriptionKey]);

  useEffect(() => {
    if (!canUseProxy || activeQuery.trim()) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadFeed({ queryText: '', sourceId: activeSourceId, pageNumber: 1 });
      }
    }, 10 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [activeQuery, activeSourceId, canUseProxy, loadFeed]);

  useEffect(() => {
    if (
      !activeSourceId ||
      subscriptions.some((sub) => sub.id === activeSourceId) ||
      transientSource?.id === activeSourceId
    ) return;
    setActiveSourceId(null);
  }, [activeSourceId, subscriptions, transientSource]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !canUseProxy || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadNextPage();
      }
    }, { rootMargin: '720px 0px 720px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [canUseProxy, loadNextPage]);

  useEffect(() => {
    if (!canUseProxy) return;
    let cancelled = false;
    const urls = Array.from(
      new Set(items.map((item) => item.thumbnailUrl).filter((url): url is string => !!url))
    ).filter((url) => !imageCache[url] && !failedImages[url]);
    if (urls.length === 0) return;

    const run = async () => {
      const queue = [...urls];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0 && !cancelled) {
          const url = queue.shift();
          if (!url) return;
          try {
            const dataUrl = await youtubeProxyImage(url, settings.instance);
            if (cancelled) return;
            setImageCache((prev) => ({ ...prev, [url]: dataUrl }));
          } catch {
            if (cancelled) return;
            setFailedImages((prev) => ({ ...prev, [url]: true }));
          }
        }
      });
      await Promise.all(workers);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [canUseProxy, failedImages, imageCache, items, settings.instance]);

  const imageForItem = useCallback((item: YouTubeFeedItem) => {
    return item.thumbnailUrl ? imageCache[item.thumbnailUrl] : undefined;
  }, [imageCache]);

  const isNewItem = useCallback((item: YouTubeFeedItem) => {
    return Boolean(timelineMemory.newVideoIds[itemKey(item)]);
  }, [timelineMemory.newVideoIds]);

  const markItemSeen = useCallback((videoId: string) => {
    setTimelineMemory((prev) => {
      if (!prev.newVideoIds[videoId]) return prev;
      const next = {
        sources: prev.sources,
        newVideoIds: { ...prev.newVideoIds },
      };
      delete next.newVideoIds[videoId];
      return next;
    });
  }, []);

  const openQueryFeed = useCallback((nextQuery: string) => {
    const trimmed = nextQuery.trim();
    setSelected(null);
    setTransientSource(null);
    setActiveSourceId(null);
    setActiveQuery(trimmed);
    setPage(1);
    setHasMore(true);
    void loadFeed({ queryText: trimmed, sourceId: null, pageNumber: 1 });
  }, [loadFeed]);

  const openSubscriptionFeed = useCallback(async (subscriptionId: string | null) => {
    setSelected(null);
    setActiveQuery('');
    setTransientSource(null);
    setPage(1);
    setHasMore(true);
    if (!subscriptionId) {
      setActiveSourceId(null);
      void loadFeed({ queryText: '', sourceId: null, pageNumber: 1 });
      return;
    }

    const source = subscriptions.find((sub) => sub.id === subscriptionId) ?? null;
    const normalizedSource = source ? normalizeSubscriptionForState(source) : null;
    const input = source?.value.trim() || source?.label.trim() || '';
    const shouldResolve = Boolean(
      input && (
        !normalizedSource ||
        normalizedSource.kind === 'search' ||
        (normalizedSource.kind === 'channel' && !channelIdForSubscription(normalizedSource))
      )
    );
    if (shouldResolve) {
      setError(null);
      setIsLoading(true);
      try {
        const resolved = normalizeSubscriptionForState(
          await youtubeProxyResolveSubscription(input, settings.instance)
        );
        if (resolved.kind === 'channel') {
          setSubscriptions((prev) => {
            const seen = new Set<string>();
            const next = prev
              .map((sub) => (sub.id === subscriptionId ? { ...resolved, addedAt: sub.addedAt || resolved.addedAt } : sub))
              .map(normalizeSubscriptionForState)
              .filter((sub) => {
                const key = subscriptionDedupeKey(sub);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
            return subscriptionsEqual(prev, next) ? prev : next;
          });
          setActiveSourceId(resolved.id);
          await loadFeed({
            queryText: '',
            sourceId: resolved.id,
            pageNumber: 1,
            sourceSubscription: resolved,
          });
          return;
        }
      } catch (err) {
        setError(toPersianErrorMessage(err));
        setItems([]);
        setHasMore(false);
        return;
      } finally {
        setIsLoading(false);
      }
    }

    setActiveSourceId(subscriptionId);
    void loadFeed({
      queryText: '',
      sourceId: subscriptionId,
      pageNumber: 1,
      sourceSubscription: normalizedSource,
    });
  }, [loadFeed, settings.instance, subscriptions]);

  const openTransientChannel = useCallback(async (channelId: string, label?: string) => {
    if (!canUseProxy) return;
    const term = (channelId || label || '').trim();
    if (!term) return;
    setSelected(null);
    setError(null);
    setIsLoading(true);
    try {
      const knownChannelId = /^UC[A-Za-z0-9_-]{22}$/.test(term);
      const resolved = normalizeSubscriptionForState(
        knownChannelId
          ? {
              id: `channel:${term}`,
              kind: 'channel',
              label: label?.trim() || term,
              value: term,
              channelId: term,
              addedAt: new Date().toISOString(),
            }
          : await youtubeProxyResolveSubscription(term, settings.instance)
      );
      setTransientSource(resolved);
      setActiveQuery('');
      setActiveSourceId(resolved.id);
      setPage(1);
      setHasMore(true);
      await loadFeed({
        queryText: '',
        sourceId: resolved.id,
        pageNumber: 1,
        sourceSubscription: resolved,
      });
    } catch (err) {
      setError(toPersianErrorMessage(err));
      setItems([]);
      setHasMore(false);
    } finally {
      setIsLoading(false);
    }
  }, [canUseProxy, loadFeed, settings.instance]);

  const openSearchChannel = useCallback(async (item: YouTubeFeedItem) => {
    if (!item.channelId && !item.channelTitle) return;
    await openTransientChannel(item.channelId || item.channelTitle || '', item.channelTitle);
  }, [openTransientChannel]);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    openQueryFeed(query);
  };

  const handleAddSubscription = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = subscriptionInput.trim();
    if (!input || isAdding || !canUseProxy) return;
    setIsAdding(true);
    setError(null);
    try {
      const resolved = normalizeSubscriptionForState(
        await youtubeProxyResolveSubscription(input, settings.instance)
      );
      setSubscriptions((prev) => {
        const resolvedKey = subscriptionDedupeKey(resolved);
        if (prev.some((s) => subscriptionDedupeKey(s) === resolvedKey)) return prev;
        return [resolved, ...prev].map(normalizeSubscriptionForState).slice(0, 40);
      });
      setSubscriptionInput('');
      setActiveQuery('');
      setQuery('');
      setTransientSource(null);
    } catch (err) {
      setError(toPersianErrorMessage(err));
    } finally {
      setIsAdding(false);
    }
  };

  const handleDownload = async () => {
    if (!selected || downloadDisabled) return;
    setDrawerError(null);
    try {
      await submitDownload({
        url: selected.url || youtubeWatchUrl(selected.videoId),
        source: 'youtube',
        quality: format === 'mp3' ? 'audio' : quality,
        format: format === 'mp3' ? 'mp3' : 'mp4',
        advanced: normalizedAdvanced,
        archiveItems,
      });
      setSelected(null);
    } catch (err) {
      setDrawerError(toPersianErrorMessage(err));
    }
  };

  return (
    <section className="yt-workspace" dir="ltr">
      <aside className="yt-sidebar" dir="rtl">
        <div className="yt-panel-head">
          <div>
            <p className="yt-kicker">YouTube</p>
            <h2>کانال‌ها و جستجوها</h2>
          </div>
          <button
            type="button"
            onClick={refreshActiveView}
            disabled={!canUseProxy || isLoading || isLoadingMore}
            title="تازه‌سازی"
          >
            <RefreshCw size={14} className={cn((isLoading || isLoadingMore) && 'animate-spin')} />
          </button>
        </div>

        <form className="yt-sub-form" onSubmit={handleAddSubscription}>
          <input
            value={subscriptionInput}
            onChange={(e) => setSubscriptionInput(e.target.value)}
            placeholder="نام کانال، @handle یا لینک"
            disabled={!canUseProxy || isAdding}
            dir="auto"
          />
          <button type="submit" disabled={!canUseProxy || isAdding || !subscriptionInput.trim()} title="افزودن">
            {isAdding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          </button>
        </form>

        <div className="yt-sub-list">
          {subscriptions.length === 0 ? (
            <div className="yt-empty-mini">برای شروع یک کانال یا عبارت جستجو اضافه کنید.</div>
          ) : (
            <>
              <div
                className={cn('yt-sub-row yt-sub-all', !activeQuery.trim() && activeSourceId == null && 'active')}
                role="button"
                tabIndex={0}
                onClick={() => openSubscriptionFeed(null)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openSubscriptionFeed(null);
                  }
                }}
              >
                <div>
                  <strong>همه کانال‌ها</strong>
                  <span>فید مشترک</span>
                </div>
              </div>
              {subscriptions.map((sub) => (
                <div
                  className={cn('yt-sub-row', !activeQuery.trim() && activeSourceId === sub.id && 'active')}
                  key={sub.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openSubscriptionFeed(sub.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openSubscriptionFeed(sub.id);
                    }
                  }}
                >
                  <div>
                    <strong dir="auto">{sub.label}</strong>
                    <span>{sub.kind === 'channel' ? 'کانال' : 'جستجو'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSubscriptions((prev) => prev.filter((s) => s.id !== sub.id));
                    }}
                    title="حذف"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </aside>

      <div className="yt-main">
        <form className="yt-search" onSubmit={handleSearch}>
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="جستجوی ویدیو"
            disabled={!canUseProxy}
            dir="auto"
          />
          <button type="submit" disabled={!canUseProxy || isLoading}>
            {isLoading ? '...' : 'جستجو'}
          </button>
        </form>

        <div className="yt-feed-mode" dir="rtl">
          <span dir="auto">{activeViewLabel}</span>
          <button type="button" onClick={refreshActiveView} disabled={!canUseProxy || isLoading || isLoadingMore}>
            تازه‌سازی
          </button>
        </div>

        {!canUseProxy ? (
          <div className="yt-state yt-state-warn" dir="rtl">
            <AlertCircle size={18} />
            <div>
              <strong>فید یوتیوب فقط در نسخه دسکتاپ فعال است.</strong>
              <p>برنامه دسکتاپ را اجرا کنید و دوباره وارد این بخش شوید.</p>
            </div>
          </div>
        ) : error ? (
          <div className="yt-state yt-state-warn" dir="rtl">
            <AlertCircle size={18} />
            <div>
              <strong>فید بارگذاری نشد</strong>
              <p>{error}</p>
            </div>
          </div>
        ) : isLoading && items.length === 0 ? (
          <div className="yt-state">
            <Loader2 size={18} className="animate-spin" />
            <span>در حال دریافت ویدیوها...</span>
          </div>
        ) : items.length === 0 ? (
          <div className="yt-state" dir="rtl">
            <span>ویدیویی برای نمایش نیست. جستجو کنید یا کانال اضافه کنید.</span>
          </div>
        ) : (
          <>
            <div className="yt-grid">
              {items.map((item) => {
                const imageSrc = imageForItem(item);
                const hasImagePending = Boolean(item.thumbnailUrl && !imageSrc && !failedImages[item.thumbnailUrl]);
                return (
                  <article
                    className="yt-card"
                    key={itemKey(item)}
                    onClick={() => {
                      markItemSeen(item.videoId);
                      setSelected(item);
                    }}
                  >
                    <div className={cn('yt-thumb', hasImagePending && 'loading')}>
                      {imageSrc ? (
                        <img src={imageSrc} alt="" loading="lazy" />
                      ) : (
                        <div className="yt-thumb-empty">
                          {hasImagePending ? <Loader2 size={20} className="animate-spin" /> : <ImageOff size={20} />}
                        </div>
                      )}
                      {isNewItem(item) && <b className="yt-new-badge">NEW</b>}
                      {item.duration && <span className="yt-duration">{item.duration}</span>}
                    </div>
                    <div className="yt-card-body">
                      <h3 dir="auto">{item.title}</h3>
                      <button
                        type="button"
                        className="yt-channel-link"
                        dir="auto"
                        onClick={(event) => {
                          event.stopPropagation();
                          void openSearchChannel(item);
                        }}
                        disabled={!item.channelId && !item.channelTitle}
                      >
                        {item.channelTitle}
                      </button>
                      <small>{[item.viewCountText, item.publishedAt].filter(Boolean).join(' · ')}</small>
                    </div>
                  </article>
                );
              })}
            </div>
            <div ref={loadMoreRef} className="yt-load-more" dir="rtl">
              {isLoadingMore ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>در حال دریافت ویدیوهای بیشتر...</span>
                </>
              ) : hasMore ? (
                <button type="button" onClick={loadNextPage} disabled={!canUseProxy || isLoading}>
                  نمایش بیشتر
                </button>
              ) : (
                <span>ویدیوی بیشتری پیدا نشد.</span>
              )}
            </div>
          </>
        )}
      </div>

      {selected && (
        <div className="yt-drawer-backdrop" onClick={() => setSelected(null)}>
          <aside className="yt-drawer" onClick={(e) => e.stopPropagation()} dir="rtl">
            <button type="button" className="yt-drawer-close" onClick={() => setSelected(null)} title="بستن">
              <X size={16} />
            </button>
            <div className="yt-drawer-thumb">
              {imageForItem(selected) ? <img src={imageForItem(selected)} alt="" /> : <div><ImageOff size={24} /></div>}
              {isNewItem(selected) && <b className="yt-new-badge">NEW</b>}
            </div>
            <h2 dir="auto">{selected.title}</h2>
            <p dir="auto">{[selected.channelTitle, selected.viewCountText, selected.publishedAt].filter(Boolean).join(' · ')}</p>
            <div className="yt-choice-row">
              {FORMATS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFormat(opt.value)}
                  className={cn(format === opt.value && 'active')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className={cn('yt-choice-row', format === 'mp3' && 'disabled')}>
              {QUALITIES.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setQuality(opt.value)}
                  disabled={format === 'mp3'}
                  className={cn(quality === opt.value && format !== 'mp3' && 'active')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {drawerError && <div className="yt-drawer-error">{drawerError}</div>}
            <button
              type="button"
              className="yt-download-btn"
              onClick={() => void handleDownload()}
              disabled={downloadDisabled}
            >
              {isSubmitting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
              <span>
                {downloadBusy ? 'یک دانلود فعال است' : isSubmitting ? 'در حال ارسال' : 'ارسال برای دانلود'}
              </span>
            </button>
          </aside>
        </div>
      )}
    </section>
  );
}
