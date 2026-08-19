import { useState } from "react";

import { assertSupportedUpload, uploadWarnings, type UploadSource } from "../lib/uploads";

export interface QueuedDocument {
  id: string;
  name: string;
  type: string;
  size: number;
  source: UploadSource;
  warnings: string[];
}

export function DocumentQueue({
  documents,
  onChange,
  disabled = false,
}: {
  documents: QueuedDocument[];
  onChange(documents: QueuedDocument[]): void;
  disabled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

  const move = (index: number, offset: number) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= documents.length) return;
    const next = [...documents];
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onChange(next);
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    try {
      const additions = [...files].map((file) => {
        assertSupportedUpload(file);
        return {
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          size: file.size,
          source: file,
          warnings: uploadWarnings(file),
        } satisfies QueuedDocument;
      });
      setError(null);
      onChange([...documents, ...additions]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The document could not be added.");
    }
  };

  return (
    <section className="document-queue" aria-labelledby="documents-heading">
      <div className="section-heading-row">
        <div>
          <p className="section-kicker">Transmission order</p>
          <h2 id="documents-heading">Documents</h2>
        </div>
        <label className="file-button">
          Add PDF or photos
          <input
            type="file"
            multiple
            disabled={disabled}
            accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
            onChange={(event) => {
              addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      {error ? <p role="alert" className="inline-error">{error}</p> : null}
      {documents.length === 0 ? (
        <div className="empty-document-list">
          <p>No documents yet.</p>
          <span>Choose an existing PDF or take clear, upright photos.</span>
        </div>
      ) : (
        <ol className="document-list">
          {documents.map((document, index) => (
            <li key={document.id}>
              <span className="document-index">{index + 1}</span>
              <span className="document-name">
                <strong>{document.name}</strong>
                <small>{formatBytes(document.size)}</small>
                {document.warnings.map((warning) => <em key={warning}>{warning}</em>)}
              </span>
              <span className="document-actions">
                <button type="button" aria-label={`Move ${document.name} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>↑</button>
                <button type="button" aria-label={`Move ${document.name} down`} disabled={disabled || index === documents.length - 1} onClick={() => move(index, 1)}>↓</button>
                <button type="button" aria-label={`Remove ${document.name}`} disabled={disabled} onClick={() => onChange(documents.filter((item) => item.id !== document.id))}>Remove</button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
