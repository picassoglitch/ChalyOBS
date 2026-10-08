"use client";

import { useMemo, useState } from "react";
import {
  BROADCAST_FIELDS,
  BroadcastFieldMeta,
  BroadcastMeta,
  DestinationConfig,
  PLATFORM_FIELD_SUPPORT,
  PLATFORM_META,
  PlatformId,
  Visibility,
} from "@/lib/destinations";

type Dest = DestinationConfig & { id: string };

interface Props {
  meta: BroadcastMeta;
  /** The tenant's connected channels — used to show, per field, which ones
   *  will actually receive the value ("availability accordingly"). */
  destinations: Dest[];
  onClose: () => void;
  onPublish: (meta: BroadcastMeta) => void;
  busy?: boolean;
}

export function BroadcastComposerModal({
  meta,
  destinations,
  onClose,
  onPublish,
  busy,
}: Props) {
  const [draft, setDraft] = useState<BroadcastMeta>(meta);

  // Distinct platforms the tenant has connected, in canonical order.
  const connectedPlatforms = useMemo(() => {
    const seen = new Set<PlatformId>();
    const out: PlatformId[] = [];
    for (const d of destinations) {
      if (!seen.has(d.platformId)) {
        seen.add(d.platformId);
        out.push(d.platformId);
      }
    }
    return out;
  }, [destinations]);

  function set<K extends keyof BroadcastMeta>(key: K, value: BroadcastMeta[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const canPublish = draft.title.trim().length > 0 && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl bg-surface border border-border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-border">
          <h2 className="text-lg font-bold flex-1">Actualizar títulos</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="text-text-tertiary hover:text-text-primary text-xl leading-none"
          >
            ×
          </button>
        </div>

        <p className="px-6 pt-3 text-[11px] text-text-tertiary leading-relaxed">
          Rellena todos los campos. Al publicar, cada uno se aplica solo a las
          plataformas que lo admiten.
        </p>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {BROADCAST_FIELDS.map((field) => (
            <FieldRow
              key={field.id}
              field={field}
              draft={draft}
              set={set}
              connectedPlatforms={connectedPlatforms}
            />
          ))}
        </div>

        <div className="flex gap-2 px-6 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg border border-border text-sm font-semibold text-text-secondary hover:bg-surface-elevated transition"
          >
            Cancelar
          </button>
          <button
            disabled={!canPublish}
            onClick={() => onPublish(draft)}
            className="flex-1 py-2.5 rounded-lg bg-accent text-white text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Publicar
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldRow({
  field,
  draft,
  set,
  connectedPlatforms,
}: {
  field: BroadcastFieldMeta;
  draft: BroadcastMeta;
  set: <K extends keyof BroadcastMeta>(key: K, value: BroadcastMeta[K]) => void;
  connectedPlatforms: PlatformId[];
}) {
  // Which of the tenant's connected channels will receive this field.
  const targets = connectedPlatforms.filter((p) =>
    PLATFORM_FIELD_SUPPORT[p].includes(field.id),
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-2">
        <label className="block text-[10px] font-bold tracking-[0.1em] text-text-tertiary uppercase">
          {field.label}
        </label>
        <AvailabilityChips targets={targets} />
      </div>
      <FieldControl field={field} draft={draft} set={set} />
    </div>
  );
}

function AvailabilityChips({ targets }: { targets: PlatformId[] }) {
  if (targets.length === 0) {
    return (
      <span className="text-[9px] text-text-tertiary italic">
        ningún canal lo usa
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1 flex-wrap justify-end">
      {targets.map((p) => {
        const m = PLATFORM_META[p];
        return (
          <span
            key={p}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold text-text-secondary bg-surface-elevated border border-border"
            title={m.displayName}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: `var(--color-${m.colorVar})` }}
            />
            {m.displayName}
          </span>
        );
      })}
    </div>
  );
}

function FieldControl({
  field,
  draft,
  set,
}: {
  field: BroadcastFieldMeta;
  draft: BroadcastMeta;
  set: <K extends keyof BroadcastMeta>(key: K, value: BroadcastMeta[K]) => void;
}) {
  switch (field.kind) {
    case "text":
      return (
        <input
          value={draft[field.id] as string}
          onChange={(e) => set(field.id, e.target.value as never)}
          placeholder={field.placeholder}
          autoComplete="off"
          className="w-full px-3.5 py-2.5 rounded-lg bg-surface-elevated border border-border text-xs text-text-primary outline-none focus:border-accent transition"
        />
      );
    case "textarea":
      return (
        <textarea
          value={draft[field.id] as string}
          onChange={(e) => set(field.id, e.target.value as never)}
          placeholder={field.placeholder}
          rows={3}
          className="w-full px-3.5 py-2.5 rounded-lg bg-surface-elevated border border-border text-xs text-text-primary outline-none focus:border-accent transition resize-y"
        />
      );
    case "select":
      return (
        <select
          value={draft[field.id] as string}
          onChange={(e) =>
            set(
              field.id,
              (field.id === "visibility"
                ? (e.target.value as Visibility)
                : e.target.value) as never,
            )
          }
          className="w-full px-3.5 py-2.5 rounded-lg bg-surface-elevated border border-border text-xs text-text-primary outline-none focus:border-accent transition"
        >
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "tags":
      return (
        <TagsInput
          value={draft.tags}
          onChange={(tags) => set("tags", tags)}
          placeholder={field.placeholder}
        />
      );
    case "toggle":
      return (
        <ToggleRow
          value={draft[field.id] as boolean}
          onChange={(v) => set(field.id, v as never)}
        />
      );
  }
}

function TagsInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState("");

  function commit() {
    const t = text.trim();
    if (t.length === 0) return;
    if (!value.includes(t)) onChange([...value, t]);
    setText("");
  }

  return (
    <div className="rounded-lg bg-surface-elevated border border-border px-2 py-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-surface-high text-text-secondary"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== tag))}
                className="text-text-tertiary hover:text-bad leading-none"
                aria-label={`Quitar ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && text.length === 0 && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full px-1.5 py-1 bg-transparent text-xs text-text-primary outline-none"
      />
    </div>
  );
}

function ToggleRow({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      aria-pressed={value}
      className="relative inline-flex h-5 w-9 items-center rounded-full transition shrink-0"
      style={{
        backgroundColor: value ? "var(--color-accent)" : "var(--color-surface-high)",
      }}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
          value ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
