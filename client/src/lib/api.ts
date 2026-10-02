import { useEffect, useRef, useState } from "react";

const TOKEN_KEY = "meadow-session-token";

/** The daemon prints a URL with ?token=…; keep it for this browser and strip it from the address bar. */
export function initToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  return localStorage.getItem(TOKEN_KEY);
}

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";

const unauthorizedListeners = new Set<() => void>();
let unauthorized = false;

export function markUnauthorized() {
  unauthorized = true;
  unauthorizedListeners.forEach(listener => listener());
}

/** True once the daemon has rejected our token (it rotates on every `meadow start`). */
export function useUnauthorized(): boolean {
  const [value, setValue] = useState(unauthorized);
  useEffect(() => {
    const listener = () => setValue(true);
    unauthorizedListeners.add(listener);
    return () => void unauthorizedListeners.delete(listener);
  }, []);
  return value;
}

export function saveToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token.trim());
  window.location.reload();
}

export const screenshotUrl = (id: number) => `/api/screenshots/${id}?token=${encodeURIComponent(getToken())}`;

export type LiveEvent = { id: number; projectId: number | null; type: string; title: string; detail: string; ts: string; payload?: Record<string, unknown> };

/** Server-Sent Events with automatic reconnect; the browser resends Last-Event-ID so nothing is missed. */
export function useLiveEvents(onEvent: (event: LiveEvent) => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const latest = Number(sessionStorage.getItem("meadow-last-event") ?? 0);
    const source = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}&after=${latest}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = message => {
      try {
        const event = JSON.parse(message.data) as LiveEvent;
        sessionStorage.setItem("meadow-last-event", String(event.id));
        handler.current(event);
      } catch {
        // Ignore malformed frames.
      }
    };
    return () => source.close();
  }, []);
  return connected;
}

export function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
