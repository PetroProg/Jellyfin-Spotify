const { db } = require('./dist/db');
const fs = require('fs');

console.log('--- TRACK STATS ---');
const totalTracks = db.prepare('SELECT COUNT(*) as c FROM tracks').get().c;
console.log('Total tracks in DB:', totalTracks);

const sample = db.prepare('SELECT id, title, artist, file_path FROM tracks LIMIT 20').all();
console.log('Sample tracks:');
sample.forEach(t => {
  const exists = fs.existsSync(t.file_path);
  let size = 0;
  if (exists) size = fs.statSync(t.file_path).size;
  console.log(`[${t.id}] ${t.artist} - ${t.title} | exists: ${exists} | size: ${(size/(1024*1024)).toFixed(2)} MB | path: ${t.file_path}`);
});

console.log('--- EXTENSIONS ---');
const allPaths = db.prepare('SELECT file_path FROM tracks').all();
const extCounts = {};
let missingCount = 0;
let largeCount = 0; // > 15MB
allPaths.forEach(t => {
  const p = t.file_path || '';
  const ext = p.split('.').pop()?.toLowerCase() || 'unknown';
  extCounts[ext] = (extCounts[ext] || 0) + 1;
  if (!fs.existsSync(p)) missingCount++;
  else {
    const s = fs.statSync(p).size;
    if (s > 15 * 1024 * 1024) largeCount++;
  }
});
console.log('Extensions:', extCounts);
console.log('Missing files on disk:', missingCount);
console.log('Large files (>15MB):', largeCount);

