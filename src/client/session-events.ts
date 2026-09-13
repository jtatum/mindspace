type SessionEventSource = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { close: () => void };

type SessionEventsOptions<T> = {
  sessionId: string;
  getCursor: () => number;
  fetchSnapshot: (signal: AbortSignal) => Promise<T>;
  receiveSnapshot: (snapshot: T) => void;
  setConnected: (connected: boolean) => void;
  isCurrent: () => boolean;
  createEventSource?: (url: string) => SessionEventSource;
};

export function subscribeSessionEvents<T>({ sessionId, getCursor, fetchSnapshot, receiveSnapshot, setConnected, isCurrent, createEventSource = url => new EventSource(url) }: SessionEventsOptions<T>) {
  let disposed = false;
  let source: SessionEventSource | undefined;
  let detachSource: (() => void) | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let dirty = false;
  let retryDelay = 1000;
  const active = () => !disposed && isCurrent();

  function closeSource() {
    const previous = source;
    source = undefined;
    detachSource?.(); detachSource = undefined;
    previous?.close();
  }

  function recover() {
    if (!active()) return;
    setConnected(false);
    closeSource();
    clearTimeout(refreshTimer); refreshTimer = undefined;
    request?.abort(); request = undefined;
    dirty = false;
    if (retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (active()) void loadSnapshot(true);
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }

  async function loadSnapshot(reconnect: boolean) {
    const controller = new AbortController();
    request = controller;
    dirty = false;
    try {
      const value = await fetchSnapshot(controller.signal);
      if (!active() || request !== controller) return;
      receiveSnapshot(value);
      // The bearer-authenticated snapshot renews the cookie used by native SSE.
      // Only the stream's open event confirms that live updates are connected.
      if (reconnect) openSource();
    } catch {
      if (active() && request === controller) recover();
    } finally {
      if (request === controller) {
        request = undefined;
        if (active() && dirty) refresh();
      }
    }
  }

  function refresh() {
    if (!active() || !source) return;
    dirty = true;
    if (request || refreshTimer !== undefined) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (active() && source) void loadSnapshot(false);
    }, 100);
  }

  function openSource() {
    if (!active()) return;
    try {
      const stream = createEventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events?after=${getCursor()}`);
      source = stream;
      const current = () => active() && source === stream;
      const onOpen = () => { if (current()) { retryDelay = 1000; setConnected(true); refresh(); } };
      const onError = () => { if (current()) recover(); };
      const onUpdate = () => { if (current()) refresh(); };
      stream.addEventListener('open', onOpen);
      stream.addEventListener('error', onError);
      stream.addEventListener('update', onUpdate);
      stream.addEventListener('message', onUpdate);
      detachSource = () => {
        stream.removeEventListener('open', onOpen);
        stream.removeEventListener('error', onError);
        stream.removeEventListener('update', onUpdate);
        stream.removeEventListener('message', onUpdate);
      };
    } catch { recover(); }
  }

  if (active()) setConnected(false);
  openSource();
  return () => {
    disposed = true;
    closeSource();
    clearTimeout(refreshTimer);
    clearTimeout(retryTimer);
    request?.abort(); request = undefined;
  };
}
