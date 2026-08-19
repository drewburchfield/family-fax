export function PdfPreview({
  url,
  pageCount,
  filename = "fax-packet.pdf",
}: {
  url: string | null;
  pageCount: number | null;
  filename?: string;
}) {
  if (!url) {
    return (
      <div className="preview-placeholder">
        <span>Preview</span>
        <p>Your exact fax packet will appear here after preparation.</p>
      </div>
    );
  }
  return (
    <section className="pdf-preview" aria-labelledby="preview-heading">
      <div className="section-heading-row">
        <div>
          <p className="section-kicker">What will be sent</p>
          <h2 id="preview-heading">Final packet</h2>
        </div>
        <span className="page-count">
          {pageCount === null ? "Page count unavailable" : `${pageCount} ${pageCount === 1 ? "page" : "pages"}`}
        </span>
      </div>
      <iframe title="Final fax packet preview" src={url} />
      <a href={url} download={filename}>Open or download the PDF</a>
    </section>
  );
}
