import fs from "fs";
import { Readable } from "stream";
import { NextResponse } from "next/server";

// Serves a local video file with HTTP Range support. Without this, browsers
// can still play a video from the start, but setting video.currentTime to
// seek silently no-ops — the browser needs the server to answer 206 Partial
// Content for a Range request to seek, and refuses if it only ever sees
// plain 200 responses with no Accept-Ranges.
export function streamVideoFile(request, filePath, filename) {
  const stat = fs.statSync(filePath);
  const range = request.headers.get("range");

  if (!range) {
    const stream = fs.createReadStream(filePath);
    return new NextResponse(Readable.toWeb(stream), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size.toString(),
        "Accept-Ranges": "bytes",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match?.[1] ? parseInt(match[1], 10) : 0;
  const end = match?.[2] ? parseInt(match[2], 10) : stat.size - 1;
  const chunkSize = end - start + 1;

  const stream = fs.createReadStream(filePath, { start, end });
  return new NextResponse(Readable.toWeb(stream), {
    status: 206,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": chunkSize.toString(),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
