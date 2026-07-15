/**
 * Simple in-process pub/sub event bus for streaming server-sent events
 * to the frontend debug bar.
 */

const _subscribers = new Set();

export function subscribe(handler) {
  _subscribers.add(handler);
  return () => _subscribers.delete(handler);
}

export function emit(event) {
  for (const handler of _subscribers) {
    try { handler(event); } catch (_) { /* ignore broken subscribers */ }
  }
}
