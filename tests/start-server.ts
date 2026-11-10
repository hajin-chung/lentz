import { mkdir, writeFile, chmod, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { utils, write } from 'xlsx';

const base = '/tmp/lentz-e2e';
await rm(base, { recursive: true, force: true });
const root = path.join(base, 'files');
const dataDirectory = path.join(base, 'state');
await mkdir(path.join(root, 'nested'), { recursive: true });
await mkdir(dataDirectory, { recursive: true });
await writeFile(
  path.join(root, 'notes.md'),
  '# A quiet workspace\n\nA **rendered** markdown document.\n\n![Local image](picture.svg)\n',
);
await writeFile(path.join(root, 'edit.txt'), 'Original contents\n');
await writeFile(path.join(root, 'data.csv'), 'Name,Score\nAda,42\nGrace,99\n');
await writeFile(
  path.join(root, 'index.html'),
  '<!doctype html><html><body><h1>HTML preview</h1><p id="status">Script off</p><script>document.getElementById("status").textContent="Script on";fetch("/api/bootstrap").then(()=>document.body.dataset.leaked="yes").catch(()=>{});</script></body></html>',
);
await writeFile(
  path.join(root, 'picture.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" rx="24" fill="#dde9df"/><circle cx="200" cy="120" r="65" fill="#4c7663"/></svg>',
);
await writeFile(path.join(root, '.hidden'), 'hidden');
const wav = Buffer.alloc(44 + 8000);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(8000, 28);
wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34);
wav.write('data', 36);
wav.writeUInt32LE(8000, 40);
wav.fill(128, 44);
await writeFile(path.join(root, 'sound.wav'), wav);
await copyFile(path.resolve('tests/fixtures/video.webm'), path.join(root, 'clip.webm'));
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
const stream = 'BT /F1 18 Tf 40 350 Td (PDF fixture) Tj ET';
objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
let pdf = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((object, index) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf +=
  `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
  offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('') +
  `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
await writeFile(path.join(root, 'document.pdf'), pdf);
const workbook = utils.book_new();
utils.book_append_sheet(
  workbook,
  utils.aoa_to_sheet([
    ['Name', 'Count'],
    ['Ada', 42],
  ]),
  'People',
);
utils.book_append_sheet(workbook, utils.aoa_to_sheet([['Second sheet']]), 'More');
await writeFile(
  path.join(root, 'book.xlsx'),
  write(workbook, { type: 'buffer', bookType: 'xlsx' }),
);
await writeFile(
  path.join(root, 'legacy.xls'),
  write(workbook, { type: 'buffer', bookType: 'biff8' }),
);
await chmod(path.resolve('tests/fake-pi.mjs'), 0o755);
const app = await createApp({
  root,
  dataDirectory,
  sessionDirectory: path.join(base, 'sessions'),
  piCommand: path.resolve('tests/fake-pi.mjs'),
  host: '127.0.0.1',
  port: 4327,
  dev: true,
});
await app.listen({ host: '127.0.0.1', port: 4327 });
console.log('Test server ready on 4327');
process.on('SIGTERM', async () => {
  app.server.closeAllConnections();
  await app.close();
});
