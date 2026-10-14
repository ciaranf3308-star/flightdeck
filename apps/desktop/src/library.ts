/** Client for the flight library API (saved flights + categories). */

export interface SavedFlight {
  id: string;
  flightNumber: string;
  date: string;
  origin: string | null;
  destination: string | null;
  aircraftType: string | null;
  registration: string | null;
  depRunway: string | null;
  arrRunway: string | null;
  cruiseAltitude: number | null;
  routeNames: string[];
  categoryIds: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface SaveFlightInput {
  flightNumber: string;
  date: string;
  origin?: string | null;
  destination?: string | null;
  aircraftType?: string | null;
  registration?: string | null;
  depRunway?: string | null;
  arrRunway?: string | null;
  cruiseAltitude?: number | null;
  routeNames?: string[];
  categoryIds?: string[];
  note?: string;
}

export const CATEGORY_COLORS = [
  "#38bdf8",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#fb7185",
  "#f97316",
  "#94a3b8",
];

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
  return body;
}

export const lib = {
  flights: {
    list: () => req<{ flights: SavedFlight[] }>("/api/library").then((r) => r.flights),
    save: (input: SaveFlightInput) =>
      req<{ flight: SavedFlight }>("/api/library", { method: "POST", body: JSON.stringify(input) }).then(
        (r) => r.flight,
      ),
    update: (id: string, patch: { note?: string; categoryIds?: string[] }) =>
      req<{ flight: SavedFlight }>(`/api/library/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }).then((r) => r.flight),
    remove: (id: string) =>
      req<{ ok: boolean }>(`/api/library/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  categories: {
    list: () =>
      req<{ categories: Category[] }>("/api/library/categories").then((r) => r.categories),
    create: (name: string, color: string) =>
      req<{ category: Category }>("/api/library/categories", {
        method: "POST",
        body: JSON.stringify({ name, color }),
      }).then((r) => r.category),
    update: (id: string, patch: { name?: string; color?: string }) =>
      req<{ category: Category }>(`/api/library/categories/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }).then((r) => r.category),
    remove: (id: string) =>
      req<{ ok: boolean }>(`/api/library/categories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
};

/** Recently looked-up flights, kept in localStorage (not the server). */
export interface RecentLookup {
  flightNumber: string;
  date: string;
  origin: string | null;
  destination: string | null;
  ts: number;
}

const RECENT_KEY = "fd-recent-lookups";

export function getRecentLookups(): RecentLookup[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as RecentLookup[]).slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function pushRecentLookup(entry: Omit<RecentLookup, "ts">): void {
  try {
    const rest = getRecentLookups().filter(
      (r) => !(r.flightNumber === entry.flightNumber && r.date === entry.date),
    );
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ ...entry, ts: Date.now() }, ...rest].slice(0, 8)));
  } catch {
    /* storage unavailable — non-fatal */
  }
}
