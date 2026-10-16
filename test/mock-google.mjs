// A stand-in for the Gemini API for manual checks: `node test/mock-google.mjs`, then
// GEMINI_API_ORIGIN=http://127.0.0.1:8799 GEMINI_API_KEY=mock npm run dev
// It answers every generateContent call with a gradient picture, so the editor can be tried without a billing key.
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function gradientPng(width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = Math.round((x / width) * 255);
      row[2 + x * 3] = Math.round((y / height) * 255);
      row[3 + x * 3] = 180;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const port = Number(process.env.PORT ?? 8799);
createServer((req, res) => {
  const chunks = [];
  req.on('data', (piece) => chunks.push(piece));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const text = JSON.stringify(body.contents ?? '');
    // Trigger failures by putting a word in the prompt: quota, busy, gone, words, blocked.
    const fail = (status, message) => {
      res.statusCode = status;
      res.end(JSON.stringify({ error: { code: status, message } }));
    };
    if (text.includes('quota')) return fail(429, 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0');
    if (text.includes('busy')) return fail(503, 'This model is currently experiencing high demand.');
    if (text.includes('gone')) return fail(404, 'models/x is not found');
    const wantsImage = body.generationConfig?.responseModalities?.includes('IMAGE');
    if (text.includes('words')) {
      res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'I would rather talk about it.' }] } }] }));
      return;
    }
    if (text.includes('blocked')) {
      res.end(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }));
      return;
    }
    const parts = wantsImage
      ? [{ text: 'Mock Gemini: here is your edit.' }, { inlineData: { mimeType: 'image/png', data: gradientPng(640, 360).toString('base64') } }]
      : [{ text: 'Mock Gemini: a simple line drawing on white paper.' }];
    res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts } }] }));
  });
}).listen(port, '127.0.0.1', () => console.log(`mock Gemini on http://127.0.0.1:${port}`));
