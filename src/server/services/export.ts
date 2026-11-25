import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import type { Report } from './reports';

/** CSV with a UTF-8 BOM (Excel-friendly) and protection against spreadsheet formula injection. */
export function renderCsv(r: Report): string {
  const esc = (v: string | number | null) => {
    if (v == null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a cell that starts like a formula must not execute in Excel/Sheets
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const line = (cells: (string | number | null)[]) => cells.map(esc).join(',');
  const out: string[] = [line([r.title]), line(['Period', `${r.from} to ${r.to}`]), line(['Scope', r.scopeNote]), line(['Generated', `${r.generatedAt} by ${r.generatedBy}`]), '', line(['Metric', 'Value', 'Note'])];
  r.summary.forEach((s) => out.push(line([s.label, s.value, s.hint ?? ''])));
  for (const t of r.tables) { out.push('', line([t.title]), line(t.columns)); t.rows.forEach((row) => out.push(line(row))); }
  if (r.restricted.length) { out.push('', line(['Restricted (not included)'])); r.restricted.forEach((x) => out.push(line([x]))); }
  out.push('', line(['Definitions']), ...r.definitions.map((d) => line([d])));
  return '\uFEFF' + out.join('\r\n') + '\r\n';
}

// PDF uses PDFKit's built-in fonts (Latin text). For other scripts set PDF_FONT_PATH to a TTF that has the glyphs; CSV always keeps all text.
const fontPath = process.env.PDF_FONT_PATH && existsSync(process.env.PDF_FONT_PATH) ? process.env.PDF_FONT_PATH : null;
const clean = (v: string | number | null) => { const s = v == null ? '' : String(v).replace('◉', '[AI]').replace(/→/g, '->').replace(/≥/g, '>='); return fontPath ? s : s.replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022]/g, '?'); };

export function renderPdf(r: Report): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const wide = r.tables.some((t) => t.columns.length > 7);
    const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: clean(r.title), Author: 'FoundersLab' } });
    const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    if (fontPath) { doc.registerFont('body', fontPath); doc.registerFont('bold', fontPath); }
    const F = (bold = false) => doc.font(fontPath ? (bold ? 'bold' : 'body') : bold ? 'Helvetica-Bold' : 'Helvetica');
    const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right, bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

    F(true).fontSize(18).fillColor('#111827').text(clean(r.title), left, doc.y);
    F().fontSize(10).fillColor('#4b5563').text(clean(`${r.subtitle} · ${r.from} to ${r.to}`)).text(clean(`Scope: ${r.scopeNote}`)).text(clean(`Generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC by ${r.generatedBy}`));
    doc.moveDown(0.8);
    if (r.summary.length) {
      F(true).fontSize(12).fillColor('#111827').text('Summary'); doc.moveDown(0.3);
      const colW = width / 2; let y0 = doc.y;
      r.summary.forEach((s, i) => {
        const x = left + (i % 2) * colW; if (i % 2 === 0) { ensure(30); y0 = doc.y; }
        F().fontSize(8).fillColor('#6b7280').text(clean(s.label), x, y0, { width: colW - 10 });
        F(true).fontSize(11).fillColor('#111827').text(clean(s.value), x, doc.y, { width: colW - 10 });
        const yEnd = doc.y; if (i % 2 === 1 || i === r.summary.length - 1) doc.y = Math.max(yEnd, doc.y) + 6; else doc.y = y0;
        if (i % 2 === 0 && i !== r.summary.length - 1) doc.y = y0; 
      });
      doc.x = left; doc.moveDown(0.5);
    }
    for (const t of r.tables) {
      if (!t.rows.length) continue;
      ensure(60); F(true).fontSize(12).fillColor('#111827').text(clean(t.title), left, doc.y); doc.moveDown(0.3);
      const n = t.columns.length, fs = n > 8 ? 6.5 : n > 5 ? 7.5 : 9, w = width / n, pad = 3;
      const rowH = (cells: (string | number | null)[], bold: boolean) => { F(bold).fontSize(fs); return Math.max(...cells.map((c) => doc.heightOfString(clean(c).slice(0, 160), { width: w - pad * 2 }))) + pad * 2; };
      const drawRow = (cells: (string | number | null)[], bold: boolean, fill?: string) => {
        const h = rowH(cells, bold); if (doc.y + h > bottom()) { doc.addPage(); if (!bold) drawRow(t.columns, true, '#e5e7eb'); }
        const y = doc.y; if (fill) doc.rect(left, y, width, h).fill(fill); doc.fillColor('#111827'); F(bold).fontSize(fs);
        cells.forEach((c, i) => doc.text(clean(c).slice(0, 160), left + i * w + pad, y + pad, { width: w - pad * 2, lineBreak: true }));
        doc.moveTo(left, y + h).lineTo(left + width, y + h).strokeColor('#e5e7eb').lineWidth(0.5).stroke(); doc.y = y + h; doc.x = left;
      };
      drawRow(t.columns, true, '#e5e7eb'); t.rows.forEach((row) => drawRow(row, false)); doc.moveDown(0.8);
    }
    if (r.restricted.length) { ensure(40); F(true).fontSize(10).fillColor('#92400e').text('Not included (restricted)', left, doc.y); F().fontSize(8).fillColor('#92400e'); r.restricted.forEach((x) => doc.text('• ' + clean(x))); doc.moveDown(0.5); }
    ensure(40); F(true).fontSize(9).fillColor('#374151').text('Definitions', left, doc.y); F().fontSize(8).fillColor('#6b7280'); r.definitions.forEach((d) => doc.text('• ' + clean(d), { width }));
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) { doc.switchToPage(i); const m = doc.page.margins.bottom; doc.page.margins.bottom = 0; F().fontSize(7).fillColor('#9ca3af').text(`FoundersLab · Confidential · ${clean(r.title)} · Page ${i + 1} of ${pages.count}`, left, doc.page.height - 24, { width, align: 'center', lineBreak: false }); doc.page.margins.bottom = m; }
    doc.end();
  });
}
