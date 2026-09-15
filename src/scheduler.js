import { runMaintenanceUpdate } from './jobManager.js';

function msUntilNext(hour, minute) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Schedules a daily maintenance update (yt-dlp -U / deno upgrade) at the
 * given local hour:minute (defaults to 03:00). Returns a function that
 * cancels the schedule.
 */
export function scheduleDailyMaintenance(hour = 3, minute = 0) {
  let timer = null;
  let cancelled = false;

  const runAndReschedule = async () => {
    try {
      await runMaintenanceUpdate();
    } catch (error) {
      console.error('Scheduled maintenance update failed:', error.message);
    } finally {
      if (!cancelled) {
        scheduleNext();
      }
    }
  };

  function scheduleNext() {
    const delay = msUntilNext(hour, minute);
    timer = setTimeout(runAndReschedule, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  scheduleNext();

  return function cancel() {
    cancelled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
