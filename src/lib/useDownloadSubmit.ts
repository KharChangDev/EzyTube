import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DownloadJob,
  github,
  DEFAULT_DOWNLOAD_ADVANCED,
  type DownloadAdvancedOptions,
  type DownloadSource,
} from './github';
import { toPersianErrorMessage } from './errors';
import { logger } from './logger';

const COOKIE_HASH_KEY = 'cns_cookie_hash_v1';

function urlContentKey(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0] || '';
      return id ? `yt:${id}` : `url:${u.origin}${u.pathname}${u.search}`;
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v') || '';
        if (v) return `yt:${v}`;
      }
      const p = u.pathname.split('/').filter(Boolean);
      if (p[0] === 'shorts' && p[1]) return `yt:${p[1]}`;
      if (p[0] === 'live' && p[1]) return `yt:${p[1]}`;
    }
    u.hash = '';
    return `url:${u.toString()}`;
  } catch {
    return `raw:${raw.trim()}`;
  }
}

async function fetchOembed(url: string): Promise<DownloadJob['meta']> {
  try {
    const resp = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
    if (!resp.ok) return undefined;
    const data = await resp.json();
    if (data?.error) return undefined;
    return {
      title: data.title,
      channel: data.author_name,
      thumbnail: data.thumbnail_url,
    };
  } catch {
    return undefined;
  }
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function advancedSubmitKey(a: DownloadAdvancedOptions): string {
  return `${a.container}|${a.codec}|${a.bitrate}`;
}

type SubmitDownloadArgs = {
  url: string;
  quality: string;
  format: string;
  source?: DownloadSource;
  advanced?: DownloadAdvancedOptions;
  archiveItems?: Array<{ metadata?: { original_url?: string } | undefined }>;
};

type SubmitDownloadHandlers = {
  onAddPending: (job: DownloadJob) => void;
  onPatchJob: (jobId: string, updates: Partial<DownloadJob>) => void;
};

export function useDownloadSubmit({ onAddPending, onPatchJob }: SubmitDownloadHandlers) {
  const inFlightRef = useRef(new Set<string>());
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitDownload = useCallback(
    async ({ url, quality, format, source = 'youtube', advanced = DEFAULT_DOWNLOAD_ADVANCED, archiveItems = [] }: SubmitDownloadArgs) => {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        throw new Error('یک لینک معتبر وارد کنید');
      }

      const currentKey = urlContentKey(normalizedUrl);
      const exists = archiveItems.some((a) => {
        const original = a.metadata?.original_url;
        if (!original) return false;
        return urlContentKey(original) === currentKey;
      });
      if (exists) {
        throw new Error('این ویدیو قبلا دانلود شده و داخل آرشیو موجود است.');
      }

      const config = github.getConfig();
      if (!config) {
        throw new Error('توکن گیت‌هاب تنظیم نشده است');
      }

      const effectiveQuality = quality;
      const effectiveFormat = format;
      const submitKey = `${source}|${normalizedUrl}|${effectiveQuality}|${effectiveFormat}|${advancedSubmitKey(advanced)}`;
      if (inFlightRef.current.has(submitKey)) {
        throw new Error('این درخواست هم‌اکنون در حال ارسال است.');
      }
      inFlightRef.current.add(submitKey);

      setIsSubmitting(true);
      try {
        const net = await github.probeNetwork();
        if (!net.ok) {
          if (net.code === 'AUTH') {
            throw new Error('توکن گیت‌هاب رد شد (۴۰۱). در تنظیمات دوباره ذخیره کنید.');
          }
          throw new Error('اتصال شبکه به GitHub برقرار نیست. فایروال/ DNS یا پروکسی سیستم را بررسی کنید.');
        }

        logger.info('[Download] Submit started', { source, format, quality, advanced });
        const cookieHealth = github.assessStoredCookies();
        if (!cookieHealth.ok) {
          throw new Error(cookieHealth.reason || 'COOKIE_EXPIRED_LOCAL');
        }
        const cookies = github.getCookies();
        if (cookies) {
          const cookieHash = await sha1Hex(cookies);
          const uploadedHash = sessionStorage.getItem(COOKIE_HASH_KEY);
          if (uploadedHash !== cookieHash) {
            await github.uploadCookies(cookies);
            sessionStorage.setItem(COOKIE_HASH_KEY, cookieHash);
          }
        }

        const nowIso = new Date().toISOString();
        const jobId = crypto.randomUUID();
        const baseJob: DownloadJob = {
          id: jobId,
          url: normalizedUrl,
          source,
          quality: effectiveQuality,
          format: effectiveFormat,
          advanced: { ...advanced },
          status: 'pending',
          progress: 0,
          logs: [`[${new Date().toLocaleTimeString('fa-IR')}] صف شد`],
          createdAt: nowIso,
          submitKey,
        };
        onAddPending(baseJob);

        const metaTask = source === 'youtube' ? fetchOembed(normalizedUrl) : Promise.resolve<DownloadJob['meta']>(undefined);
        try {
          const dispatch = await github.triggerWorkflowFast(normalizedUrl, effectiveQuality, effectiveFormat, advanced, source);
          const fetchedMeta = await metaTask.catch(() => undefined);
          const logs = [`[${new Date().toLocaleTimeString('fa-IR')}] صف شد`, `[${new Date().toLocaleTimeString('fa-IR')}] ارسال به گیت‌هاب انجام شد`];
          onPatchJob(jobId, {
            dispatchAt: dispatch.dispatchAt,
            runHint: dispatch.runHint,
            logs,
            meta: fetchedMeta,
          });
          logger.info('[Download] Workflow dispatched', { source, format: effectiveFormat, quality: effectiveQuality, advanced });
          return { jobId, dispatchAt: dispatch.dispatchAt };
        } catch (err) {
          logger.error('[Download] Dispatch failed', { error: err, source, format: effectiveFormat, quality: effectiveQuality });
          const message = toPersianErrorMessage(err);
          const fetchedMeta = await metaTask.catch(() => undefined);
          onPatchJob(jobId, {
            status: 'failed',
            progress: 0,
            logs: [`[${new Date().toLocaleTimeString('fa-IR')}] صف شد`, `[${new Date().toLocaleTimeString('fa-IR')}] ${message}`],
            meta: fetchedMeta,
          });
          throw err instanceof Error ? err : new Error(message);
        }
      } catch (err) {
        logger.error('[Download] Submit aborted', { error: err });
        throw err;
      } finally {
        inFlightRef.current.delete(submitKey);
        setIsSubmitting(false);
      }
    },
    [onAddPending, onPatchJob]
  );

  return useMemo(
    () => ({
      submitDownload,
      isSubmitting,
    }),
    [submitDownload, isSubmitting]
  );
}
