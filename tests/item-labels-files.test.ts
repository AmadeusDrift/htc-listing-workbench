import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLabelPdf } from '../src/main/item-labels/files.ts';
import { PDFDocument } from 'pdf-lib';

function pdf(objects:string[],root='1 0 R'){
  let body='%PDF-1.4\n';const offsets=[0];for(const [index,object]of objects.entries()){offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const start=Buffer.byteLength(body);return Buffer.from(body+`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root ${root} >>\nstartxref\n${start}\n%%EOF\n`);
}
test('PDF validation rejects framing-only junk with no objects or document trailer',async()=>{
  const bytes=Buffer.from('%PDF-1.4\nxref\n'+'junk\n'.repeat(20)+'startxref\n9\n%%EOF\n');
  await assert.rejects(async()=>validateLabelPdf(bytes));
});
for(const [name,objects]of [
  ['no page tree',['<< /Type /Catalog >>']],
  ['empty pages',['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 0 /Kids [] >>']],
  ['dangling page reference',['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>']],
  ['cyclic page tree',['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [2 0 R] >>']],
  ['wrong page count',['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 2 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>']]
] as const)test(`PDF validation rejects ${name}`,async()=>{await assert.rejects(async()=>validateLabelPdf(pdf([...objects])));});
test('a normal PDF with an actual page tree is accepted',async()=>{
  await validateLabelPdf(pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>']));
});
test('compressed object streams and an XRef stream are valid printable PDFs',async()=>{
  const document=await PDFDocument.create();document.addPage([100,100]).drawText('Label');const bytes=Buffer.from(await document.save({useObjectStreams:true}));
  assert.ok(bytes.includes(Buffer.from('/ObjStm')));assert.ok(bytes.includes(Buffer.from('/Type /XRef')));await validateLabelPdf(bytes);
});
test('a catalog cannot replace a missing or invalid declared document trailer',async()=>{
  const bytes=pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>']);
  await assert.rejects(async()=>validateLabelPdf(Buffer.from(bytes.toString().replace('trailer','garbage'))));
  await assert.rejects(async()=>validateLabelPdf(Buffer.from(bytes.toString().replace('/Root 1 0 R','/Root 9 0 R'))));
});
