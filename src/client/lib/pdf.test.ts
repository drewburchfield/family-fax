import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";

import { normalizeCoverSheet, prepareFaxPacket, sha256ForBytes } from "./pdf";

describe("browser fax PDF preparation", () => {
  it("normalizes editable cover-sheet text", () => {
    expect(
      normalizeCoverSheet({
        recipient: "  Allergy Clinic  ",
        sender: " Drew and family ",
        subject: " Records\r\nrequest ",
        callbackNumber: " 615-555-0100 ",
        note: " Please fax the boys' records. \r\n Thank you. ",
        enabled: true,
      }),
    ).toEqual({
      recipient: "Allergy Clinic",
      sender: "Drew and family",
      subject: "Records\nrequest",
      callbackNumber: "615-555-0100",
      note: "Please fax the boys' records.\n Thank you.",
      enabled: true,
    });
  });

  it("renders a cover and preserves document order in the canonical packet", async () => {
    const first = await onePagePdf("FIRST");
    const second = await onePagePdf("SECOND");

    const packet = await prepareFaxPacket(
      [source("first.pdf", "application/pdf", first), source("second.pdf", "application/pdf", second)],
      {
        recipient: "Clinic",
        sender: "Family",
        subject: "Records",
        callbackNumber: "615-555-0100",
        note: "Attached.",
        enabled: true,
      },
      { transmissionDate: new Date("2026-08-16T12:00:00.000Z") },
    );

    expect(packet.pageCount).toBe(3);
    expect(packet.documents.map((document) => document.name)).toEqual(["first.pdf", "second.pdf"]);
    expect(packet.sha256).toBe(await sha256ForBytes(packet.bytes));
    expect((await PDFDocument.load(packet.bytes)).getPageCount()).toBe(3);
  });

  it("converts PNG images to PDF pages and reports low-resolution input", async () => {
    const tinyPng = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZK2sAAAAASUVORK5CYII="),
      (character) => character.charCodeAt(0),
    );

    const packet = await prepareFaxPacket(
      [source("photo.png", "image/png", tinyPng)],
      {
        recipient: "",
        sender: "",
        subject: "",
        callbackNumber: "",
        note: "",
        enabled: false,
      },
    );

    expect(packet.pageCount).toBe(1);
    expect(packet.warnings[0]).toMatch(/low resolution/i);
  });

  it("rejects unsupported documents before preparation", async () => {
    await expect(
      prepareFaxPacket(
        [source("notes.txt", "text/plain", new TextEncoder().encode("not a fax"))],
        {
          recipient: "",
          sender: "",
          subject: "",
          callbackNumber: "",
          note: "",
          enabled: false,
        },
      ),
    ).rejects.toThrow(/PDF, JPEG, or PNG/i);
  });

  it("rejects a valid PDF that contains no pages", async () => {
    await expect(
      prepareFaxPacket(
        [source("empty.pdf", "application/pdf", zeroPagePdf())],
        disabledCover(),
      ),
    ).rejects.toThrow(/empty\.pdf.*no pages/i);
  });

  it("reports unsupported cover characters before rendering", async () => {
    await expect(
      prepareFaxPacket(
        [source("records.pdf", "application/pdf", await onePagePdf("RECORDS"))],
        { ...disabledCover(), enabled: true, recipient: "Clinic 📠" },
      ),
    ).rejects.toThrow(/cover sheet recipient.*unsupported characters/i);
  });

  it("warns when long cover text must be shortened to remain on the page", async () => {
    const packet = await prepareFaxPacket(
      [source("records.pdf", "application/pdf", await onePagePdf("RECORDS"))],
      {
        ...disabledCover(),
        enabled: true,
        note: Array.from({ length: 500 }, () => "records").join(" "),
      },
    );

    expect(packet.warnings).toContainEqual(expect.stringMatching(/cover sheet note.*shortened/i));
  });

  it("rejects configured byte and page limits before producing a packet", async () => {
    const read = vi.fn(async () => new ArrayBuffer(11));
    await expect(
      prepareFaxPacket(
        [{ name: "large.pdf", type: "application/pdf", size: 11, arrayBuffer: read }],
        disabledCover(),
        { limits: { maxUploadBytes: 10, maxFaxPages: 100 } },
      ),
    ).rejects.toThrow(/10 bytes/i);
    expect(read).not.toHaveBeenCalled();

    const twoPages = await PDFDocument.create();
    twoPages.addPage();
    twoPages.addPage();
    await expect(
      prepareFaxPacket(
        [source("two-pages.pdf", "application/pdf", await twoPages.save())],
        disabledCover(),
        { limits: { maxUploadBytes: 1_000_000, maxFaxPages: 1 } },
      ),
    ).rejects.toThrow(/cannot exceed 1 page/i);
  });

  it("rejects an oversized image from its header before decoding pixels", async () => {
    const oversized = new Uint8Array(24);
    oversized.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(oversized.buffer);
    view.setUint32(16, 100_000);
    view.setUint32(20, 100_000);

    await expect(
      prepareFaxPacket([source("oversized.png", "image/png", oversized)], disabledCover()),
    ).rejects.toThrow(/too many pixels/i);
  });
});

async function onePagePdf(label: string) {
  const document = await PDFDocument.create();
  document.addPage().drawText(label);
  return document.save();
}

function source(name: string, type: string, bytes: Uint8Array) {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

function disabledCover() {
  return {
    recipient: "",
    sender: "",
    subject: "",
    callbackNumber: "",
    note: "",
    enabled: false,
  };
}

function zeroPagePdf(): Uint8Array {
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n",
  ];
  const offsets: number[] = [];
  let body = header;
  for (const object of objects) {
    offsets.push(new TextEncoder().encode(body).byteLength);
    body += object;
  }
  const xrefOffset = new TextEncoder().encode(body).byteLength;
  body += `xref\n0 3\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(body);
}
