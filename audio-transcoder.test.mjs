import test from "node:test";
import assert from "node:assert/strict";

import {
  friendlyTranscodeError,
  prepareLargeUpload,
} from "./audio-transcoder.mjs";

test("returns an actionable fallback for unsupported or corrupt audio", () => {
  const error = friendlyTranscodeError(new Error("invalid data"));
  assert.match(error.message, /MP3, M4A.*MP4/);
  assert.match(error.message, /erneut auswählen/);
  assert.match(error.message, /invalid data/);
});

test("does not invoke the heavyweight transcoder for uploadable files", async () => {
  await assert.rejects(
    prepareLargeUpload({ size: 1_000_000 }),
    /nur für Dateien über dem sicheren Upload-Limit/,
  );
});
