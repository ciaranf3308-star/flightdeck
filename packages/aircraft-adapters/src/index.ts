/**
 * Aircraft profiles for compatibility checks.
 *
 * Values are REFERENCE data compiled from public aircraft specifications and
 * addon documentation summaries — provenance is "generated", not surveyed.
 * Always verify against the addon's own documentation before flight.
 */
import type { AircraftProfile } from "@flightdeck/shared-models";

const REF_NOTE =
  "Reference values compiled from public aircraft data; verify against the addon documentation. Not surveyed.";

export const AIRCRAFT_PROFILES: AircraftProfile[] = [
  {
    id: "inibuilds-a333",
    label: "iniBuilds Airbus A330-300",
    icaoType: "A333",
    approachCategory: "C",
    minRunwayLengthFt: 8000,
    supportedApproachKinds: ["ILS", "RNAV", "VOR"],
    maxCruiseAltitudeFt: 41000,
    provenance: "generated",
    note: REF_NOTE,
  },
  {
    id: "fenix-a320",
    label: "Fenix Simulations Airbus A320",
    icaoType: "A320",
    approachCategory: "C",
    minRunwayLengthFt: 6000,
    supportedApproachKinds: ["ILS", "RNAV", "VOR"],
    maxCruiseAltitudeFt: 39800,
    provenance: "generated",
    note: REF_NOTE,
  },
  {
    id: "pmdg-b738",
    label: "PMDG Boeing 737-800",
    icaoType: "B738",
    approachCategory: "C",
    minRunwayLengthFt: 6000,
    supportedApproachKinds: ["ILS", "RNAV", "VOR"],
    maxCruiseAltitudeFt: 41000,
    provenance: "generated",
    note: REF_NOTE,
  },
  {
    id: "asobo-a320neo",
    label: "Asobo Airbus A320neo (default)",
    icaoType: "A20N",
    approachCategory: "C",
    minRunwayLengthFt: 6000,
    supportedApproachKinds: ["ILS", "RNAV", "VOR"],
    maxCruiseAltitudeFt: 39800,
    provenance: "generated",
    note: REF_NOTE,
  },
];

/** Match a provider aircraft type (e.g. "A333") to the closest profile. */
export function matchProfile(icaoType: string | null | undefined): AircraftProfile | null {
  if (!icaoType) return null;
  const t = icaoType.toUpperCase();
  return (
    AIRCRAFT_PROFILES.find((p) => p.icaoType === t) ??
    AIRCRAFT_PROFILES.find((p) => p.icaoType.startsWith(t.slice(0, 3))) ??
    null
  );
}

export function getProfile(id: string): AircraftProfile | null {
  return AIRCRAFT_PROFILES.find((p) => p.id === id) ?? null;
}
