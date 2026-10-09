/** A complete, uncompressed one-page PDF for isolated document tests. */
export function simplePdf(): Buffer {
  const content = 'BT /F1 12 Tf 20 50 Td (SKU TEST LABEL) Tj ET\n';
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.4\n'; const offsets: number[] = [];
  for (const [i, value] of bodies.entries()) { offsets.push(Buffer.byteLength(body)); body += `${i+1} 0 obj\n${value}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  return Buffer.from(body + `xref\n0 ${bodies.length+1}\n0000000000 65535 f \n` + offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('') + `trailer\n<< /Root 1 0 R /Size ${bodies.length+1} >>\nstartxref\n${xref}\n%%EOF\n`);
}
