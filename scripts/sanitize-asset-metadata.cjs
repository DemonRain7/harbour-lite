"use strict";
// Lossless packaging hygiene: remove descriptive metadata, never repaint or recompress pixels.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const root = path.resolve(__dirname, "..");
const directories = ["web/assets", "desktop/renderer/assets/startup"];
const write = process.argv.includes("--write");

function strip(bytes) {
  const removed = [];
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    const parts = [bytes.subarray(0,8)];
    for (let i=8; i<bytes.length;) {
      if (i+12>bytes.length) throw Error("Invalid PNG chunk");
      const length=bytes.readUInt32BE(i), end=i+length+12, type=bytes.toString("ascii",i+4,i+8);
      if (end>bytes.length) throw Error("Invalid PNG length");
      if (["tEXt","zTXt","iTXt","eXIf"].includes(type)) removed.push(type);
      else parts.push(bytes.subarray(i,end));
      i=end;
    }
    return { bytes:Buffer.concat(parts), removed };
  }
  if (bytes[0]===255 && bytes[1]===216) {
    const parts=[bytes.subarray(0,2)];
    let i=2;
    while (i<bytes.length) {
      if (bytes[i]!==255 || i+1>=bytes.length) throw Error("Invalid JPEG marker");
      const marker=bytes[i+1];
      if (marker===0xda || marker===0xd9) { parts.push(bytes.subarray(i));break; }
      if (i+4>bytes.length) throw Error("Invalid JPEG length");
      const length=bytes.readUInt16BE(i+2),end=i+length+2;
      if (length<2 || end>bytes.length) throw Error("Invalid JPEG segment");
      if ([0xe1,0xed,0xfe].includes(marker)) removed.push(`JPEG-${marker.toString(16)}`);
      else parts.push(bytes.subarray(i,end));
      i=end;
    }
    return {bytes:Buffer.concat(parts),removed};
  }
  if (bytes.toString("ascii",0,4)==="RIFF" && bytes.toString("ascii",8,12)==="WEBP") {
    const parts=[Buffer.from(bytes.subarray(0,12))];
    for(let i=12;i<bytes.length;) {
      if(i+8>bytes.length)throw Error("Invalid WebP chunk");
      const length=bytes.readUInt32LE(i+4),end=i+8+length+(length%2),type=bytes.toString("ascii",i,i+4);
      if(end>bytes.length)throw Error("Invalid WebP length");
      if(["EXIF","XMP "].includes(type))removed.push(type);
      else {const part=Buffer.from(bytes.subarray(i,end));if(type==="VP8X")part[8]&=~0x0c;parts.push(part);}
      i=end;
    }
    const result=Buffer.concat(parts);result.writeUInt32LE(result.length-8,4);
    return {bytes:result,removed};
  }
  throw Error("Unsupported image format");
}

async function main() {
  const report=[];
  for(const dir of directories) for(const name of fs.readdirSync(path.join(root,dir))) {
    if(!/\.(png|jpe?g|webp)$/i.test(name))continue;
    const relative=`${dir}/${name}`,file=path.join(root,relative),original=fs.readFileSync(file);
    const metadata=await sharp(original).metadata();
    if(metadata.orientation && metadata.orientation!==1)throw Error(`Orientation requires explicit review: ${relative}`);
    const before=await sharp(original).raw().toBuffer(),cleaned=strip(original);
    const after=await sharp(cleaned.bytes).raw().toBuffer();
    if(!before.equals(after))throw Error(`Pixel integrity check failed: ${relative}`);
    if(write && cleaned.removed.length)fs.writeFileSync(file,cleaned.bytes);
    report.push({file:relative,removed:cleaned.removed,pixelsUnchanged:true,
      pixelSha256:crypto.createHash("sha256").update(after).digest("hex")});
  }
  console.log(JSON.stringify({mode:write?"write":"check",images:report},null,2));
  if(!write && report.some(item=>item.removed.length))process.exitCode=1;
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={strip};
