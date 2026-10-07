import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, openSync, writeSync, ftruncateSync, closeSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAudioPartArguments, SAFE_AUDIO_PART_BYTES } from "./audio-utils.mjs";

const available = ["ffmpeg", "ffprobe"].every((command) => spawnSync(command, ["-version"]).status === 0);
test("real five-hour stereo WAV larger than 3 GB yields complete first and last ten-minute parts", { skip: !available }, () => {
  const dir = mkdtempSync(join(tmpdir(), "transcription-five-hours-"));
  try {
    const input = join(dir, "five-hours.wav");
    const bytes = 18000 * 48000 * 2 * 2;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(bytes + 36, 4);
    header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
    header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(bytes, 40);
    const fd = openSync(input, "w");
    writeSync(fd, header); ftruncateSync(fd, bytes + 44); closeSync(fd);
    assert.ok(statSync(input).size > 3_000_000_000);
    for (const index of [0, 29]) {
      const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...buildAudioPartArguments(input, index, 18000)], {
        cwd: dir, timeout: 60000, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const part = join(dir, "part.wav");
      assert.ok(statSync(part).size < SAFE_AUDIO_PART_BYTES);
      // Validate the actual WAV data length rather than trusting FFmpeg logs.
      // ffprobe is bundled alongside native ffmpeg in the integration environment.
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", part], { encoding: "utf8" });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(Number(probe.stdout.trim()), 600);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
