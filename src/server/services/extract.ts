import JSZip from 'jszip';

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export const KNOWLEDGE_FILE_TYPES: Record<string, string[]> = {
  txt: ['text/plain'], md: ['text/markdown', 'text/plain'], csv: ['text/csv', 'text/plain'], pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'],
};
const MAX_TEXT = 500_000;

/** Extracts searchable text. Returns ok:false for formats we store but cannot read (images, scanned PDFs). Never executes document content. */
export async function extractText(fileName: string, buf: Buffer): Promise<{ text: string; ok: boolean }> {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  try {
    if (['txt', 'md', 'csv'].includes(ext)) return { text: buf.toString('utf8').replace(/^\uFEFF/, '').slice(0, MAX_TEXT), ok: true };
    if (ext === 'docx') { const z = await JSZip.loadAsync(buf); const x = await z.file('word/document.xml')?.async('string'); if (!x) return { text: '', ok: false }; return { text: decode(x.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).slice(0, MAX_TEXT), ok: true }; }
    if (ext === 'pptx') { const z = await JSZip.loadAsync(buf); const names = Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(); const parts: string[] = []; for (const n of names) parts.push(decode((await z.file(n)!.async('string')).replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, ''))); return { text: parts.join('\n\n').slice(0, MAX_TEXT), ok: parts.length > 0 }; }
    if (ext === 'xlsx') { const z = await JSZip.loadAsync(buf); const x = await z.file('xl/sharedStrings.xml')?.async('string'); if (!x) return { text: '', ok: false }; return { text: decode(x.replace(/<\/si>/g, '\n').replace(/<[^>]+>/g, '')).slice(0, MAX_TEXT), ok: true }; }
    if (ext === 'pdf') { const { extractText: pdfText, getDocumentProxy } = await import('unpdf'); const pdf = await getDocumentProxy(new Uint8Array(buf)); const { text } = await pdfText(pdf, { mergePages: true }); const t = (Array.isArray(text) ? text.join('\n') : text).trim(); return { text: t.slice(0, MAX_TEXT), ok: t.length > 0 }; }
  } catch { /* corrupt or unsupported file: stored, not searchable */ }
  return { text: '', ok: false };
}
