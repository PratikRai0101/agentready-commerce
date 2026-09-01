"use client";

import { useState, useRef, useEffect } from "react";

/**
 * AI-4 "What I understood" interface.
 * Shows current structured intent as editable/removable chips.
 * Requirements and preferences are visually distinct.
 * Each chip supports accessible edit and remove actions.
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
  onEdit: (key: string, newValue: string) => void;
};

export function IntentPanel({ fields, onRemove, onEdit }: Props) {
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
              <Chip key={f.key} field={f} onRemove={onRemove} onEdit={onEdit} />
            ))}
          </div>
        </>
      )}
      {preferences.length > 0 && (
        <>
          <div className="intent-section-label">Preferences</div>
          <div className="intent-chips">
            {preferences.map((f) => (
              <Chip key={f.key} field={f} onRemove={onRemove} onEdit={onEdit} />
            ))}
          </div>
        </>
      )}
      {unresolved.length > 0 && (
        <>
          <div className="intent-section-label intent-unresolved-label">Needs your input</div>
          <div className="intent-chips">
            {unresolved.map((f) => (
              <Chip key={f.key} field={f} onRemove={onRemove} onEdit={onEdit} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Chip({ field, onRemove, onEdit }: { field: IntentField; onRemove: (key: string) => void; onEdit: (key: string, value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(field.value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const className = `intent-chip ${
    field.kind === "requirement" ? "requirement" :
    field.kind === "preference" ? "preference" :
    "unresolved"
  }`;

  const handleSubmit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== field.value) {
      onEdit(field.key, trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <span className={`${className} intent-chip-editing`}>
        <input
          ref={inputRef}
          type="text"
          className="intent-chip-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") { setEditing(false); setEditValue(field.value); }
          }}
          onBlur={handleSubmit}
          aria-label={`Edit ${field.label}`}
          style={{ width: Math.max(40, editValue.length * 8 + 16) }}
        />
      </span>
    );
  }

  return (
    <span className={className}>
      <button
        type="button"
        className="intent-chip-label"
        onClick={() => field.editable && setEditing(true)}
        disabled={!field.editable}
        aria-label={`Edit ${field.label}: ${field.value || field.label}`}
      >
        {field.label}
      </button>
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
