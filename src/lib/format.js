export function formatBytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(value); let index = 0;
  while (n >= 1024 && index < units.length - 1) { n /= 1024; index += 1; }
  return `${n.toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function formatSpeed(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '—';
  return `${formatBytes(Number(value))}/s`;
}

export function formatEta(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatDuration(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000);
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function timeAgo(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const delta = Math.max(0, Date.now() - date.getTime());
  if (delta < 60000) return 'Just now';
  if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)}h ago`;
  return date.toLocaleDateString();
}

export function safeHost(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return value || ''; }
}

/** "Downloaded 12.4 MB of 231.0 MB (only the changed parts)" from the updater's transfer stats. */
export function describeTransfer(transfer) {
  if (!transfer || !Number(transfer.totalBytes)) return '';
  const got = formatBytes(transfer.downloadedBytes);
  const total = formatBytes(transfer.totalBytes);
  if (transfer.method === 'delta') return `Downloaded ${got} of ${total} (only the changed parts)`;
  if (transfer.method === 'compressed') return `Downloaded ${got} (compressed full update)`;
  return `Downloaded ${got} (full update)`;
}
