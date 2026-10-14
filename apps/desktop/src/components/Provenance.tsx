import type { Field, Provenance } from "@flightdeck/shared-models";

const LABELS: Record<Provenance, string> = {
  verified: "Verified",
  inferred: "Inferred",
  generated: "Generated",
  unavailable: "Unavailable",
  imported: "Imported",
};

export function ProvBadge({ provenance, title }: { provenance: Provenance; title?: string }) {
  return (
    <span className={`prov ${provenance}`} title={title}>
      {LABELS[provenance]}
    </span>
  );
}

/** Render a Field<T>: value (or honest "not available") + provenance badge. */
export function FieldValue<T>({
  field,
  format,
  naText = "Not available",
}: {
  field: Field<T>;
  format?: (v: T) => string;
  naText?: string;
}) {
  const title = [field.source, field.note].filter(Boolean).join(" — ");
  if (field.value == null) {
    return (
      <span className="row" style={{ gap: 8 }}>
        <span className="na">{naText}</span>
        <ProvBadge provenance="unavailable" title={title || "The provider did not supply this field."} />
      </span>
    );
  }
  return (
    <span className="row" style={{ gap: 8 }}>
      <span>{format ? format(field.value) : String(field.value)}</span>
      <ProvBadge provenance={field.provenance} title={title} />
    </span>
  );
}

export function fmtUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}
