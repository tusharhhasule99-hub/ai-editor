# Video Stitcher

Stitch any number of videos into one file with Node.js + FFmpeg.

## Requirements

- Node.js 18+
- [FFmpeg](https://ffmpeg.org/download.html) installed and on your `PATH`

```bash
# macOS
brew install ffmpeg
```

## Usage

### CLI

```bash
# Fast path (stream copy) — best when all clips share codec / resolution / fps
node stitch.js clip1.mp4 clip2.mp4 clip3.mp4 output.mp4

# Re-encode when clips differ (slower, more compatible)
node stitch.js clip1.mp4 clip2.mp4 clip3.mp4 output.mp4 --reencode
```

### As a module

```js
import { stitch } from "./stitch.js";

const out = await stitch(
  ["a.mp4", "b.mp4", "c.mp4"],
  "final.mp4"
  // { reencode: true }  // optional
);

console.log(out);
```

## Notes

| Mode | Flag | When to use |
|------|------|-------------|
| Stream copy | (default) | Same format clips — near-instant, no quality loss |
| Re-encode | `--reencode` | Mixed codecs, sizes, or frame rates |
