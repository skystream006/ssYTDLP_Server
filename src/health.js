import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import si from 'systeminformation';
import { isPlayableFile } from './media.js';

export async function countMediaFiles(jobs) {
  const files = new Set();
  for (const job of jobs) {
    if (!job.outputDir) continue;
    for (const name of job.files || []) {
      if (typeof name !== 'string' || !isPlayableFile(name)) continue;
      const filePath = path.resolve(job.outputDir, name);
      const relative = path.relative(job.outputDir, filePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      files.add(process.platform === 'win32' ? filePath.toLowerCase() : filePath);
    }
  }
  let total = 0;
  for (const filePath of files) {
    try {
      if ((await fs.lstat(filePath)).isFile()) total += 1;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  return total;
}

export function createMediaCountMonitor(scan) {
  let state = { totalFiles: null, scannedAt: null, scanning: false, error: null };
  async function refresh() {
    if (state.scanning) return;
    state = { ...state, scanning: true };
    try {
      const totalFiles = await scan();
      state = { totalFiles, scannedAt: new Date().toISOString(), scanning: false, error: null };
    } catch {
      state = { ...state, scanning: false, error: 'Media count scan failed' };
    }
  }
  const ready = refresh();
  const timer = setInterval(refresh, 60 * 60 * 1000);
  timer.unref?.();
  return { ready, getStatus: () => ({ ...state }), stop: () => clearInterval(timer) };
}

export async function getTranscriptionHealth() {
  const endpoint = process.env.TRANSCRIPTION_ENDPOINT?.trim();
  if (!endpoint) {
    return { status: 'inactive', message: 'TRANSCRIPTION_ENDPOINT is not configured' };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(2000)
    });
    await response.body?.cancel();
    return { status: 'active', message: `Endpoint returned HTTP ${response.status}` };
  } catch (error) {
    return {
      status: 'inactive',
      message: error.name === 'TimeoutError' ? 'Endpoint timed out after 2 seconds' : 'Unable to connect to endpoint'
    };
  }
}

export async function getSystemHealth() {
  const [load, memory, disk, network, transcription] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
    getTranscriptionHealth()
  ]);

  const diskTotals = disk.reduce(
    (acc, item) => {
      acc.total += item.size;
      acc.free += item.available;
      return acc;
    },
    { total: 0, free: 0 }
  );

  const networkTotals = network.reduce(
    (acc, item) => {
      acc.rxBytes += item.rx_bytes;
      acc.txBytes += item.tx_bytes;
      acc.rxSec += item.rx_sec;
      acc.txSec += item.tx_sec;
      return acc;
    },
    { rxBytes: 0, txBytes: 0, rxSec: 0, txSec: 0 }
  );

  return {
    hostname: os.hostname(),
    transcription,
    cpu: {
      usagePercent: load.currentLoad
    },
    memory: {
      totalBytes: memory.total,
      usedBytes: memory.active,
      freeBytes: memory.available
    },
    network: networkTotals,
    storage: {
      totalBytes: diskTotals.total,
      freeBytes: diskTotals.free
    },
    timestamp: new Date().toISOString()
  };
}
