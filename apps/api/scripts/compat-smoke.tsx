/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Task 0.1 compatibility smoke test: proves each native/ESM dependency works on this Node version.
// Requires DATABASE_URL (PostgreSQL 16) and REDIS_URL for the Prisma and BullMQ parts.
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { Queue, QueueEvents, Worker } from 'bullmq';
import ExcelJS from 'exceljs';
import { generate, generateSecret, verify } from 'otplib';
import sharp from 'sharp';

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try { results.push({ name, ok: true, detail: await fn() }); }
  catch (e) { results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
}

await check('sharp', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00756f' } }).png().toBuffer();
  const webp = await sharp(png).resize(32).webp().toBuffer();
  const meta = await sharp(webp).metadata();
  return `sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}: png→webp ${meta.width}x${meta.height}`;
});
await check('argon2', async () => {
  const hash = await argon2.hash('correct horse', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  if (!(await argon2.verify(hash, 'correct horse')) || (await argon2.verify(hash, 'wrong'))) throw new Error('verify mismatch');
  return 'argon2id hash/verify (m=19456,t=2,p=1)';
});
await check('otplib', async () => {
  const secret = generateSecret();
  const token = await generate({ secret });
  const res = await verify({ secret, token });
  if (!res.valid) throw new Error('TOTP did not verify');
  return `TOTP ${token.length} digits verified`;
});
await check('exceljs', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Products').addRow(['SKU', 'Price']).commit();
  wb.getWorksheet('Products')!.addRow(['RES-21-300G', 49900]);
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  return `xlsx round-trip: ${back.getWorksheet('Products')!.getRow(2).getCell(1).value}`;
});
await check('@react-pdf/renderer', async () => {
  const pdf = await renderToBuffer(<Document><Page size="A4"><Text>ArtQ invoice smoke test</Text></Page></Document>);
  if (pdf.subarray(0, 4).toString() !== '%PDF') throw new Error('not a PDF');
  return `PDF ${pdf.length} bytes`;
});
await check('prisma', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const prisma = new PrismaClient();
  try {
    const [{ version }] = await prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    const n = await prisma.productType.count();
    return `${version.split(',')[0]}; productType.count() = ${n}`;
  } finally { await prisma.$disconnect(); }
});
await check('bullmq', async () => {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL not set');
  const u = new URL(process.env.REDIS_URL);
  const connection = { host: u.hostname, port: Number(u.port || 6379) };
  const q = new Queue('compat', { connection }); const ev = new QueueEvents('compat', { connection });
  const w = new Worker('compat', async (job) => job.data.n * 2, { connection });
  try {
    await ev.waitUntilReady();
    const job = await q.add('double', { n: 21 }, { jobId: 'compat-1' });
    const out = await job.waitUntilFinished(ev, 10_000);
    return `job ${job.id} → ${out}`;
  } finally { await w.close(); await ev.close(); await q.obliterate({ force: true }); await q.close(); }
});

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
console.log(`node ${process.version} ${process.platform}-${process.arch}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
