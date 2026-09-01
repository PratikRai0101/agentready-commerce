"use client";

/**
 * AI-4 "What I understood" interface.
 * Shows current structured intent as editable/removable chips.
 * Requirements and preferences are visually distinct.
 * Each chip supports an accessible edit/remove action.
 */

export type IntentField = {
  key: string;
  label: string;
  value: string;
  kind: "requirement" | "preference" | "unresolved";
  editable: boolean;
};

type Props = {
  fields: IntentField[];
  onRemove: (key: string) => void;
};

export function IntentPanel({ fields, onRemove }: Props) {
  if (fields.length === 0) return null;

  const requirements = fields.filter((f) => f.kind === "requirement");
  const preferences = fields.filter((f) => f.kind === "preference");
  const unresolved = fields.filter((f) => f.kind === "unresolved");

  return (
    <div className="intent-panel" role="region" aria-label="What I understood">
      {requirements.length > 0 && (
        <>
          <div className="intent-section-label">Requirements</div>
          <div className="intent-chips">
            {requirements.map((f) => (
              <Chip key={f.key} field={f} onRemove={onRemove} />
            ))}
          </div>
        </>
      )}
      {preferences.length > 0 && (
        <>
          <div className="intent-section-label">Preferences</div>
          <div className="intent-chips">
            {preferences.map((f) => (
              <Chip key={f.key} field={f} onRemove={onRemove} />
            ))}
          </div>
        </>
      )}
      {unresolved.length > 0 && (
        <>
          <div className="intent-section-label intent-unresolved-label">Needs your input</div>
          <div className="intent-chips">
            {unresolved.map((f) => (
              <Chip key={f.key} field={f} onRemove={onRemove} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Chip({ field, onRemove }: { field: IntentField; onRemove: (key: string) => void }) {
  const className = `intent-chip ${
    field.kind === "requirement" ? "requirement" :
    field.kind === "preference" ? "preference" :
    "unresolved"
  }`;

  return (
    <span className={className}>
      <span className="intent-chip-label">{field.label}</span>
      {field.editable && (
        <button
          type="button"
          className="intent-chip-remove"
          onClick={() => onRemove(field.key)}
          aria-label={`Remove ${field.label}`}
        >
          &times;
        </button>
      )}
    </span>
  );
}
