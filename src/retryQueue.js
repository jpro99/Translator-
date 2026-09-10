const QUEUE_KEY = 'tr_retry_queue';

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(items) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-50)));
  } catch {}
}

export function enqueueRetry(item) {
  const q = readQueue();
  q.push({ ...item, at: Date.now() });
  writeQueue(q);
}

export function dequeueRetry(id) {
  const q = readQueue().filter((x) => x.id !== id);
  writeQueue(q);
}

export function listRetries() {
  return readQueue();
}

export function onOnlineRetry(handler) {
  const run = () => {
    if (!navigator.onLine) return;
    const items = readQueue();
    if (!items.length) return;
    items.forEach((item) => handler(item));
    writeQueue([]);
  };
  window.addEventListener('online', run);
  return () => window.removeEventListener('online', run);
}
