import { logger } from './logger';

export const DEFAULT_INVIDIOUS_INSTANCE = 'https://invidious.tiekoetter.com';
const SUBSCRIPTIONS_STORAGE_KEY = 'cns_youtube_subscriptions_v1';
const SETTINGS_STORAGE_KEY = 'cns_youtube_proxy_settings_v1';

declare global {
  interface Window {
    __TAURI__?: any;
    __TAURI_INVOKE__?: (command: string, payload?: any) => Promise<any>;
  }
}

export interface YouTubeSubscription {
  id: string;
  kind: 'channel' | 'search';
  label: string;
  value: string;
  channelId?: string;
  thumbnail?: string;
  addedAt: string;
}

export interface YouTubeFeedItem {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId?: string;
  thumbnailUrl?: string;
  publishedAt?: string;
  duration?: string;
  viewCountText?: string;
  sourceId?: string;
  url: string;
}

export interface YouTubeProxySettings {
  instance: string;
}

function getTauriInvoke(): ((command: string, payload?: Record<string, unknown>) => Promise<any>) | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.__TAURI__?.core?.invoke === 'function') return window.__TAURI__.core.invoke;
  if (typeof window.__TAURI__?.invoke === 'function') return window.__TAURI__.invoke;
  if (typeof window.__TAURI_INVOKE__ === 'function') return window.__TAURI_INVOKE__;
  if (typeof window.__TAURI__?.tauri?.invoke === 'function') return window.__TAURI__.tauri.invoke;
  return null;
}

export function isYoutubeProxyAvailable(): boolean {
  return getTauriInvoke() != null;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeSettings(raw: unknown): YouTubeProxySettings {
  if (!raw || typeof raw !== 'object') return { instance: DEFAULT_INVIDIOUS_INSTANCE };
  const instance = (raw as Record<string, unknown>).instance;
  return {
    instance: normalizeInstanceInput(instance),
  };
}

function normalizeInstanceInput(raw: unknown): string {
  const normalized = typeof raw === 'string' ? raw.trim() : '';
  const withScheme = normalized && !/^https?:\/\//i.test(normalized) ? `https://${normalized}` : normalized;
  return /^https?:\/\//i.test(withScheme) ? withScheme : DEFAULT_INVIDIOUS_INSTANCE;
}

function normalizeSubscription(raw: unknown): YouTubeSubscription | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.label !== 'string' || typeof o.value !== 'string') return null;
  const kind = o.kind === 'channel' || o.kind === 'search' ? o.kind : 'search';
  return {
    id: o.id,
    kind,
    label: o.label,
    value: o.value,
    channelId: typeof o.channelId === 'string' ? o.channelId : undefined,
    thumbnail: typeof o.thumbnail === 'string' ? o.thumbnail : undefined,
    addedAt: typeof o.addedAt === 'string' ? o.addedAt : new Date().toISOString(),
  };
}

export function loadYoutubeProxySettings(): YouTubeProxySettings {
  try {
    return normalizeSettings(safeParse(localStorage.getItem(SETTINGS_STORAGE_KEY), null));
  } catch {
    return { instance: DEFAULT_INVIDIOUS_INSTANCE };
  }
}

export function saveYoutubeProxySettings(settings: YouTubeProxySettings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
  } catch {
  }
}

export function loadYoutubeSubscriptions(): YouTubeSubscription[] {
  try {
    const raw = safeParse<unknown>(localStorage.getItem(SUBSCRIPTIONS_STORAGE_KEY), []);
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeSubscription).filter((s): s is YouTubeSubscription => s != null);
  } catch {
    return [];
  }
}

export function saveYoutubeSubscriptions(items: YouTubeSubscription[]) {
  try {
    localStorage.setItem(SUBSCRIPTIONS_STORAGE_KEY, JSON.stringify(items.slice(0, 40)));
  } catch {
  }
}

async function invokeProxy<T>(command: string, payload: Record<string, unknown>): Promise<T> {
  const invoke = getTauriInvoke();
  if (!invoke) {
    throw new Error('CNS desktop app is required for this feed.');
  }
  try {
    return (await invoke(command, payload)) as T;
  } catch (err) {
    logger.warn('[YouTubeFeed] command failed', { command, error: err });
    throw err;
  }
}

export async function youtubeProxyHealth(instance: string): Promise<{ ok: boolean; message?: string }> {
  return invokeProxy('yt_proxy_health', { instance: normalizeInstanceInput(instance) });
}

export async function youtubeProxySearch(query: string, instance: string, page?: number): Promise<YouTubeFeedItem[]> {
  return invokeProxy('yt_proxy_search', { query, instance: normalizeInstanceInput(instance), page });
}

export async function youtubeProxyResolveSubscription(input: string, instance: string): Promise<YouTubeSubscription> {
  return invokeProxy('yt_proxy_resolve_subscription', { input, instance: normalizeInstanceInput(instance) });
}

export async function youtubeProxySubscriptionFeed(
  subscriptions: YouTubeSubscription[],
  instance: string,
  page?: number,
): Promise<YouTubeFeedItem[]> {
  return invokeProxy('yt_proxy_subscription_feed', { subscriptions, instance: normalizeInstanceInput(instance), page });
}

export async function youtubeProxyImage(url: string, instance: string): Promise<string> {
  return invokeProxy('yt_proxy_image', { url, instance: normalizeInstanceInput(instance) });
}
