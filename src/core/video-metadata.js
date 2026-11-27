import { execFile } from "node:child_process";

// Best-effort media metadata probes for outbound media sends.
//
// Uses ffprobe (ships with ffmpeg) to read stream dimensions/duration.
// Probing is intentionally fail-soft: when ffprobe is missing, the file has
// no matching stream, or probing fails for any other reason, the probe
// returns {} and the send proceeds without the extra fields. The iLink
// server does not require these fields; they only help the receiving
// client render the media (duration label, aspect ratio) before playback.
//
// Video: `duration` is integer seconds, `width`/`height` are pixels of the
// first video stream, matching the `duration` field the normalizer reads
// back from inbound video items.
// Audio: `durationMs` is integer milliseconds, matching the `duration_ms`
// field inbound voice items carry.

function toPositiveInt(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return undefined;
  }
  return Math.floor(numberValue);
}

function parseProbeOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }

  const stream = parsed?.streams?.[0] ?? {};
  const duration = toPositiveInt(stream.duration ?? parsed?.format?.duration);
  const width = toPositiveInt(stream.width);
  const height = toPositiveInt(stream.height);

  return {
    ...(duration !== undefined ? { duration } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {})
  };
}

export async function probeVideoMetadata(filePath, options = {}) {
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const execFileImpl = options.execFileImpl ?? execFile;
  const timeoutMs = options.timeoutMs ?? 15000;

  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFileImpl(
        ffprobePath,
        [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=width,height,duration",
          "-show_entries", "format=duration",
          "-of", "json",
          filePath
        ],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout });
        }
      );
    });
    return parseProbeOutput(stdout);
  } catch {
    return {};
  }
}

function parseAudioProbeOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }

  const stream = parsed?.streams?.[0] ?? {};
  const durationSeconds = Number(stream.duration ?? parsed?.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return {};
  }

  return { durationMs: Math.round(durationSeconds * 1000) };
}

export async function probeAudioMetadata(filePath, options = {}) {
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const execFileImpl = options.execFileImpl ?? execFile;
  const timeoutMs = options.timeoutMs ?? 15000;

  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFileImpl(
        ffprobePath,
        [
          "-v", "error",
          "-select_streams", "a:0",
          "-show_entries", "stream=duration",
          "-show_entries", "format=duration",
          "-of", "json",
          filePath
        ],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout });
        }
      );
    });
    return parseAudioProbeOutput(stdout);
  } catch {
    return {};
  }
}
