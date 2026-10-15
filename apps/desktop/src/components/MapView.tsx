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
    // Esri World Dark Gray — free, no API key (CARTO now requires one).
    // Note the {z}/{y}/{x} order Esri uses.
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
      maxZoom: 16,
    }).addTo(map);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 16,
    }).addTo(map);
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
      // Halo under the core line for a soft glow.
      L.polyline(routeLatLngs, { color: "#7dd3fc", weight: 9, opacity: 0.16 }).addTo(layer);
      L.polyline(routeLatLngs, { color: "#7dd3fc", weight: 3, opacity: 0.95 }).addTo(layer);
    }
    const aptIcon = (icao: string, stage: number) =>
      L.divIcon({
        className: "fd-apt-marker",
        html: `<span class="fd-apt-dot">${stage}</span><span class="fd-apt-label">${icao}</span>`,
        iconSize: [0, 0],
      });
    const stageIcon = (n: number) =>
      L.divIcon({
        className: "fd-stage-marker",
        html: `<span class="fd-stage-num">${n}</span>`,
        iconSize: [0, 0],
      });
    withCoords.forEach((f) => {
      const isApt = f.type === "origin" || f.type === "destination";
      if (isApt) {
        const stage = f.type === "origin" ? 1 : 3;
        L.marker([f.lat as number, f.lon as number], { icon: aptIcon(f.name, stage), interactive: true })
          .bindTooltip(`<b>${f.name}</b> — stage ${stage}${f.note ? `<br/>${f.note}` : ""}`, {
            direction: "top",
            className: "fd-tip",
            offset: [0, -14],
          })
          .addTo(layer);
      } else {
        L.circleMarker([f.lat as number, f.lon as number], {
          radius: 4,
          color: "#7dd3fc",
          fillColor: "#0c0a07",
          fillOpacity: 1,
          weight: 2,
        })
          .bindTooltip(`<b>${f.name}</b>${f.note ? `<br/>${f.note}` : ""}`, {
            direction: "top",
            className: "fd-tip",
          })
          .addTo(layer);
      }
      bounds.push([f.lat as number, f.lon as number]);
    });
    // Stage 2 badge at the mid-route fix — ties the map to the flight-stages list.
    const enroute = withCoords.filter((f) => f.type !== "origin" && f.type !== "destination");
    const mid = enroute.length > 0 ? enroute[Math.floor(enroute.length / 2)] : withCoords[Math.floor(withCoords.length / 2)];
    if (mid && mid.lat != null && mid.lon != null) {
      L.marker([mid.lat, mid.lon], { icon: stageIcon(2), interactive: false, keyboard: false }).addTo(layer);
    }
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
        L.polyline(seg, { color: "#f5a524", weight: 7, opacity: 0.14 }).addTo(layer);
        L.polyline(seg, { color: "#f5a524", weight: 2, opacity: 0.8, dashArray: "7 5" }).addTo(layer);
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
      <div ref={divRef} style={{ height: 520 }} />
      <div className="map-title">
        <span className="map-title-route">{originName}<span className="arrow">→</span>{destName}</span>
        <span className="map-title-sub">filed route · recorded track overlay</span>
      </div>
      <div className="map-legend">
        <div className="map-legend-title">Legend</div>
        <div><span className="sw" style={{ background: "#7dd3fc" }} />Filed route</div>
        <div style={{ marginTop: 5 }}><span className="sw" style={{ background: "#c8102e" }} />① Departure · ② Enroute · ③ Arrival</div>
        {showTrack && track.length > 0 && (
          <div style={{ marginTop: 5 }}><span className="sw" style={{ background: "#f5a524" }} />Recorded track · {track.length} pts</div>
        )}
        {noCoords.length > 0 && (
          <div style={{ marginTop: 5 }} className="faint" title="Provider supplied no coordinates for these fixes">
            Not plotted: {noCoords.join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}
