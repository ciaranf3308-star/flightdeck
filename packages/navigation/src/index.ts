/**
 * Navigation reference data access.
 *
 * The bundled dataset is a SYNTHETIC fixture (see data/*.json notes). A real
 * deployment would load an AIRAC cycle here; the interface is identical so the
 * route engine never depends on fixture specifics.
 */
import { AirportNavData } from "@flightdeck/shared-models";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export interface NavDatabase {
  readonly cycle: string;
  getAirport(icao: string): Promise<AirportNavData | null>;
  listAirports(): Promise<string[]>;
  /** fill missing coordinates on a provider airport ref from reference data */
  resolvePosition(icao: string): Promise<{ lat: number; lon: number } | null>;
}

const BUNDLED = ["KJFK", "EIDW"];

export class FixtureNavDatabase implements NavDatabase {
  readonly cycle = "FIXTURE-2610";
  private cache = new Map<string, AirportNavData>();

  async getAirport(icao: string): Promise<AirportNavData | null> {
    const key = icao.toUpperCase();
    if (this.cache.has(key)) return this.cache.get(key)!;
    if (!BUNDLED.includes(key)) return null;
    try {
      const raw = await readFile(join(here, "data", `${key}.json`), "utf8");
      const parsed = AirportNavData.parse(JSON.parse(raw));
      this.cache.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  async listAirports(): Promise<string[]> {
    return [...BUNDLED];
  }

  async resolvePosition(icao: string): Promise<{ lat: number; lon: number } | null> {
    const a = await this.getAirport(icao);
    return a ? { lat: a.airport.position.lat, lon: a.airport.position.lon } : null;
  }
}
