/// <reference types="@cloudflare/workers-types" />

export interface StoredDocument {
  body: ReadableStream;
  size: number;
  contentType: string;
  sha256?: string;
  uploadedAt?: string;
}

export interface DocumentStore {
  put(
    key: string,
    body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    metadata: { contentType: string; sha256: string; uploadedAt: string },
  ): Promise<void>;
  get(key: string): Promise<StoredDocument | null>;
  delete(key: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class R2DocumentStore implements DocumentStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(
    key: string,
    body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    metadata: { contentType: string; sha256: string; uploadedAt: string },
  ): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: metadata.contentType },
      customMetadata: { sha256: metadata.sha256, uploadedAt: metadata.uploadedAt },
    });
  }

  async get(key: string): Promise<StoredDocument | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      body: object.body,
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      sha256: object.customMetadata?.sha256,
      uploadedAt: object.customMetadata?.uploadedAt,
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    await this.bucket.head("__family_fax_healthcheck__");
    return { ok: true, detail: "R2 binding is reachable." };
  }
}

export class MemoryDocumentStore implements DocumentStore {
  private readonly objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; sha256: string; uploadedAt: string }
  >();

  async put(
    key: string,
    body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    metadata: { contentType: string; sha256: string; uploadedAt: string },
  ): Promise<void> {
    const bytes = await new Response(body as BodyInit).bytes();
    this.objects.set(key, { bytes, ...metadata });
  }

  async get(key: string): Promise<StoredDocument | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = new ArrayBuffer(object.bytes.byteLength);
    new Uint8Array(bytes).set(object.bytes);
    return {
      body: new Blob([bytes]).stream(),
      size: object.bytes.byteLength,
      contentType: object.contentType,
      sha256: object.sha256,
      uploadedAt: object.uploadedAt,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "Memory document store is ready." };
  }
}
