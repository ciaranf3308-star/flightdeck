import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { RouteFix, TrackPoint } from "@flightdeck/shared-models";

interface Props {
  fixes: RouteFix[];
  track: TrackPoint[];
  showTrack: boolean;
  originName: string;
  destName: string;
}

/** Dark aviation map: filed route (cyan) + recorded track (amber, toggleable). */
export default function MapView({ fixes, track, showTrack, originName, destName }: Props) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { worldCopyJump: true, zoomControl: true }).setView([50, -30], 4);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);
    // darken tiles slightly for the flight-deck theme
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds: L.LatLngExpression[] = [];

    // Filed route: only fixes with coordinates; gaps shown honestly.
    const withCoords = fixes.filter((f) => f.lat != null && f.lon != null);
    const routeLatLngs = withCoords.map((f) => [f.lat as number, f.lon as number] as L.LatLngExpression);
    if (routeLatLngs.length > 1) {
      L.polyline(routeLatLngs, { color: "#38bdf8", weight: 2.5, opacity: 0.9 }).addTo(layer);
    }
    withCoords.forEach((f) => {
      const isApt = f.type === "origin" || f.type === "destination";
      L.circleMarker([f.lat as number, f.lon as number], {
        radius: isApt ? 7 : 4,
        color: isApt ? "#f5a524" : "#38bdf8",
        fillColor: isApt ? "#f5a524" : "#0b0f14",
        fillOpacity: 1,
        weight: 2,
      })
        .bindTooltip(`<b>${f.name}</b>${f.note ? `<br/>${f.note}` : ""}`, { direction: "top" })
        .addTo(layer);
      bounds.push([f.lat as number, f.lon as number]);
    });
    // Named fixes without coordinates: listed, not plotted.
    const noCoords = fixes.filter((f) => f.lat == null || f.lon == null);

    if (showTrack && track.length > 1) {
      // Coverage gaps (e.g. oceanic ADS-B gaps) break the line — the absence of
      // data is drawn as an absence, never bridged with a straight segment.
      // A gap of 30+ minutes between consecutive points starts a new segment.
      const segments: [number, number][][] = [];
      let current: [number, number][] = [];
      let prevT: number | null = null;
      for (const p of track) {
        const t = p.timestamp ? Date.parse(p.timestamp) : NaN;
        if (prevT != null && Number.isFinite(t) && t - prevT > 30 * 60 * 1000) {
          if (current.length > 1) segments.push(current);
          current = [];
        }
        current.push([p.lat, p.lon]);
        if (Number.isFinite(t)) prevT = t;
      }
      if (current.length > 1) segments.push(current);
      for (const seg of segments) {
        L.polyline(seg, { color: "#f5a524", weight: 2, opacity: 0.75, dashArray: "7 5" }).addTo(layer);
        seg.forEach(([la, lo]) => bounds.push([la, lo]));
      }
    }

    if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds).pad(0.12));
    else map.setView([50, -30], 4);

    // stash for legend rendering
    (layer as unknown as { _noCoords: string[] })._noCoords = noCoords.map((f) => f.name);
  }, [fixes, track, showTrack]);

  const noCoords = fixes.filter((f) => f.lat == null || f.lon == null).map((f) => f.name);

  return (
    <div className="map-wrap">
      <div ref={divRef} style={{ height: 460 }} />
      <div className="map-legend">
        <div><span className="sw" style={{ background: "#38bdf8" }} />Filed route ({originName}–{destName})</div>
        {showTrack && track.length > 0 && (
          <div style={{ marginTop: 4 }}><span className="sw" style={{ background: "#f5a524" }} />Recorded track ({track.length} pts)</div>
        )}
        {noCoords.length > 0 && (
          <div style={{ marginTop: 4 }} className="faint" title="Provider supplied no coordinates for these fixes">
            Not plotted: {noCoords.join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}
