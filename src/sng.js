// Dependency-free parser for the .sng container format
// (https://github.com/mdsitton/SngFileFormat). A .sng bundles a chart
// (notes.chart / notes.mid), audio (song.* or per-instrument stems), album
// art, and a song.ini-style metadata block, all behind a simple XOR mask.
//
// Layout:
//   "SNGPKG"            6 bytes
//   version             u32
//   xorMask             16 bytes
//   metadataLen         u64   (covers the count + all entries below)
//   metadataCount       u64
//     [ keyLen i32, key, valLen i32, value ] * count
//   fileMetaLen         u64   (covers the count + all entries below)
//   fileMetaCount       u64
//     [ nameLen u8, name, contentsLen u64, contentsIndex u64 ] * count
//   fileDataLen         u64
//   <file data>               (each file masked; contentsIndex is absolute)
//
// Unmask:  out[i] = data[i] ^ xorMask[i & 15] ^ (i & 0xFF)   (i is per-file)

const MAGIC = 'SNGPKG';
const td = new TextDecoder('utf-8');

// .sng lengths/offsets are u64 but comfortably fit in a JS Number for any
// realistic chart (<< 2^53 bytes).
function readU64(view, p) {
  const lo = view.getUint32(p, true);
  const hi = view.getUint32(p + 4, true);
  return hi * 4294967296 + lo;
}

export function parseSng(arrayBuffer) {
  const buf = arrayBuffer instanceof ArrayBuffer
    ? arrayBuffer
    : arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let p = 0;

  if (td.decode(bytes.subarray(0, 6)) !== MAGIC) {
    throw new Error('Not a .sng file (missing SNGPKG header).');
  }
  p = 6;
  const version = view.getUint32(p, true); p += 4;
  const xorMask = bytes.subarray(p, p + 16); p += 16;

  // ---- metadata
  const metaLen = readU64(view, p); p += 8;
  const metaEnd = p + metaLen;
  const metaCount = readU64(view, p); p += 8;
  const metadata = {};
  for (let i = 0; i < metaCount; i++) {
    const kl = view.getInt32(p, true); p += 4;
    const key = td.decode(bytes.subarray(p, p + kl)); p += kl;
    const vl = view.getInt32(p, true); p += 4;
    const val = td.decode(bytes.subarray(p, p + vl)); p += vl;
    metadata[key] = val;
  }
  p = metaEnd;

  // ---- file index
  const fmLen = readU64(view, p); p += 8;
  const fmEnd = p + fmLen;
  const fmCount = readU64(view, p); p += 8;
  const files = {};
  for (let i = 0; i < fmCount; i++) {
    const nl = view.getUint8(p); p += 1;
    const name = td.decode(bytes.subarray(p, p + nl)); p += nl;
    const contentsLen = readU64(view, p); p += 8;
    const contentsIndex = readU64(view, p); p += 8;
    files[name] = { offset: contentsIndex, length: contentsLen };
  }

  function getFile(name) {
    const f = files[name];
    if (!f) return null;
    const out = new Uint8Array(f.length);
    const base = f.offset;
    for (let i = 0; i < f.length; i++) {
      out[i] = bytes[base + i] ^ xorMask[i & 15] ^ (i & 0xFF);
    }
    return out;
  }

  function findFile(pred) {
    const name = Object.keys(files).find(pred);
    return name ? getFile(name) : null;
  }

  return {
    version,
    metadata,
    xorMask,
    fileList: Object.keys(files),
    getFile,
    findFile,
  };
}
