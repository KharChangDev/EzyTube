import { useCallback, useEffect, useRef, useState } from 'react';
import { Settings, AlertCircle, X, DownloadCloud, Youtube } from 'lucide-react';
import { fa } from './lib/i18n';
import { github, DownloadJob } from './lib/github';
import { logger } from './lib/logger';
import { cn } from './lib/utils';
import { InputNode } from './components/InputNode';
import { SignalFeed } from './components/SignalFeed';
import { YouTubeFeed } from './components/YouTubeFeed';
import { SettingsModal } from './components/SettingsModal';
import { MatrixRain } from './components/MatrixRain';
import { AsciiLogo } from './components/AsciiLogo';
import { useArchive } from './lib/useArchive';
import { toPersianErrorMessage } from './lib/errors';
import { subscribeUserToast } from './lib/userToast';

const JOBS_STORAGE_KEY = 'cns_download_jobs';
const APP_MODE_STORAGE_KEY = 'cns_app_mode';
const MAX_STORED_JOBS = 30;
const MAX_STORED_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type AppMode = 'console' | 'youtube-feed';

function loadStoredAppMode(): AppMode {
  try {
    return localStorage.getItem(APP_MODE_STORAGE_KEY) === 'youtube-feed'
      ? 'youtube-feed'
      : 'console';
  } catch {
    return 'console';
  }
}

function saveStoredAppMode(mode: AppMode) {
  try {
    localStorage.setItem(APP_MODE_STORAGE_KEY, mode);
  } catch {
  }
}

function loadStoredJobs(): DownloadJob[] {
  try {
    const raw = localStorage.getItem(JOBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .filter((job): job is DownloadJob => {
        if (!job || typeof job !== 'object') return false;
        if (typeof job.id !== 'string' || typeof job.url !== 'string') return false;
        if (!['pending', 'running', 'success', 'failed'].includes(job.status)) return false;
        const createdAt = new Date(job.createdAt).getTime();
        return Number.isFinite(createdAt) && now - createdAt <= MAX_STORED_JOB_AGE_MS;
      })
      .slice(0, MAX_STORED_JOBS);
  } catch {
    return [];
  }
}

function saveStoredJobs(jobs: DownloadJob[]) {
  try {
    localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(jobs.slice(0, MAX_STORED_JOBS)));
  } catch {
  }
}

function summarizeJobsForSupport(jobs: DownloadJob[]) {
  return jobs.slice(0, 25).map((j) => ({
    id: j.id,
    status: j.status,
    format: j.format,
    quality: j.quality,
    advanced: j.advanced ?? null,
    url: j.url,
    githubRunId: j.githubRunId ?? null,
    githubLiveStep: j.githubLiveStep ?? null,
    createdAt: j.createdAt,
    lastUserLog: j.logs.length ? j.logs[j.logs.length - 1].slice(0, 800) : null,
  }));
}

function App() {
  const [jobs, setJobs] = useState<DownloadJob[]>(loadStoredJobs);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [appMode, setAppMode] = useState<AppMode>(loadStoredAppMode);
  const [hasConfig, setHasConfig] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; variant: 'error' | 'info' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const jobsRef = useRef(jobs);
  const persistTimerRef = useRef<number | null>(null);
  jobsRef.current = jobs;

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current != null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  }, []);

  useEffect(() => {
    return subscribeUserToast(({ message, variant }) => {
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
      setToast({ message, variant });
      toastTimerRef.current = window.setTimeout(() => {
        setToast(null);
        toastTimerRef.current = null;
      }, 16000);
    });
  }, []);

  const archive = useArchive({ enabled: hasConfig });
  const isYoutubeFeedMode = appMode === 'youtube-feed';

  useEffect(() => {
    saveStoredAppMode(appMode);
  }, [appMode]);

  useEffect(() => {
    logger.registerSupportContext(() => ({
      github: github.getSupportSnapshot(),
      recentJobs: summarizeJobsForSupport(jobsRef.current),
    }));
  }, []);

  useEffect(() => {
    logger.info('App startup: config initialization start');
    let cancelled = false;
    const run = async () => {
      try {
        await github.hydrateSecureConfig();
        const config = github.getConfig();
        const configAvailable = !!config;
        if (cancelled) return;
        setHasConfig(configAvailable);
        logger.info('App startup: config initialization complete', {
          hasConfig: configAvailable,
          repositoryFullName: config ? `${config.owner}/${config.repo}` : null,
        });
      } catch (err) {
        const msg = toPersianErrorMessage(err);
        logger.error('App startup: config check failed', { error: msg });
        if (cancelled) return;
        setInitError(msg);
        setHasConfig(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasConfig) {
      setNetworkError(null);
      return;
    }
    let cancelled = false;
    const check = async () => {
      const r = await github.probeNetwork();
      if (cancelled) return;
      if (r.ok || r.code === 'AUTH') {
        setNetworkError(null);
        return;
      }
      setNetworkError('اتصال برنامه به GitHub قطع است. احتمال فایروال/ DNS (مثل svchost) یا پروکسی نادرست.');
    };
    const onOnline = () => {
      void check();
    };
    const onOffline = () => {
      if (cancelled) return;
      setNetworkError('اتصال برنامه به GitHub قطع است. احتمال فایروال/ DNS (مثل svchost) یا پروکسی نادرست.');
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    };
    void check();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    }, 300000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hasConfig]);

  useEffect(() => {
    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      saveStoredJobs(jobs);
    }, 300);
    return () => {
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [jobs]);

  const handleAddPendingJob = useCallback((newJob: DownloadJob) => {
    if (jobsRef.current.some((j) => j.status === 'pending' || j.status === 'running')) {
      return;
    }
    setJobs((prev) => [newJob, ...prev]);
    window.dispatchEvent(new CustomEvent('cns-matrix-burst'));
  }, []);

  const handlePatchJob = useCallback((jobId: string, updates: Partial<DownloadJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...updates } : j)));
  }, []);

  const handleJobUpdate = useCallback(
    (jobId: string, updates: Partial<DownloadJob>) => {
      setJobs((prev) => {
        const job = prev.find((j) => j.id === jobId);
        if (job && (job.status === 'failed' || job.status === 'success')) {
          return prev;
        }
        return prev.map((j) => (j.id === jobId ? { ...j, ...updates } : j));
      });
    },
    []
  );

  const handleJobRemove = useCallback((jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, []);

  const downloadBusy = jobs.some(
    (j) => j.status === 'pending' || j.status === 'running'
  );

  return (
    <div className="min-h-screen bg-cns-bg p-4 text-cns-primary md:p-6 pb-16" dir="ltr">
      <div className="green-tint" />
      <MatrixRain />
      <div className="shell-grid" />
      <div className="shell-glow" />

      {!isYoutubeFeedMode && (
        <aside className="cookie-warning" dir="rtl">
          <AlertCircle size={15} />
          <div>
            <strong>یادآوری کوکی یوتیوب</strong>
            <p>
              یوتیوب هر چند ساعت کوکی‌ها را عوض می‌کند. اگر دانلود گیر کرد یا خطا داد،
              کوکی‌های جدید را از مرورگر بگیرید و دوباره در تنظیمات وارد کنید.
            </p>
          </div>
        </aside>
      )}

      <div className={cn('app-shell relative z-10 mx-auto', isYoutubeFeedMode && 'feed-mode')}>
        <header className="reclip-header">
          {!isYoutubeFeedMode && <AsciiLogo />}
          <div className="app-top-controls">
            {!hasConfig && !initError && (
              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                className="settings-notice-chip"
                title="تنظیمات لازم است"
              >
                <AlertCircle size={13} />
                <span>تنظیمات لازم است</span>
              </button>
            )}
            <div className="app-mode-switch" role="tablist" aria-label="حالت برنامه">
              <button
                type="button"
                onClick={() => setAppMode('console')}
                className={cn('app-mode-btn', appMode === 'console' && 'active')}
                aria-pressed={appMode === 'console'}
              >
                <DownloadCloud size={15} />
                <span>کنسول</span>
              </button>
              <button
                type="button"
                onClick={() => setAppMode('youtube-feed')}
                className={cn('app-mode-btn', isYoutubeFeedMode && 'active')}
                aria-pressed={isYoutubeFeedMode}
              >
                <Youtube size={15} />
                <span>فید یوتیوب</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className={cn('settings-cog', !hasConfig && 'warn')}
              aria-label={fa.actions.settings}
              title={fa.actions.settings}
            >
              <Settings size={16} />
              <span>تنظیمات</span>
            </button>
          </div>
        </header>

        {initError && (
          <div className="mb-4 p-3 border border-cns-warning/50 bg-cns-warning/10 rounded-sm">
            <div className="flex items-center gap-2 text-cns-warning text-sm" dir="auto">
              <AlertCircle size={14} />
              <span>خطای راه‌اندازی: {initError}</span>
            </div>
          </div>
        )}

        {networkError && (
          <div className="mb-4 p-3 border border-cns-warning/50 bg-cns-warning/10 rounded-sm">
            <div className="flex items-center gap-2 text-cns-warning text-sm" dir="auto">
              <AlertCircle size={14} />
              <span>{networkError}</span>
            </div>
          </div>
        )}

        {isYoutubeFeedMode ? (
          <YouTubeFeed
            onAddPending={handleAddPendingJob}
            onPatchJob={handlePatchJob}
            hasConfig={hasConfig}
            networkError={networkError}
            downloadBusy={downloadBusy}
            archiveItems={archive.items}
          />
        ) : (
          <InputNode
            onAddPending={handleAddPendingJob}
            onPatchJob={handlePatchJob}
            hasActiveJob={downloadBusy}
            disabled={!hasConfig || !!networkError}
            downloadBusy={downloadBusy}
            archiveItems={archive.items}
          />
        )}

        {(!isYoutubeFeedMode || jobs.length > 0 || archive.items.length > 0) && (
          <SignalFeed
            jobs={jobs}
            onUpdate={handleJobUpdate}
            onRemoveJob={handleJobRemove}
            archive={archive}
          />
        )}
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => {
          setIsSettingsOpen(false);
          setHasConfig(!!github.getConfig());
        }}
        onConfigChanged={() => setHasConfig(!!github.getConfig())}
      />

      {toast && (
        <div
          className="fixed inset-x-3 bottom-4 z-[20050] max-w-lg mx-auto pointer-events-auto"
          role="status"
          aria-live="polite"
        >
          <div
            className={cn(
              'flex gap-2 items-start rounded-md border px-3 py-2.5 shadow-lg backdrop-blur-sm',
              toast.variant === 'error'
                ? 'border-cns-warning/55 bg-black/88 text-cns-warning'
                : 'border-cns-line bg-black/88 text-cns-text-bright'
            )}
          >
            <p className="flex-1 text-sm leading-relaxed whitespace-pre-line pt-0.5" dir="auto">
              {toast.message}
            </p>
            <button
              type="button"
              onClick={dismissToast}
              className="shrink-0 p-1 rounded opacity-80 hover:opacity-100 hover:bg-white/10"
              aria-label="بستن"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
