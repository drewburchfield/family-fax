import {
  PDFDocument,
  StandardFonts,
  cmyk,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import type { CoverSheetData } from "../../shared/contracts";
import { assertSupportedUpload, type UploadSource } from "./uploads";

export interface PreparedFaxPacket {
  bytes: Uint8Array;
  pageCount: number;
  sha256: string;
  warnings: string[];
  documents: Array<{ name: string; type: string; size: number; sha256: string; pageCount: number }>;
}

interface PreparationLimits {
  maxUploadBytes: number;
  maxFaxPages: number;
}

const DEFAULT_LIMITS: PreparationLimits = {
  maxUploadBytes: 25 * 1024 * 1024,
  maxFaxPages: 100,
};

interface PreparedSource {
  source: UploadSource;
  bytes: Uint8Array;
  sha256: string;
  pageCount: number;
  document?: PDFDocument;
}

export function normalizeCoverSheet(value: CoverSheetData): CoverSheetData {
  const normalize = (text: string) => text.replaceAll("\r\n", "\n").replace(/[ \t]+\n/g, "\n").trim();
  return {
    recipient: normalize(value.recipient),
    sender: normalize(value.sender),
    subject: normalize(value.subject),
    callbackNumber: normalize(value.callbackNumber),
    note: normalize(value.note),
    enabled: value.enabled,
  };
}

export async function prepareFaxPacket(
  sources: UploadSource[],
  rawCover: CoverSheetData,
  options: { transmissionDate?: Date; limits?: PreparationLimits } = {},
): Promise<PreparedFaxPacket> {
  if (sources.length === 0) throw new Error("Add at least one PDF or photo to send.");
  const limits = options.limits ?? DEFAULT_LIMITS;
  let totalSourceBytes = 0;
  for (const source of sources) {
    assertSupportedUpload(source);
    if (source.size > limits.maxUploadBytes) {
      throw new Error(`${source.name} exceeds the ${limits.maxUploadBytes} bytes upload limit.`);
    }
    totalSourceBytes += source.size;
    if (totalSourceBytes > limits.maxUploadBytes) {
      throw new Error(`The combined documents exceed the ${limits.maxUploadBytes} bytes upload limit.`);
    }
  }
  const output = await PDFDocument.create();
  const preparedSources: PreparedSource[] = [];
  const warnings: string[] = [];

  for (const source of sources) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    if (bytes.byteLength !== source.size) {
      throw new Error(`${source.name} changed while it was being prepared. Remove it and add it again.`);
    }
    if (source.type === "application/pdf" && !startsWith(bytes, [37, 80, 68, 70, 45])) {
      throw new Error(`${source.name} does not appear to be a readable PDF.`);
    }
    if (source.type === "image/jpeg" && !startsWith(bytes, [255, 216, 255])) {
      throw new Error(`${source.name} does not appear to be a readable JPEG.`);
    }
    if (source.type === "image/png" && !startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) {
      throw new Error(`${source.name} does not appear to be a readable PNG.`);
    }
    const dimensions = readImageDimensions(bytes, source.type);
    if (dimensions && dimensions.width * dimensions.height > 50_000_000) {
      throw new Error(`${source.name} has too many pixels to prepare safely in this browser.`);
    }
    const digest = await sha256ForBytes(bytes);
    if (source.type === "application/pdf") {
      let document: PDFDocument;
      try {
        document = await PDFDocument.load(bytes);
      } catch {
        throw new Error(`${source.name} could not be opened. It may be encrypted or damaged.`);
      }
      const pageCount = document.getPageCount();
      if (pageCount === 0) throw new Error(`${source.name} contains no pages.`);
      preparedSources.push({ source, bytes, sha256: digest, pageCount, document });
    } else {
      preparedSources.push({ source, bytes, sha256: digest, pageCount: 1 });
    }
  }

  const cover = normalizeCoverSheet(rawCover);
  const sourcePageCount = preparedSources.reduce((total, item) => total + item.pageCount, 0);
  const finalPageCount = sourcePageCount + (cover.enabled ? 1 : 0);
  if (finalPageCount > limits.maxFaxPages) {
    const noun = limits.maxFaxPages === 1 ? "page" : "pages";
    throw new Error(`The fax cannot exceed ${limits.maxFaxPages} ${noun}.`);
  }
  if (cover.enabled) {
    await addCoverSheet(output, cover, finalPageCount, options.transmissionDate ?? new Date(), warnings);
  }

  for (const prepared of preparedSources) {
    if (prepared.document) {
      const pages = await output.copyPages(prepared.document, prepared.document.getPageIndices());
      for (const page of pages) output.addPage(page);
      continue;
    }
    const image =
      prepared.source.type === "image/png"
        ? await output.embedPng(prepared.bytes)
        : await output.embedJpg(prepared.bytes);
    if (image.width * image.height > 50_000_000) {
      throw new Error(`${prepared.source.name} has too many pixels to prepare safely in this browser.`);
    }
    if (image.width < 1_000 || image.height < 1_300) {
      warnings.push(`${prepared.source.name} is low resolution and may be hard to read when faxed.`);
    }
    if (image.width > image.height) {
      warnings.push(`${prepared.source.name} is landscape. Check its orientation in the final preview.`);
    }
    const page = output.addPage([612, 792]);
    const scale = Math.min(540 / image.width, 720 / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    page.drawImage(image, {
      x: (612 - width) / 2,
      y: (792 - height) / 2,
      width,
      height,
    });
  }

  output.setTitle("Family Fax packet");
  output.setCreator("Family Fax");
  output.setProducer("Family Fax browser preparation");
  output.setCreationDate(options.transmissionDate ?? new Date());
  const bytes = await output.save({ useObjectStreams: false });
  if (bytes.byteLength > limits.maxUploadBytes) {
    throw new Error(`The prepared fax exceeds the ${limits.maxUploadBytes} bytes upload limit.`);
  }
  return {
    bytes,
    pageCount: output.getPageCount(),
    sha256: await sha256ForBytes(bytes),
    warnings,
    documents: preparedSources.map((item) => ({
      name: item.source.name,
      type: item.source.type,
      size: item.source.size,
      sha256: item.sha256,
      pageCount: item.pageCount,
    })),
  };
}

export async function sha256ForBytes(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function addCoverSheet(
  document: PDFDocument,
  cover: CoverSheetData,
  pageCount: number,
  transmissionDate: Date,
  warnings: string[],
): Promise<void> {
  const page = document.addPage([612, 792]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.14, 0.22);
  const blue = rgb(0.14, 0.31, 0.46);
  assertCoverTextSupported(regular, [
    ["recipient", cover.recipient],
    ["sender", cover.sender],
    ["subject", cover.subject],
    ["callback number", cover.callbackNumber],
    ["note", cover.note],
  ]);
  page.drawRectangle({ x: 0, y: 728, width: 612, height: 64, color: ink });
  page.drawText("FAMILY FAX", { x: 48, y: 752, size: 23, font: bold, color: rgb(0.97, 0.95, 0.9) });
  page.drawText("PRIVATE FACSIMILE TRANSMISSION", {
    x: 350,
    y: 755,
    size: 8,
    font: bold,
    color: rgb(0.78, 0.84, 0.86),
  });
  page.drawText("COVER SHEET", { x: 48, y: 684, size: 11, font: bold, color: blue });
  if (drawField(page, regular, bold, "TO", cover.recipient || "Not specified", 640)) warnings.push("Cover sheet recipient was shortened to fit.");
  if (drawField(page, regular, bold, "FROM", cover.sender || "Not specified", 590)) warnings.push("Cover sheet sender was shortened to fit.");
  if (drawField(page, regular, bold, "SUBJECT", cover.subject || "Not specified", 540)) warnings.push("Cover sheet subject was shortened to fit.");
  if (drawField(page, regular, bold, "CALLBACK", cover.callbackNumber || "Not specified", 490)) warnings.push("Cover sheet callback number was shortened to fit.");
  drawField(
    page,
    regular,
    bold,
    "TRANSMITTED",
    transmissionDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    440,
  );
  drawField(page, regular, bold, "TOTAL PAGES", String(pageCount), 390);
  page.drawText("NOTE", { x: 48, y: 335, size: 8, font: bold, color: blue });
  page.drawRectangle({ x: 48, y: 130, width: 516, height: 185, borderColor: cmyk(0.12, 0.06, 0, 0.35), borderWidth: 1 });
  if (drawWrappedText(page, cover.note || "No additional note.", regular, 11, 64, 286, 484, 18, ink, 148)) {
    warnings.push("Cover sheet note was shortened to fit. Review the preview.");
  }
  page.drawText("This fax may contain private information. Please deliver it to the intended recipient.", {
    x: 48,
    y: 86,
    size: 8,
    font: regular,
    color: rgb(0.34, 0.4, 0.44),
  });
}

function drawField(page: PDFPage, regular: PDFFont, bold: PDFFont, label: string, value: string, y: number): boolean {
  const fitted = fitText(value, regular, 12, 419);
  page.drawText(label, { x: 48, y, size: 8, font: bold, color: rgb(0.14, 0.31, 0.46) });
  page.drawText(fitted.value, { x: 145, y: y - 2, size: 12, font: regular, color: rgb(0.07, 0.14, 0.22) });
  page.drawLine({ start: { x: 145, y: y - 10 }, end: { x: 564, y: y - 10 }, thickness: 0.5, color: rgb(0.72, 0.75, 0.75) });
  return fitted.shortened;
}

function drawWrappedText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  color: ReturnType<typeof rgb>,
  minimumY: number,
): boolean {
  const lines = wrapText(text, font, size, maxWidth);
  let cursor = y;
  let rendered = 0;
  for (const line of lines) {
    if (cursor < minimumY) break;
    page.drawText(line, { x, y: cursor, size, font, color });
    rendered += 1;
    cursor -= lineHeight;
  }
  return rendered < lines.length;
}

function assertCoverTextSupported(font: PDFFont, fields: Array<[string, string]>): void {
  for (const [label, value] of fields) {
    try {
      font.encodeText(value);
    } catch {
      throw new Error(`Cover sheet ${label} contains unsupported characters. Use standard Latin text without emoji.`);
    }
  }
}

function fitText(value: string, font: PDFFont, size: number, maxWidth: number): { value: string; shortened: boolean } {
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return { value, shortened: false };
  const ellipsis = "...";
  let end = value.length;
  while (end > 0 && font.widthOfTextAtSize(`${value.slice(0, end).trimEnd()}${ellipsis}`, size) > maxWidth) end -= 1;
  return { value: `${value.slice(0, end).trimEnd()}${ellipsis}`, shortened: true };
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      const chunks = splitWord(word, font, size, maxWidth);
      for (const chunk of chunks) {
        const candidate = line ? `${line} ${chunk}` : chunk;
        if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
          lines.push(line);
          line = chunk;
        } else {
          line = candidate;
        }
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function splitWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= maxWidth) return [word];
  const chunks: string[] = [];
  let chunk = "";
  for (const character of word) {
    if (chunk && font.widthOfTextAtSize(`${chunk}${character}`, size) > maxWidth) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk += character;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function readImageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png" && bytes.byteLength >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType !== "image/jpeg" || bytes.byteLength < 10) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}
