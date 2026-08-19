export interface UploadSource {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export const supportedUploadTypes = ["application/pdf", "image/jpeg", "image/png"] as const;

export function assertSupportedUpload(source: UploadSource): void {
  if (!supportedUploadTypes.includes(source.type as (typeof supportedUploadTypes)[number])) {
    throw new Error(`${source.name} is not supported. Add a PDF, JPEG, or PNG file.`);
  }
  if (source.size <= 0) throw new Error(`${source.name} is empty.`);
}

export function uploadWarnings(source: UploadSource): string[] {
  const warnings: string[] = [];
  if (source.size > 20 * 1024 * 1024) {
    warnings.push(`${source.name} is large and may take longer to prepare and upload.`);
  }
  return warnings;
}
