import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { probeAudioMetadata, probeVideoMetadata } from "../../src/core/video-metadata.js";

const execFileAsync = promisify(execFile);

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-video-metadata-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function hasFfprobe() {
  try {
    await execFileAsync("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

test("probeVideoMetadata parses duration, width, and height from ffprobe JSON", async () => {
  const fakeExecFile = (_command, _args, _options, callback) => {
    callback(null, JSON.stringify({
      streams: [{ width: 320, height: 240, duration: "2.500000" }],
      format: { duration: "2.500000" }
    }));
  };

  const result = await probeVideoMetadata("/tmp/fake.mp4", { execFileImpl: fakeExecFile });
  assert.deepEqual(result, { duration: 2, width: 320, height: 240 });
});

test("probeVideoMetadata falls back to format duration when the stream has none", async () => {
  const fakeExecFile = (_command, _args, _options, callback) => {
    callback(null, JSON.stringify({
      streams: [{ width: 640, height: 360 }],
      format: { duration: "10.9" }
    }));
  };

  const result = await probeVideoMetadata("/tmp/fake.mp4", { execFileImpl: fakeExecFile });
  assert.deepEqual(result, { duration: 10, width: 640, height: 360 });
});

test("probeVideoMetadata returns {} when ffprobe fails or output is not JSON", async () => {
  const failingExecFile = (_command, _args, _options, callback) => {
    callback(new Error("ffprobe: No such file or directory"));
  };
  assert.deepEqual(await probeVideoMetadata("/tmp/missing.mp4", { execFileImpl: failingExecFile }), {});

  const garbageExecFile = (_command, _args, _options, callback) => {
    callback(null, "not json");
  };
  assert.deepEqual(await probeVideoMetadata("/tmp/fake.mp4", { execFileImpl: garbageExecFile }), {});

  const emptyExecFile = (_command, _args, _options, callback) => {
    callback(null, JSON.stringify({ streams: [], format: {} }));
  };
  assert.deepEqual(await probeVideoMetadata("/tmp/fake.mp4", { execFileImpl: emptyExecFile }), {});
});

test("probeVideoMetadata reads a real mp4 with the installed ffprobe", { skip: !(await hasFfprobe()) }, async () => {
  await withTempDir(async (dir) => {
    const videoPath = path.join(dir, "probe.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2",
      "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
      "-t", "2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      videoPath
    ]);

    const result = await probeVideoMetadata(videoPath);
    assert.deepEqual(result, { duration: 2, width: 320, height: 240 });
  });
});

test("probeVideoMetadata returns {} for a non-video file with the installed ffprobe", { skip: !(await hasFfprobe()) }, async () => {
  await withTempDir(async (dir) => {
    const textPath = path.join(dir, "note.txt");
    await writeFile(textPath, "hello");
    assert.deepEqual(await probeVideoMetadata(textPath), {});
  });
});

test("probeAudioMetadata parses duration in milliseconds from ffprobe JSON", async () => {
  const fakeExecFile = (_command, _args, _options, callback) => {
    callback(null, JSON.stringify({
      streams: [{ duration: "3.2" }],
      format: { duration: "3.2" }
    }));
  };

  const result = await probeAudioMetadata("/tmp/fake.silk", { execFileImpl: fakeExecFile });
  assert.deepEqual(result, { durationMs: 3200 });
});

test("probeAudioMetadata returns {} when ffprobe fails or output is not JSON", async () => {
  const failingExecFile = (_command, _args, _options, callback) => {
    callback(new Error("ffprobe: No such file or directory"));
  };
  assert.deepEqual(await probeAudioMetadata("/tmp/missing.silk", { execFileImpl: failingExecFile }), {});

  const garbageExecFile = (_command, _args, _options, callback) => {
    callback(null, "not json");
  };
  assert.deepEqual(await probeAudioMetadata("/tmp/fake.silk", { execFileImpl: garbageExecFile }), {});

  const emptyExecFile = (_command, _args, _options, callback) => {
    callback(null, JSON.stringify({ streams: [], format: {} }));
  };
  assert.deepEqual(await probeAudioMetadata("/tmp/fake.silk", { execFileImpl: emptyExecFile }), {});
});

test("probeAudioMetadata reads a real wav with the installed ffprobe", { skip: !(await hasFfprobe()) }, async () => {
  await withTempDir(async (dir) => {
    const audioPath = path.join(dir, "note.wav");
    await execFileAsync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
      "-t", "2",
      "-c:a", "pcm_s16le",
      audioPath
    ]);

    const result = await probeAudioMetadata(audioPath);
    assert.deepEqual(result, { durationMs: 2000 });
  });
});

test("probeAudioMetadata returns {} for a non-audio file with the installed ffprobe", { skip: !(await hasFfprobe()) }, async () => {
  await withTempDir(async (dir) => {
    const textPath = path.join(dir, "note.txt");
    await writeFile(textPath, "hello");
    assert.deepEqual(await probeAudioMetadata(textPath), {});
  });
});
