import type { CoverSheetData } from "../../shared/contracts";

export function CoverSheetEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: CoverSheetData;
  onChange(value: CoverSheetData): void;
  disabled?: boolean;
}) {
  const update = (field: keyof CoverSheetData, nextValue: string | boolean) =>
    onChange({ ...value, [field]: nextValue });

  return (
    <fieldset className="cover-editor" disabled={disabled}>
      <legend>Cover sheet</legend>
      <label className="toggle-row">
        <input
          type="checkbox"
          disabled={disabled}
          checked={value.enabled}
          onChange={(event) => update("enabled", event.currentTarget.checked)}
        />
        <span>Include a cover sheet</span>
      </label>
      {value.enabled ? (
        <div className="field-grid">
          <label>
            Recipient
            <input disabled={disabled} value={value.recipient} onChange={(event) => update("recipient", event.currentTarget.value)} />
          </label>
          <label>
            Sender
            <input disabled={disabled} value={value.sender} onChange={(event) => update("sender", event.currentTarget.value)} />
          </label>
          <label className="field-wide">
            Subject
            <input disabled={disabled} value={value.subject} onChange={(event) => update("subject", event.currentTarget.value)} />
          </label>
          <label>
            Callback number
            <input
              inputMode="tel"
              disabled={disabled}
              value={value.callbackNumber}
              onChange={(event) => update("callbackNumber", event.currentTarget.value)}
            />
          </label>
          <label className="field-wide">
            Note
            <textarea disabled={disabled} value={value.note} rows={5} onChange={(event) => update("note", event.currentTarget.value)} />
          </label>
        </div>
      ) : (
        <p className="quiet-note">The final packet will contain only the documents below.</p>
      )}
    </fieldset>
  );
}
