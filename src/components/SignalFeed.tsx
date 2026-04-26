import { useEffect, useRef } from 'react';
import { Terminal, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { fa } from '../lib/i18n';
import { DownloadJob, github } from '../lib/github';
import { cn } from '../lib/utils';

interface SignalFeedProps {
  jobs: DownloadJob[];
  onUpdate: (jobId: string, updates: Partial<DownloadJob>) => void;
}

const STATUS_ICONS = {
  pending: Terminal,
  running: Loader2,
  success: CheckCircle,
  failed: XCircle,
};

const STATUS_COLORS = {
  pending: 'text-cns-deep',
  running: 'text-cns-primary animate-pulse-signal',
  success: 'text-cns-highlight',
  failed: 'text-cns-warning',
};

export function SignalFeed({ jobs, onUpdate }: SignalFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const formatTime = (value: string) =>
    new Date(value).toLocaleTimeString('fa-IR', {
      hour: '2-digit',
      minute: '2-digit',
    });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [jobs]);

  useEffect(() => {
    const pollJobs = async () => {
      const runningJobs = jobs.filter(j => j.status === 'pending' || j.status === 'running');

      if (runningJobs.length === 0) return;

      try {
        const runs = await github.getWorkflowRuns();

        for (const job of runningJobs) {
          const matchingRun = runs.find((run: any) => {
            const runTime = new Date(run.created_at).getTime();
            const jobTime = new Date(job.createdAt).getTime();
            return Math.abs(runTime - jobTime) < 60000;
          });

          if (matchingRun) {
            const status = matchingRun.status === 'completed'
              ? (matchingRun.conclusion === 'success' ? 'success' : 'failed')
              : 'running';

            if (status !== job.status) {
              const logs = [...job.logs];
              if (status === 'running' && job.status === 'pending') {
                logs.push(`[${new Date().toLocaleTimeString('fa-IR')}] ${fa.feed.downloading}`);
              } else if (status === 'success') {
                logs.push(`[${new Date().toLocaleTimeString('fa-IR')}] ${fa.feed.complete}`);
              } else if (status === 'failed') {
                logs.push(`[${new Date().toLocaleTimeString('fa-IR')}] ${fa.feed.error}`);
              }

              onUpdate(job.id, {
                status,
                logs,
                progress: status === 'success' ? 100 : job.progress,
              });
            }
          }
        }
      } catch {
        // Silently handle polling errors
      }
    };

    const interval = setInterval(pollJobs, 5000);
    pollJobs();

    return () => clearInterval(interval);
  }, [jobs, onUpdate]);

  if (jobs.length === 0) {
    return (
      <div className="empty-state h-full">
        <div className="text-center">
          <Terminal size={34} className="mx-auto mb-3 opacity-60" />
          <div className="text-sm text-cns-primary" dir="rtl">{fa.feed.waiting}</div>
          <div className="helper-copy mt-2 max-w-[26rem]" dir="rtl">
            اولین عملیات را از ستون ورودی شروع کنید تا لاگ‌های اجرای workflow در این پنجره ظاهر شوند.
          </div>
          <div className="mt-3 text-[10px] opacity-50" dir="ltr">SYSTEM_STANDBY</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full max-h-[560px] overflow-y-auto space-y-3 pr-1">
      {jobs.map((job) => {
        const StatusIcon = STATUS_ICONS[job.status];
        const compactUrl = job.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
        const displayUrl = compactUrl.length > 42 ? `${compactUrl.slice(0, 42)}...` : compactUrl;
        const isIndeterminate =
          job.status !== 'success' && job.status !== 'failed' && job.progress === 0;

        return (
          <article
            key={job.id}
            className={cn(
              "signal-card",
              job.status === 'running' && "running",
              job.status === 'failed' && "failed",
              job.status === 'success' && "success"
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2 text-[10px] text-cns-deep">
                  <StatusIcon
                    size={14}
                    className={cn(
                      STATUS_COLORS[job.status],
                      job.status === 'running' && 'animate-spin'
                    )}
                  />
                  <span dir="rtl">{formatTime(job.createdAt)}</span>
                </div>
                <div
                  dir="ltr"
                  className="truncate text-left font-mono text-[11px] text-cns-highlight"
                >
                  {displayUrl}
                </div>
              </div>
              <span className={cn(
                "system-flag whitespace-nowrap",
                job.status === 'success' && 'border-cns-highlight text-cns-highlight',
                job.status === 'failed' && 'border-cns-warning text-cns-warning'
              )} dir="rtl">
                {fa.status[job.status]}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-cns-deep">
              <span className="system-flag" dir="ltr">{job.quality}</span>
              <span className="system-flag" dir="ltr">{job.format.toUpperCase()}</span>
            </div>

            {job.status !== 'success' && job.status !== 'failed' && (
              <div className={cn("capacity-meter mt-3", isIndeterminate && "indeterminate")}>
                <div
                  className="fill"
                  style={isIndeterminate ? undefined : { width: `${job.progress}%` }}
                />
              </div>
            )}

            <div className="log-surface mt-3">
              {job.logs.map((log, i) => (
                <div
                  key={i}
                  className={cn(
                    "log-entry",
                    log.includes('ERROR') && 'error',
                    log.includes('موفق') && 'success'
                  )}
                >
                  {log}
                </div>
              ))}
              {job.status === 'running' && (
                <div className="log-entry cursor-blink text-cns-primary" dir="ltr">stream active</div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
