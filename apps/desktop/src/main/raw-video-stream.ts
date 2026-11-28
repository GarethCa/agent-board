// Raw BGRA frames as a Matroska stream, for an ffmpeg to read from a pipe. A build of ffmpeg may leave out the bare
// `rawvideo` input yet read Matroska, whose uncompressed video track carries the same frames with their size and
// pixel format in its header. The stream is written as it goes: the segment's size is unknown, and each frame is a
// cluster of its own, of a size known up front.

/** Timestamps count microseconds, so a frame's lands within half of one of its exact time at any frame rate. */
const TIMESTAMP_SCALE_NS = 1_000;

/** An element's ID, which carries its own length marker, as bytes. */
function id(value: number): Buffer {
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from(bytes);
}

/** `size` as an 8-byte EBML length. */
function size(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  bytes[0] = 0x01;
  return bytes;
}

/** An 8-byte length that says "unknown": the segment, which runs until the stream ends. */
const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

const element = (elementId: number, ...body: Buffer[]) => {
  const data = Buffer.concat(body);
  return Buffer.concat([id(elementId), size(data.length), data]);
};

const uint = (elementId: number, value: number) => {
  const data = Buffer.alloc(8);
  data.writeBigUInt64BE(BigInt(value));
  return element(elementId, data);
};

const text = (elementId: number, value: string) => element(elementId, Buffer.from(value, 'ascii'));

/** The stream's start: the EBML header, then the segment's info and its one video track, of `width` × `height` at `fps`. */
export function rawVideoHeader({ width, height, fps }: { width: number; height: number; fps: number }): Buffer {
  const ebml = element(
    0x1a45dfa3,
    uint(0x4286, 1), // EBMLVersion
    uint(0x42f7, 1), // EBMLReadVersion
    uint(0x42f2, 4), // EBMLMaxIDLength
    uint(0x42f3, 8), // EBMLMaxSizeLength
    text(0x4282, 'matroska'), // DocType
    uint(0x4287, 4), // DocTypeVersion
    uint(0x4285, 2), // DocTypeReadVersion
  );
  const info = element(0x1549a966, uint(0x2ad7b1, TIMESTAMP_SCALE_NS), text(0x4d80, 'demo-capture'), text(0x5741, 'demo-capture'));
  const video = element(0xe0, uint(0xb0, width), uint(0xba, height), element(0x2eb524, Buffer.from('BGRA', 'ascii')));
  const track = element(
    0xae,
    uint(0xd7, 1), // TrackNumber
    uint(0x73c5, 1), // TrackUID
    uint(0x83, 1), // TrackType: video
    text(0x86, 'V_UNCOMPRESSED'), // CodecID
    uint(0x23e383, Math.round(1e9 / fps)), // DefaultDuration, in nanoseconds
    video,
  );
  return Buffer.concat([ebml, id(0x18538067), UNKNOWN_SIZE, info, element(0x1654ae6b, track)]);
}

/** What goes before frame number `index` (from 0) of `frameBytes` bytes: its cluster's header and its block's. */
export function rawVideoFrameHeader(index: number, frameBytes: number, fps: number): Buffer {
  const timestamp = uint(0xe7, Math.round((index * 1e9) / fps / TIMESTAMP_SCALE_NS));
  // The block: track 1, at the cluster's own time, a keyframe.
  const block = Buffer.from([0x81, 0x00, 0x00, 0x80]);
  const simpleBlock = Buffer.concat([id(0xa3), size(block.length + frameBytes), block]);
  return Buffer.concat([id(0x1f43b675), size(timestamp.length + simpleBlock.length + frameBytes), timestamp, simpleBlock]);
}
