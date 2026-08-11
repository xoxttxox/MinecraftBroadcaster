import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = process.cwd();
const outputFile = path.join(root, 'build.zip');

const staticFiles = [
  ['build/main.js', 'build/main.js'],
  ['config.example.yml', 'config.example.yml'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
];

const generatedFiles = [
  ['install.bat', '@echo off\r\nsetlocal\r\necho Installing production dependencies...\r\nnpm ci --omit=dev\r\nif errorlevel 1 exit /b %errorlevel%\r\nif not exist config.yml copy /Y config.example.yml config.yml >nul\r\necho.\r\necho Ready. Edit config.yml, then run start.bat\r\n'],
  ['start.bat', '@echo off\r\nnode build/main.js\r\n'],
  ['install.sh', '#!/usr/bin/env sh\nset -eu\necho "Installing production dependencies..."\nnpm ci --omit=dev\nif [ ! -f config.yml ]; then cp config.example.yml config.yml; fi\necho\necho "Ready. Edit config.yml, then run ./start.sh"\n'],
  ['start.sh', '#!/usr/bin/env sh\nset -eu\nexec node build/main.js\n'],
];

for (const [source] of staticFiles) {
  const fullPath = path.join(root, source);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing release file: ${source}`);
  }
}

const entries = [
  ...staticFiles.map(([source, archiveName]) => ({
    name: archiveName,
    data: fs.readFileSync(path.join(root, source)),
  })),
  ...generatedFiles.map(([name, content]) => ({
    name,
    data: Buffer.from(content, 'utf8'),
  })),
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZip(items) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = dosDateTime();

  for (const item of items) {
    const name = Buffer.from(item.name.replaceAll('\\\\', '/'), 'utf8');
    const raw = item.data;
    const compressed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(now.dosTime, 10);
    local.writeUInt16LE(now.dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix, version 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(now.dosTime, 12);
    central.writeUInt16LE(now.dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const isShellScript = item.name.endsWith('.sh');
    const unixMode = isShellScript ? 0o100755 : 0o100644;
    central.writeUInt32LE((unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

const zip = createZip(entries);
fs.writeFileSync(outputFile, zip);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(`Release ready: build.zip (${pkg.name} v${pkg.version})`);
console.log('Included:');
for (const entry of entries) console.log(`  - ${entry.name}`);
