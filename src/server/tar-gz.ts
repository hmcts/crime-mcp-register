/**
 * Minimal tar.gz writer -- handcrafted ustar format + Node's built-in zlib.
 *
 * Why not depend on tar-stream / archiver:
 *   - tar.gz format is simple enough to write in ~60 lines
 *   - No new supply-chain surface
 *   - This usage (small flat archive of UTF-8 text files) doesn't need the
 *     long-name extensions or sparse-file handling a full lib provides
 *
 * What it produces:
 *   A standard tar.gz that `tar -xf` (BSD/GNU/Windows) and 7-zip can read.
 *   Each entry is a regular file with mode 0644, owner 0, mtime = now.
 *   Paths are stored relative -- e.g. "crime-frontend-claude/cp-angular/PDK.md"
 *   so `tar -xf bundle.tar.gz -C ~/` writes to "~/crime-frontend-claude/...".
 *
 * Encoding contract:
 *   File contents are written as UTF-8 bytes, no BOM, regardless of the
 *   developer's locale. Extracting tools preserve those bytes verbatim --
 *   no re-encoding, no character mangling.
 *
 * SOLID:
 *   - Pure function: (entries) => Buffer
 *   - No I/O, no caching
 *   - Each helper has a single concern
 */

import { gzipSync } from 'node:zlib';

export interface TarEntry {
  /** Path relative to the extraction root. No leading slash. */
  path: string;
  /** UTF-8 text content. Will be encoded as UTF-8 bytes, no BOM. */
  content: string;
}

const BLOCK = 512;

export function buildTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);

  for (const entry of entries) {
    const data = Buffer.from(entry.content, 'utf-8');
    const header = buildHeader(entry.path, data.length, mtime);
    blocks.push(header);
    blocks.push(data);
    // Pad to BLOCK boundary
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }

  // Two empty blocks signal end-of-archive
  blocks.push(Buffer.alloc(BLOCK));
  blocks.push(Buffer.alloc(BLOCK));

  const tar = Buffer.concat(blocks);
  return gzipSync(tar);
}

function buildHeader(path: string, size: number, mtime: number): Buffer {
  if (path.length > 100) {
    // ustar format reserves 100 bytes for name + 155 for prefix.
    // For our flat-tree use case (paths under ~80 chars) this never trips.
    // If it does in future, we'd need to split into prefix + name; not now.
    throw new Error(`tar entry path too long (>100 bytes): ${path}`);
  }

  const header = Buffer.alloc(BLOCK);
  // name
  header.write(path, 0, 100, 'utf-8');
  // mode (octal "0000644 \0")
  header.write('0000644', 100, 7, 'ascii');
  header.write('\0', 107, 1, 'ascii');
  // uid (octal "0000000 \0")
  header.write('0000000', 108, 7, 'ascii');
  header.write('\0', 115, 1, 'ascii');
  // gid
  header.write('0000000', 116, 7, 'ascii');
  header.write('\0', 123, 1, 'ascii');
  // size (12 bytes octal, NUL-terminated)
  header.write(size.toString(8).padStart(11, '0'), 124, 11, 'ascii');
  header.write('\0', 135, 1, 'ascii');
  // mtime
  header.write(mtime.toString(8).padStart(11, '0'), 136, 11, 'ascii');
  header.write('\0', 147, 1, 'ascii');
  // checksum placeholder (8 spaces while computing)
  header.write('        ', 148, 8, 'ascii');
  // typeflag '0' = regular file
  header.write('0', 156, 1, 'ascii');
  // linkname (100 bytes, all NUL)
  // already zeroed by Buffer.alloc
  // ustar magic + version
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  // uname / gname
  header.write('root', 265, 4, 'ascii');
  header.write('root', 297, 4, 'ascii');
  // (devmajor / devminor / prefix all stay zero)

  // Compute checksum: sum of all bytes, header[148..156] treated as spaces
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  // Write checksum as 6-digit octal + NUL + space
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header.write('\0', 154, 1, 'ascii');
  header.write(' ', 155, 1, 'ascii');

  return header;
}
