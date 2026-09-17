import os from 'node:os';
import si from 'systeminformation';

export async function getTranscriptionHealth() {
  const endpoint = process.env.TRANSCRIPTION_ENDPOINT?.trim();
  if (!endpoint) {
    return { status: 'not_configured', message: 'TRANSCRIPTION_ENDPOINT is not configured' };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(2000)
    });
    await response.body?.cancel();
    if (response.ok || response.status === 405) {
      return { status: 'active', message: 'Endpoint reachable; transcription readiness not verified' };
    }
    return { status: 'error', message: `Endpoint returned HTTP ${response.status}` };
  } catch (error) {
    return {
      status: 'unreachable',
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
