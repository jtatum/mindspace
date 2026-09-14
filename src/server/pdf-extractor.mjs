import { open, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MAX_PAPER_TEXT_CHARACTERS } from './file-limits.ts';

const [pdf, destination] = process.argv.slice(2);
const temporary = `${destination}.${process.pid}.tmp`;
let loadingTask;
try {
  const handle = await open(pdf, 'r');
  let bytes;
  try {
    if ((await handle.stat()).size > 150_000_000) throw new Error('PDF exceeds the extraction size limit');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  const resources = new URL('../../', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  // A view of the buffer avoids a second full-PDF allocation.
  loadingTask = getDocument({ data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), disableFontFace: true, useSystemFonts: false, standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', resources)), cMapUrl: fileURLToPath(new URL('cmaps/', resources)), cMapPacked: true });
  const document = await loadingTask.promise;
  let text = ''; let extractedCharacters = 0; let textTruncated = document.numPages > 300;
  for (let number = 1; number <= Math.min(document.numPages, 300); number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
    extractedCharacters += pageText.trim().length;
    text += `\n\n--- Page ${number} ---\n${pageText}`;
    page.cleanup();
    if (text.length > MAX_PAPER_TEXT_CHARACTERS) { text = text.slice(0, MAX_PAPER_TEXT_CHARACTERS); textTruncated = true; break; }
  }
  if (!extractedCharacters) throw new Error('PDF saved, but no readable text was extracted. It may require OCR.');
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, destination);
  process.send?.({ pages: document.numPages, textTruncated });
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await loadingTask?.destroy();
  await rm(temporary, { force: true });
  process.disconnect?.();
}
