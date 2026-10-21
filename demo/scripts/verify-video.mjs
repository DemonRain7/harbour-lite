import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const demoRoot = fileURLToPath(new URL('..', import.meta.url));
const mediaRoot = path.resolve(demoRoot, '..', 'docs', 'media');
const video = path.join(mediaRoot, 'intro-harbour.mp4');
const qaRoot = path.join(demoRoot, 'qa', 'decoded');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';

function run(binary, args) {
  const result = spawnSync(binary, args, {encoding: 'utf8', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(binary)} failed:\n${result.stderr}`);
  return result.stdout;
}

mkdirSync(qaRoot, {recursive: true});
const metadata = JSON.parse(run(ffprobe, [
  '-v', 'error', '-threads', '2', '-count_frames',
  '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,color_space,color_range,nb_read_frames:format=duration',
  '-of', 'json', video,
]));
const stream = metadata.streams.find(item => item.codec_type === 'video');
assert.equal(metadata.streams.filter(item => item.codec_type === 'audio').length, 0);
assert.equal(stream.codec_name, 'h264');
assert.equal(stream.width, 1920);
assert.equal(stream.height, 1080);
assert.equal(stream.r_frame_rate, '30/1');
assert.equal(stream.pix_fmt, 'yuv420p');
assert.equal(stream.color_space, 'bt709');
assert.equal(stream.color_range, 'tv');
assert.equal(Number(stream.nb_read_frames), 900);
assert.equal(Number(metadata.format.duration), 30);

// A complete decode, separate from metadata inspection. No paid services or model calls.
run(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-threads', '2', '-filter_threads', '2', '-i', video, '-map', '0:v:0', '-f', 'null', '-']);

// Both published PNGs are extracted from the encoded MP4, not a separate render.
run(ffmpeg, ['-nostdin', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-ss', '28', '-i', video,
  '-frames:v', '1', '-threads', '2', '-update', '1', '-y', path.join(mediaRoot, 'intro-harbour-poster.png')]);
const selection = [60, 210, 360, 510, 660, 840].map(frame => `eq(n,${frame})`).join('+');
run(ffmpeg, ['-nostdin', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-i', video,
  '-vf', `select='${selection}',scale=640:360,tile=3x2:padding=12:margin=12:color=0xFAF3E6`,
  '-frames:v', '1', '-threads', '2', '-update', '1', '-y', path.join(mediaRoot, 'intro-harbour-contact-sheet.png')]);

// Additional visual QA: opening, one-second samples, and final hold.
// Scene-specific transition frames are inspected separately from the storyboard.
const boundarySelection = [0, 15, ...Array.from({length: 29}, (_, i) => (i + 1) * 30), 899].map(frame => `eq(n,${frame})`).join('+');
run(ffmpeg, ['-nostdin', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-i', video,
  '-vf', `select='${boundarySelection}'`, '-fps_mode', 'vfr',
  '-threads', '2', '-y', path.join(qaRoot, 'boundary-%02d.png')]);

console.log(JSON.stringify({
  video: 'docs/media/intro-harbour.mp4',
  codec: stream.codec_name,
  width: stream.width,
  height: stream.height,
  fps: 30,
  pixelFormat: stream.pix_fmt,
  colorSpace: stream.color_space,
  durationSeconds: Number(metadata.format.duration),
  decodedFrames: Number(stream.nb_read_frames),
  fullDecode: 'passed',
  posterTimeSeconds: 28,
  contactSheetTimesSeconds: [2, 7, 12, 17, 22, 28],
  audio: 'intentionally silent',
}, null, 2));
