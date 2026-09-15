import os from 'node:os';
import si from 'systeminformation';

export async function getSystemHealth() {
  const [load, memory, disk, network] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats()
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
