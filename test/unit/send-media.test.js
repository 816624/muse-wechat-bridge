import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendMedia } from "../../src/core/send-media.js";
import { WxbError } from "../../src/core/errors.js";
import { saveAccount } from "../../src/state/account-store.js";
import { rememberContextToken, resolveContextToken } from "../../src/state/context-token-store.js";
import { readMessageHistory } from "../../src/state/message-history.js";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-send-media-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedAccount(stateDir) {
  await saveAccount(stateDir, {
    accountId: "bot_media",
    token: "bot_secret_media",
    baseUrl: "https://mock.example",
    ownerUserId: "owner_media"
  });
  await rememberContextToken(stateDir, "bot_media", "user_media", "ctx_media");
}

function fakeMediaClient(options = {}) {
  const calls = {
    getUploadUrl: [],
    uploadBytes: [],
    sendMediaMessage: [],
    getConfig: [],
    sendTyping: []
  };

  return {
    calls,
    async getUploadUrl(request) {
      calls.getUploadUrl.push(request);
      return options.uploadConfig ?? {
        ret: 0,
        upload_param: "upload_param_fixture"
      };
    },
    async uploadBytes(request) {
      calls.uploadBytes.push(request);
      if (options.uploadError) {
        throw options.uploadError;
      }
      return {
        status: 200,
        headers: { "x-encrypted-param": "download_param_fixture" },
        body: { ret: 0 }
      };
    },
    async sendMediaMessage(request) {
      calls.sendMediaMessage.push(request);
      if (options.sendError) {
        throw options.sendError;
      }
      return { ret: 0 };
    },
    async getConfig(request) {
      calls.getConfig.push(request);
      if (options.configError) {
        throw options.configError;
      }
      return options.configResponse ?? {
        ret: 0,
        typing_ticket: "typing_ticket",
        context_token: "ctx_media_refreshed"
      };
    },
    async sendTyping(request) {
      calls.sendTyping.push(request);
      const failure = options.typingFailAt === calls.sendTyping.length ? options.typingError : undefined;
      if (failure) {
        throw failure;
      }
      return { ret: 0 };
    }
  };
}

test("sendMedia uploads encrypted image bytes, sends media message, and writes safe history", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const imagePath = path.join(stateDir, "sample.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    const client = fakeMediaClient();

    const result = await sendMedia({
      stateDir,
      userId: "user_media",
      filePath: imagePath,
      kind: "image",
      client,
      config: { maxUploadBytes: 1024, cdnBaseUrl: "https://upload.example/c2c" }
    });

    assert.equal(result.kind, "image");
    assert.equal(result.fileName, "sample.png");
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.bytes, 6);
    assert.equal(result.uploaded, true);
    assert.equal(result.sent, true);
    assert.equal(JSON.stringify(result).includes("ctx_media"), false);
    assert.equal(JSON.stringify(result).includes("bot_secret_media"), false);

    assert.equal(client.calls.getUploadUrl.length, 1);
    assert.equal(client.calls.getUploadUrl[0].token, "bot_secret_media");
    assert.equal(client.calls.getUploadUrl[0].upload.media_type, 1);
    assert.equal(client.calls.getUploadUrl[0].upload.to_user_id, "user_media");
    assert.equal(client.calls.getUploadUrl[0].upload.rawsize, 6);
    assert.match(client.calls.getUploadUrl[0].upload.rawfilemd5, /^[a-f0-9]{32}$/);
    assert.match(client.calls.getUploadUrl[0].upload.aeskey, /^[a-f0-9]{32}$/);

    assert.equal(client.calls.uploadBytes.length, 1);
    assert.match(client.calls.uploadBytes[0].uploadUrl, /^https:\/\/upload\.example\/c2c\/upload\?/);
    assert.match(client.calls.uploadBytes[0].uploadUrl, /encrypted_query_param=upload_param_fixture/);
    assert.match(client.calls.uploadBytes[0].uploadUrl, /filekey=[a-f0-9]{32}/);
    assert.ok(Buffer.isBuffer(client.calls.uploadBytes[0].bytes));
    assert.notEqual(client.calls.uploadBytes[0].bytes.toString("hex"), (await readFile(imagePath)).toString("hex"));

    const send = client.calls.sendMediaMessage[0];
    assert.equal(send.toUserId, "user_media");
    assert.equal(send.contextToken, "ctx_media");
    assert.equal(send.item.type, 2);
    assert.equal(send.item.image_item.media.encrypt_query_param, "download_param_fixture");
    assert.match(send.item.image_item.media.aes_key, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(send.item.image_item.media.encrypt_type, 1);
    assert.equal(send.item.image_item.mid_size, client.calls.uploadBytes[0].bytes.length);
    assert.match(send.clientId, /^wxb-\d+-[a-f0-9]{8}$/);

    const history = await readMessageHistory(stateDir, "bot_media");
    assert.equal(history.length, 1);
    assert.equal(history[0].type, "image");
    assert.match(history[0].attachment.fileKey, /^[a-f0-9]{32}$/);
    assert.equal(history[0].attachment.fileName, "sample.png");
  });
});

test("sendMedia uploads encrypted video bytes with media_type 2 and a video item", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const videoPath = path.join(stateDir, "clip.mp4");
    await writeFile(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    const client = fakeMediaClient();

    const result = await sendMedia({
      stateDir,
      userId: "user_media",
      filePath: videoPath,
      kind: "video",
      client,
      videoMetadataProbe: async () => ({ duration: 3, width: 320, height: 240 }),
      config: { maxUploadBytes: 1024, cdnBaseUrl: "https://upload.example/c2c" }
    });

    assert.equal(result.kind, "video");
    assert.equal(result.fileName, "clip.mp4");
    assert.equal(result.mimeType, "video/mp4");
    assert.equal(result.bytes, 8);
    assert.equal(result.uploaded, true);
    assert.equal(result.sent, true);
    assert.deepEqual(result.videoMetadata, { duration: 3, width: 320, height: 240 });

    assert.equal(client.calls.getUploadUrl.length, 1);
    assert.equal(client.calls.getUploadUrl[0].upload.media_type, 2);
    assert.equal(client.calls.getUploadUrl[0].upload.no_need_thumb, true);
    assert.equal(client.calls.getUploadUrl[0].upload.thumb_rawsize, 0);

    const send = client.calls.sendMediaMessage[0];
    assert.equal(send.toUserId, "user_media");
    assert.equal(send.item.type, 5);
    assert.equal(send.item.video_item.media.encrypt_query_param, "download_param_fixture");
    assert.match(send.item.video_item.media.aes_key, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(send.item.video_item.media.encrypt_type, 1);
    assert.equal(send.item.video_item.file_name, "clip.mp4");
    assert.match(send.item.video_item.md5, /^[a-f0-9]{32}$/);
    assert.equal(send.item.video_item.len, "8");
    assert.equal(send.item.video_item.duration, 3);
    assert.equal(send.item.video_item.width, 320);
    assert.equal(send.item.video_item.height, 240);

    const history = await readMessageHistory(stateDir, "bot_media");
    assert.equal(history.length, 1);
    assert.equal(history[0].type, "video");
    assert.equal(history[0].attachment.fileName, "clip.mp4");
    assert.equal(history[0].attachment.mimeType, "video/mp4");
  });
});

test("sendMedia sends video without metadata when probing fails", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const videoPath = path.join(stateDir, "clip.mov");
    await writeFile(videoPath, Buffer.from("not a real video"));
    const client = fakeMediaClient();

    const result = await sendMedia({
      stateDir,
      userId: "user_media",
      filePath: videoPath,
      kind: "video",
      client,
      videoMetadataProbe: async () => ({}),
      config: { maxUploadBytes: 1024, cdnBaseUrl: "https://upload.example/c2c" }
    });

    assert.equal(result.kind, "video");
    assert.equal(result.mimeType, "video/quicktime");
    assert.deepEqual(result.videoMetadata, {});
    const send = client.calls.sendMediaMessage[0];
    assert.equal(send.item.type, 5);
    assert.equal(send.item.video_item.duration, undefined);
    assert.equal(send.item.video_item.width, undefined);
    assert.equal(send.item.video_item.height, undefined);
    assert.equal(send.item.video_item.file_name, "clip.mov");
  });
});

test("sendMedia uploads encrypted voice bytes with media_type 4 and a voice item", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const voicePath = path.join(stateDir, "note.silk");
    await writeFile(voicePath, Buffer.from([0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x01, 0x02]));
    const client = fakeMediaClient();

    const result = await sendMedia({
      stateDir,
      userId: "user_media",
      filePath: voicePath,
      kind: "voice",
      client,
      audioMetadataProbe: async () => ({ durationMs: 3200 }),
      config: { maxUploadBytes: 1024, cdnBaseUrl: "https://upload.example/c2c" }
    });

    assert.equal(result.kind, "voice");
    assert.equal(result.fileName, "note.silk");
    assert.equal(result.mimeType, "audio/silk");
    assert.equal(result.bytes, 8);
    assert.equal(result.uploaded, true);
    assert.equal(result.sent, true);
    assert.deepEqual(result.audioMetadata, { durationMs: 3200 });

    assert.equal(client.calls.getUploadUrl.length, 1);
    assert.equal(client.calls.getUploadUrl[0].upload.media_type, 4);
    assert.equal(client.calls.getUploadUrl[0].upload.no_need_thumb, true);
    assert.equal(client.calls.getUploadUrl[0].upload.thumb_rawsize, 0);

    const send = client.calls.sendMediaMessage[0];
    assert.equal(send.toUserId, "user_media");
    assert.equal(send.item.type, 3);
    assert.equal(send.item.voice_item.media.encrypt_query_param, "download_param_fixture");
    assert.match(send.item.voice_item.media.aes_key, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(send.item.voice_item.media.encrypt_type, 1);
    assert.equal(send.item.voice_item.file_name, "note.silk");
    assert.match(send.item.voice_item.md5, /^[a-f0-9]{32}$/);
    assert.equal(send.item.voice_item.len, "8");
    assert.equal(send.item.voice_item.duration_ms, 3200);

    const history = await readMessageHistory(stateDir, "bot_media");
    assert.equal(history.length, 1);
    assert.equal(history[0].type, "voice");
    assert.equal(history[0].attachment.fileName, "note.silk");
    assert.equal(history[0].attachment.mimeType, "audio/silk");
  });
});

test("sendMedia sends voice without metadata when probing fails", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const voicePath = path.join(stateDir, "note.mp3");
    await writeFile(voicePath, Buffer.from("not real audio"));
    const client = fakeMediaClient();

    const result = await sendMedia({
      stateDir,
      userId: "user_media",
      filePath: voicePath,
      kind: "voice",
      client,
      audioMetadataProbe: async () => ({}),
      config: { maxUploadBytes: 1024, cdnBaseUrl: "https://upload.example/c2c" }
    });

    assert.equal(result.kind, "voice");
    assert.equal(result.mimeType, "audio/mpeg");
    assert.deepEqual(result.audioMetadata, {});
    const send = client.calls.sendMediaMessage[0];
    assert.equal(send.item.type, 3);
    assert.equal(send.item.voice_item.duration_ms, undefined);
    assert.equal(send.item.voice_item.file_name, "note.mp3");
  });
});

test("sendMedia supports typing and refreshed context tokens", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const filePath = path.join(stateDir, "report.pdf");
    await writeFile(filePath, Buffer.from("%PDF fixture"));
    const client = fakeMediaClient();

    const result = await sendMedia({
      stateDir,
      userId: "user_media",
      filePath,
      kind: "file",
      client,
      typing: true,
      config: { maxUploadBytes: 1024, cdnBaseUrl: "https://upload.example/c2c" }
    });

    assert.deepEqual(client.calls.sendTyping.map((call) => call.status), [1, 2]);
    assert.equal(client.calls.getConfig[0].contextToken, "ctx_media");
    assert.equal(client.calls.sendMediaMessage[0].contextToken, "ctx_media_refreshed");
    assert.equal(await resolveContextToken(stateDir, "bot_media", "user_media"), "ctx_media_refreshed");
    assert.equal(result.typing.started, true);
    assert.equal(result.typing.stopped, true);
  });
});

test("sendMedia continues delivery when typing ticket is missing", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const filePath = path.join(stateDir, "report.pdf");
    await writeFile(filePath, Buffer.from("%PDF fixture"));
    const client = fakeMediaClient({
      configResponse: {
        ret: 0,
        context_token: "ctx_media_refreshed"
      }
    });

    const result = await sendMedia({
      stateDir,
      userId: "user_media",
      filePath,
      kind: "file",
      client,
      typing: true,
      config: { maxUploadBytes: 1024, cdnBaseUrl: "https://upload.example/c2c" }
    });

    assert.equal(client.calls.getConfig.length, 1);
    assert.equal(client.calls.sendTyping.length, 0);
    assert.equal(client.calls.sendMediaMessage.length, 1);
    assert.equal(client.calls.sendMediaMessage[0].contextToken, "ctx_media_refreshed");
    assert.equal(await resolveContextToken(stateDir, "bot_media", "user_media"), "ctx_media_refreshed");
    assert.equal(result.sent, true);
    assert.equal(result.typing.requested, true);
    assert.equal(result.typing.started, false);
    assert.equal(result.typing.stopped, false);
    assert.equal(result.typing.startError.code, "TYPING_TICKET_MISSING");
    assert.equal(JSON.stringify(result).includes("ctx_media"), false);
    assert.equal(JSON.stringify(result).includes("bot_secret_media"), false);
  });
});

test("sendMedia reports local file validation failures before contacting the client", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const client = fakeMediaClient();

    await assert.rejects(
      sendMedia({
        stateDir,
        userId: "user_media",
        filePath: path.join(stateDir, "missing.png"),
        kind: "image",
        client
      }),
      (error) => error.code === "MEDIA_FILE_NOT_FOUND"
    );

    const dirPath = path.join(stateDir, "folder.pdf");
    await mkdir(dirPath);
    await assert.rejects(
      sendMedia({
        stateDir,
        userId: "user_media",
        filePath: dirPath,
        kind: "file",
        client
      }),
      (error) => error.code === "MEDIA_PATH_NOT_FILE"
    );

    const tooLargePath = path.join(stateDir, "large.pdf");
    await writeFile(tooLargePath, Buffer.alloc(4));
    await assert.rejects(
      sendMedia({
        stateDir,
        userId: "user_media",
        filePath: tooLargePath,
        kind: "file",
        client,
        config: { maxUploadBytes: 3 }
      }),
      (error) => error.code === "MEDIA_FILE_TOO_LARGE"
    );

    const unknownPath = path.join(stateDir, "unknown.bin");
    await writeFile(unknownPath, Buffer.from("unknown"));
    await assert.rejects(
      sendMedia({
        stateDir,
        userId: "user_media",
        filePath: unknownPath,
        kind: "file",
        client
      }),
      (error) => error.code === "MEDIA_TYPE_UNSUPPORTED"
    );

    const wrongKindPath = path.join(stateDir, "clip.mp4");
    await writeFile(wrongKindPath, Buffer.from("not a real video"));
    await assert.rejects(
      sendMedia({
        stateDir,
        userId: "user_media",
        filePath: wrongKindPath,
        kind: "image",
        client
      }),
      (error) => error.code === "MEDIA_TYPE_UNSUPPORTED"
    );

    assert.equal(client.calls.getUploadUrl.length, 0);
    assert.equal(client.calls.uploadBytes.length, 0);
    assert.equal(client.calls.sendMediaMessage.length, 0);
  });
});

test("sendMedia reports upload failures without sending media message", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const filePath = path.join(stateDir, "broken.pdf");
    await writeFile(filePath, Buffer.from("%PDF fixture"));
    const client = fakeMediaClient({
      uploadError: new Error("upload unavailable")
    });

    await assert.rejects(
      sendMedia({
        stateDir,
        userId: "user_media",
        filePath,
        kind: "file",
        client,
        config: { maxUploadBytes: 1024, cdnBaseUrl: "https://upload.example/c2c" }
      }),
      (error) => {
        assert.equal(error.code, "MEDIA_UPLOAD_FAILED");
        assert.equal(error.details.cause, "upload unavailable");
        return true;
      }
    );

    assert.equal(client.calls.uploadBytes.length, 1);
    assert.equal(client.calls.sendMediaMessage.length, 0);
    assert.equal((await readMessageHistory(stateDir, "bot_media")).length, 0);
  });
});

test("sendMedia reports upload success metadata when sendmessage later fails", async () => {
  await withTempDir(async (stateDir) => {
    await seedAccount(stateDir);
    const filePath = path.join(stateDir, "report.pdf");
    await writeFile(filePath, Buffer.from("%PDF fixture"));
    const client = fakeMediaClient({
      sendError: new WxbError("SESSION_EXPIRED", "expired", { retryable: false })
    });

    await assert.rejects(
      sendMedia({
        stateDir,
        userId: "user_media",
        filePath,
        kind: "file",
        client,
        config: { maxUploadBytes: 1024, cdnBaseUrl: "https://upload.example/c2c" }
      }),
      (error) => {
        assert.equal(error.code, "SESSION_EXPIRED");
        assert.equal(error.details.uploaded, true);
        assert.equal(error.details.fileName, "report.pdf");
        assert.match(error.details.clientId, /^wxb-\d+-[a-f0-9]{8}$/);
        return true;
      }
    );

    assert.equal(client.calls.uploadBytes.length, 1);
    assert.equal((await readMessageHistory(stateDir, "bot_media")).length, 0);
  });
});
