import { useEffect, useMemo, useState } from "react";
import {
  CATEGORY_COLORS,
  getRecentLookups,
  lib,
  type Category,
  type RecentLookup,
  type SavedFlight,
} from "./library";

interface Props {
  onSearch: (flightNumber: string, date: string) => void;
  onOpenSaved: (flight: SavedFlight) => void;
  refreshToken: number;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function HomeView({ onSearch, onOpenSaved, refreshToken }: Props) {
  const [flights, setFlights] = useState<SavedFlight[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCat, setActiveCat] = useState<string | null>(null); // null = all
  const [managing, setManaging] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatColor, setNewCatColor] = useState(CATEGORY_COLORS[0]);
  const [editing, setEditing] = useState<Category | null>(null);
  const [q, setQ] = useState("");
  const [date, setDate] = useState("2026-10-09");
  const [recent] = useState<RecentLookup[]>(() => getRecentLookups());
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [f, c] = await Promise.all([lib.flights.list(), lib.categories.list()]);
      setFlights(f);
      setCategories(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the library.");
    }
  };

  useEffect(() => {
    void reload();
  }, [refreshToken]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of flights) for (const c of f.categoryIds) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  }, [flights]);

  const visible = useMemo(
    () => (activeCat ? flights.filter((f) => f.categoryIds.includes(activeCat)) : flights),
    [flights, activeCat],
  );

  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) onSearch(q.trim().toUpperCase(), date);
  };

  const addCategory = async () => {
    if (!newCatName.trim()) return;
    try {
      await lib.categories.create(newCatName.trim(), newCatColor);
      setNewCatName("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the category.");
    }
  };

  const removeCategory = async (id: string) => {
    if (!window.confirm("Delete this category? Saved flights keep their other categories.")) return;
    await lib.categories.remove(id);
    if (activeCat === id) setActiveCat(null);
    await reload();
  };

  const saveEdit = async () => {
    if (!editing) return;
    await lib.categories.update(editing.id, { name: editing.name, color: editing.color });
    setEditing(null);
    await reload();
  };

  const removeFlight = async (f: SavedFlight) => {
    if (!window.confirm(`Remove ${f.flightNumber} on ${f.date} from the library?`)) return;
    await lib.flights.remove(f.id);
    await reload();
  };

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-kicker">MSFS 2024 · commercial IFR planning</div>
          <h1>Flight<em>Deck</em></h1>
          <p className="hero-sub">
            Look up a real flight, replay its filed route, plan deterministic procedures, and export
            a 2024 EFB flight plan. Save the ones you love and organize them your way.
          </p>
          <form className="hero-search" onSubmit={submitSearch}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Flight number — e.g. EI106"
              aria-label="Flight number"
            />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Flight date"
            />
            <button type="submit">Look up &amp; plan</button>
          </form>
        </div>
      </section>

      {error && <div className="errbox home-err">{error}</div>}

      <section className="home-section">
        <div className="home-section-head">
          <h2>Library</h2>
          <button className="linkbtn" onClick={() => setManaging((m) => !m)}>
            {managing ? "Done" : "Manage categories"}
          </button>
        </div>

        <div className="catchips">
          <button
            className={`catchip${activeCat === null ? " active" : ""}`}
            onClick={() => setActiveCat(null)}
          >
            All flights <span className="count">{flights.length}</span>
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              className={`catchip${activeCat === c.id ? " active" : ""}`}
              onClick={() => setActiveCat(activeCat === c.id ? null : c.id)}
            >
              <span className="dot" style={{ background: c.color }} />
              {c.name} <span className="count">{counts.get(c.id) ?? 0}</span>
            </button>
          ))}
        </div>

        {managing && (
          <div className="catmanager">
            <div className="catadd">
              <input
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="New category name — e.g. Transatlantic"
                maxLength={40}
              />
              <div className="colorrow">
                {CATEGORY_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch${newCatColor === c ? " sel" : ""}`}
                    style={{ background: c }}
                    onClick={() => setNewCatColor(c)}
                    aria-label={`color ${c}`}
                  />
                ))}
              </div>
              <button onClick={addCategory}>Add</button>
            </div>
            <ul className="catlist">
              {categories.map((c) => (
                <li key={c.id}>
                  {editing?.id === c.id ? (
                    <span className="catedit">
                      <input
                        value={editing.name}
                        maxLength={40}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      />
                      <div className="colorrow small">
                        {CATEGORY_COLORS.map((col) => (
                          <button
                            key={col}
                            className={`swatch${editing.color === col ? " sel" : ""}`}
                            style={{ background: col }}
                            onClick={() => setEditing({ ...editing, color: col })}
                            aria-label={`color ${col}`}
                          />
                        ))}
                      </div>
                      <button onClick={saveEdit}>Save</button>
                      <button className="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="catrow">
                      <span className="dot" style={{ background: c.color }} />
                      <span className="catname">{c.name}</span>
                      <span className="count">{counts.get(c.id) ?? 0}</span>
                      <button className="linkbtn" onClick={() => setEditing(c)}>
                        Edit
                      </button>
                      <button className="linkbtn danger" onClick={() => void removeCategory(c.id)}>
                        Delete
                      </button>
                    </span>
                  )}
                </li>
              ))}
              {categories.length === 0 && <li className="muted">No categories yet — add one above.</li>}
            </ul>
          </div>
        )}

        {visible.length === 0 ? (
          <div className="empty-lib">
            {flights.length === 0 ? (
              <>
                <p className="empty-title">No saved flights yet</p>
                <p className="muted">
                  Look up a flight above, plan it, then hit <b>Save flight</b> to keep it here —
                  organized by your own categories.
                </p>
              </>
            ) : (
              <p className="muted">No saved flights in this category yet.</p>
            )}
          </div>
        ) : (
          <div className="flightgrid">
            {visible.map((f) => (
              <article key={f.id} className="flightcard">
                <div className="fc-top">
                  <span className="fc-ident">{f.flightNumber}</span>
                  <span className="fc-date">{fmtDate(f.date)}</span>
                </div>
                <div className="fc-route">
                  {f.origin ?? "???"} <span className="arrow">→</span> {f.destination ?? "???"}
                </div>
                <div className="fc-meta">
                  {[f.aircraftType, f.registration].filter(Boolean).join(" · ") || "Aircraft unknown"}
                </div>
                {(f.depRunway || f.arrRunway) && (
                  <div className="fc-meta">
                    {f.depRunway ?? "?"} <span className="arrow">→</span> {f.arrRunway ?? "?"}
                    {f.cruiseAltitude ? ` · FL${Math.round(f.cruiseAltitude / 100)}` : ""}
                  </div>
                )}
                {f.routeNames.length > 0 && (
                  <div className="fc-routestr">{f.routeNames.slice(0, 8).join(" ")}{f.routeNames.length > 8 ? " …" : ""}</div>
                )}
                {f.note && <div className="fc-note">“{f.note}”</div>}
                <div className="fc-cats">
                  {f.categoryIds.map((id) => {
                    const c = catById.get(id);
                    if (!c) return null;
                    return (
                      <span key={id} className="minichip">
                        <span className="dot" style={{ background: c.color }} />
                        {c.name}
                      </span>
                    );
                  })}
                </div>
                <div className="fc-actions">
                  <button onClick={() => onOpenSaved(f)}>Open &amp; plan</button>
                  <button className="ghost" onClick={() => void removeFlight(f)}>
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {recent.length > 0 && (
        <section className="home-section">
          <h2>Recent lookups</h2>
          <div className="recentrow">
            {recent.map((r) => (
              <button
                key={`${r.flightNumber}-${r.date}`}
                className="recentchip"
                onClick={() => onSearch(r.flightNumber, r.date)}
              >
                <b>{r.flightNumber}</b>
                <span className="muted">{fmtDate(r.date)}</span>
                <span className="muted">
                  {r.origin ?? "?"} → {r.destination ?? "?"}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
