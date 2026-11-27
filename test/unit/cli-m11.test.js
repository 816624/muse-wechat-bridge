import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startMockIlinkServer } from "../helpers/mock-ilink-server.js";
import { rememberContextToken } from "../../src/state/context-token-store.js";
import { readMessageHistory } from "../../src/state/message-history.js";

const execFileAsync = promisify(execFile);

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-m11 状态 "));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [path.resolve("src", "cli", "index.js"), ...args], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      ...options.env
    }
  });
}

async function loginFixtureAccount(server, stateDir) {
  await runCli([
    "login",
    "--quiet",
    "--base-url", server.baseUrl,
    "--state-dir", stateDir,
    "--poll-interval-ms", "0",
    "--max-polls", "1"
  ]);
}

test("wxb send --image uploads media, sends typing status, and hides upload secrets", async () => {
  await withTempDir(async (stateDir) => {
    const imagePath = path.join(stateDir, "sample.jpg");
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    const server = await startMockIlinkServer({
      statusResponses: [
        {
          status: "confirmed",
          bot_token: "bot_secret_m11",
          ilink_bot_id: "bot_m11",
          ilink_user_id: "owner_m11"
        }
      ],
      getConfigResponses: [
        {
          ret: 0,
          typing_ticket: "typing_ticket_m11",
          context_token: "ctx_secret_m11_refreshed"
        }
      ],
      getUploadUrlResponses: [
        {
          ret: 0,
          upload_param: "upload_param_m11"
        }
      ],
      uploadResponses: {
        "/upload": {
          headers: {
            "x-encrypted-param": "download_param_m11"
          },
          body: { ret: 0 }
        }
      },
      sendMessageResponses: [{ ret: 0 }]
    });

    try {
      await loginFixtureAccount(server, stateDir);
      await rememberContextToken(stateDir, "bot_m11", "user_m11", "ctx_secret_m11");

      const { stdout } = await runCli([
        "send",
        "--state-dir", stateDir,
        "--cdn-base-url", server.baseUrl,
        "--user", "user_m11",
        "--image", imagePath,
        "--typing",
        "--timeout", "1000"
      ]);
      const parsed = JSON.parse(stdout);

      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.kind, "image");
      assert.equal(parsed.data.fileName, "sample.jpg");
      assert.equal(parsed.data.mimeType, "image/jpeg");
      assert.equal(parsed.data.typing.started, true);
      assert.equal(parsed.data.typing.stopped, true);
      assert.equal(stdout.includes("ctx_secret_m11"), false);
      assert.equal(stdout.includes("bot_secret_m11"), false);
      assert.equal(stdout.includes("typing_ticket_m11"), false);
      assert.equal(stdout.includes("upload_param_m11"), false);
      assert.equal(stdout.includes("download_param_m11"), false);

      const getConfigRequest = server.requests.find((request) => request.pathname === "/ilink/bot/getconfig");
      assert.equal(getConfigRequest.body.ilink_user_id, "user_m11");
      assert.equal(getConfigRequest.body.context_token, "ctx_secret_m11");

      const typingRequests = server.requests.filter((request) => request.pathname === "/ilink/bot/sendtyping");
      assert.deepEqual(typingRequests.map((request) => request.body.status), [1, 2]);
      assert.equal(typingRequests[0].body.typing_ticket, "typing_ticket_m11");

      const uploadUrlRequest = server.requests.find((request) => request.pathname === "/ilink/bot/getuploadurl");
      assert.equal(uploadUrlRequest.headers.authorization, "Bearer bot_secret_m11");
      assert.equal(uploadUrlRequest.body.to_user_id, "user_m11");
      assert.equal(uploadUrlRequest.body.media_type, 1);
      assert.equal(uploadUrlRequest.body.rawsize, 6);
      assert.match(uploadUrlRequest.body.filekey, /^[a-f0-9]{32}$/);
      assert.match(uploadUrlRequest.body.aeskey, /^[a-f0-9]{32}$/);

      const uploadRequest = server.requests.find((request) => request.pathname === "/upload");
      assert.equal(uploadRequest.searchParams.encrypted_query_param, "upload_param_m11");
      assert.match(uploadRequest.searchParams.filekey, /^[a-f0-9]{32}$/);
      assert.ok(Buffer.isBuffer(uploadRequest.body));
      assert.ok(uploadRequest.body.length > 6);

      const sendRequest = server.requests.find((request) => request.pathname === "/ilink/bot/sendmessage");
      assert.equal(sendRequest.body.msg.context_token, "ctx_secret_m11_refreshed");
      assert.equal(sendRequest.body.msg.item_list[0].type, 2);
      assert.equal(sendRequest.body.msg.item_list[0].image_item.media.encrypt_query_param, "download_param_m11");
      assert.match(sendRequest.body.msg.item_list[0].image_item.media.aes_key, /^[A-Za-z0-9+/]+=*$/);
      assert.equal(sendRequest.body.msg.item_list[0].image_item.media.encrypt_type, 1);

      const history = await readMessageHistory(stateDir, "bot_m11");
      assert.equal(history.length, 1);
      assert.equal(history[0].type, "image");
      assert.equal(history[0].attachment.fileName, "sample.jpg");
    } finally {
      await server.close();
    }
  });
});

test("wxb send --video uploads media with media_type 2 and sends a video item", async () => {
  await withTempDir(async (stateDir) => {
    const videoPath = path.join(stateDir, "clip.mp4");
    await writeFile(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    const server = await startMockIlinkServer({
      statusResponses: [
        {
          status: "confirmed",
          bot_token: "bot_secret_m11_video",
          ilink_bot_id: "bot_m11_video",
          ilink_user_id: "owner_m11_video"
        }
      ],
      getUploadUrlResponses: [
        {
          ret: 0,
          upload_param: "upload_param_m11_video"
        }
      ],
      uploadResponses: {
        "/upload": {
          headers: {
            "x-encrypted-param": "download_param_m11_video"
          },
          body: { ret: 0 }
        }
      },
      sendMessageResponses: [{ ret: 0 }]
    });

    try {
      await loginFixtureAccount(server, stateDir);
      await rememberContextToken(stateDir, "bot_m11_video", "user_m11_video", "ctx_secret_m11_video");

      const { stdout } = await runCli([
        "send",
        "--state-dir", stateDir,
        "--cdn-base-url", server.baseUrl,
        "--user", "user_m11_video",
        "--video", videoPath,
        "--timeout", "1000"
      ]);
      const parsed = JSON.parse(stdout);

      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.kind, "video");
      assert.equal(parsed.data.fileName, "clip.mp4");
      assert.equal(parsed.data.mimeType, "video/mp4");
      // The fixture bytes are not a real video, so ffprobe probing fails
      // gracefully and no duration/dimensions are reported.
      assert.deepEqual(parsed.data.videoMetadata, {});
      assert.equal(stdout.includes("ctx_secret_m11_video"), false);
      assert.equal(stdout.includes("bot_secret_m11_video"), false);
      assert.equal(stdout.includes("upload_param_m11_video"), false);
      assert.equal(stdout.includes("download_param_m11_video"), false);

      const uploadUrlRequest = server.requests.find((request) => request.pathname === "/ilink/bot/getuploadurl");
      assert.equal(uploadUrlRequest.body.to_user_id, "user_m11_video");
      assert.equal(uploadUrlRequest.body.media_type, 2);
      assert.equal(uploadUrlRequest.body.no_need_thumb, true);
      assert.equal(uploadUrlRequest.body.rawsize, 8);

      const uploadRequest = server.requests.find((request) => request.pathname === "/upload");
      assert.equal(uploadRequest.searchParams.encrypted_query_param, "upload_param_m11_video");
      assert.ok(Buffer.isBuffer(uploadRequest.body));
      assert.ok(uploadRequest.body.length > 8);

      const sendRequest = server.requests.find((request) => request.pathname === "/ilink/bot/sendmessage");
      assert.equal(sendRequest.body.msg.context_token, "ctx_secret_m11_video");
      assert.equal(sendRequest.body.msg.item_list[0].type, 5);
      assert.equal(sendRequest.body.msg.item_list[0].video_item.media.encrypt_query_param, "download_param_m11_video");
      assert.match(sendRequest.body.msg.item_list[0].video_item.media.aes_key, /^[A-Za-z0-9+/]+=*$/);
      assert.equal(sendRequest.body.msg.item_list[0].video_item.media.encrypt_type, 1);
      assert.equal(sendRequest.body.msg.item_list[0].video_item.file_name, "clip.mp4");
      assert.match(sendRequest.body.msg.item_list[0].video_item.md5, /^[a-f0-9]{32}$/);
      assert.equal(sendRequest.body.msg.item_list[0].video_item.len, "8");
      assert.equal(sendRequest.body.msg.item_list[0].video_item.duration, undefined);

      const history = await readMessageHistory(stateDir, "bot_m11_video");
      assert.equal(history.length, 1);
      assert.equal(history[0].type, "video");
      assert.equal(history[0].attachment.fileName, "clip.mp4");
    } finally {
      await server.close();
    }
  });
});

test("wxb send --voice uploads media with media_type 4 and sends a voice item", async () => {
  await withTempDir(async (stateDir) => {
    const voicePath = path.join(stateDir, "note.silk");
    await writeFile(voicePath, Buffer.from([0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x01, 0x02]));
    const server = await startMockIlinkServer({
      statusResponses: [
        {
          status: "confirmed",
          bot_token: "bot_secret_m11_voice",
          ilink_bot_id: "bot_m11_voice",
          ilink_user_id: "owner_m11_voice"
        }
      ],
      getUploadUrlResponses: [
        {
          ret: 0,
          upload_param: "upload_param_m11_voice"
        }
      ],
      uploadResponses: {
        "/upload": {
          headers: {
            "x-encrypted-param": "download_param_m11_voice"
          },
          body: { ret: 0 }
        }
      },
      sendMessageResponses: [{ ret: 0 }]
    });

    try {
      await loginFixtureAccount(server, stateDir);
      await rememberContextToken(stateDir, "bot_m11_voice", "user_m11_voice", "ctx_secret_m11_voice");

      const { stdout } = await runCli([
        "send",
        "--state-dir", stateDir,
        "--cdn-base-url", server.baseUrl,
        "--user", "user_m11_voice",
        "--voice", voicePath,
        "--timeout", "1000"
      ]);
      const parsed = JSON.parse(stdout);

      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.kind, "voice");
      assert.equal(parsed.data.fileName, "note.silk");
      assert.equal(parsed.data.mimeType, "audio/silk");
      // The fixture bytes are not a real audio stream, so ffprobe probing
      // fails gracefully and no duration is reported.
      assert.deepEqual(parsed.data.audioMetadata, {});
      assert.equal(stdout.includes("ctx_secret_m11_voice"), false);
      assert.equal(stdout.includes("bot_secret_m11_voice"), false);
      assert.equal(stdout.includes("upload_param_m11_voice"), false);
      assert.equal(stdout.includes("download_param_m11_voice"), false);

      const uploadUrlRequest = server.requests.find((request) => request.pathname === "/ilink/bot/getuploadurl");
      assert.equal(uploadUrlRequest.body.to_user_id, "user_m11_voice");
      assert.equal(uploadUrlRequest.body.media_type, 4);
      assert.equal(uploadUrlRequest.body.no_need_thumb, true);
      assert.equal(uploadUrlRequest.body.rawsize, 8);

      const uploadRequest = server.requests.find((request) => request.pathname === "/upload");
      assert.equal(uploadRequest.searchParams.encrypted_query_param, "upload_param_m11_voice");
      assert.ok(Buffer.isBuffer(uploadRequest.body));
      assert.ok(uploadRequest.body.length > 8);

      const sendRequest = server.requests.find((request) => request.pathname === "/ilink/bot/sendmessage");
      assert.equal(sendRequest.body.msg.context_token, "ctx_secret_m11_voice");
      assert.equal(sendRequest.body.msg.item_list[0].type, 3);
      assert.equal(sendRequest.body.msg.item_list[0].voice_item.media.encrypt_query_param, "download_param_m11_voice");
      assert.match(sendRequest.body.msg.item_list[0].voice_item.media.aes_key, /^[A-Za-z0-9+/]+=*$/);
      assert.equal(sendRequest.body.msg.item_list[0].voice_item.media.encrypt_type, 1);
      assert.equal(sendRequest.body.msg.item_list[0].voice_item.file_name, "note.silk");
      assert.match(sendRequest.body.msg.item_list[0].voice_item.md5, /^[a-f0-9]{32}$/);
      assert.equal(sendRequest.body.msg.item_list[0].voice_item.len, "8");
      assert.equal(sendRequest.body.msg.item_list[0].voice_item.duration_ms, undefined);

      const history = await readMessageHistory(stateDir, "bot_m11_voice");
      assert.equal(history.length, 1);
      assert.equal(history[0].type, "voice");
      assert.equal(history[0].attachment.fileName, "note.silk");
    } finally {
      await server.close();
    }
  });
});

test("wxb send reports media validation and source errors as structured JSON", async () => {
  await withTempDir(async (stateDir) => {
    const server = await startMockIlinkServer({
      statusResponses: [
        {
          status: "confirmed",
          bot_token: "bot_secret_m11",
          ilink_bot_id: "bot_m11",
          ilink_user_id: "owner_m11"
        }
      ]
    });

    try {
      await loginFixtureAccount(server, stateDir);
      await rememberContextToken(stateDir, "bot_m11", "user_m11", "ctx_secret_m11");

      await assert.rejects(
        runCli([
          "send",
          "--state-dir", stateDir,
          "--user", "user_m11",
          "--text", "hello",
          "--file", path.join(stateDir, "missing.pdf")
        ]),
        (error) => {
          const parsed = JSON.parse(error.stdout);
          assert.equal(parsed.error.code, "SEND_SOURCE_AMBIGUOUS");
          return true;
        }
      );

      await assert.rejects(
        runCli([
          "send",
          "--state-dir", stateDir,
          "--user", "user_m11",
          "--file", path.join(stateDir, "missing.pdf")
        ]),
        (error) => {
          const parsed = JSON.parse(error.stdout);
          assert.equal(parsed.error.code, "MEDIA_FILE_NOT_FOUND");
          return true;
        }
      );
    } finally {
      await server.close();
    }
  });
});

test("wxb send reports upload failures before sendmessage", async () => {
  await withTempDir(async (stateDir) => {
    const filePath = path.join(stateDir, "broken.png");
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const server = await startMockIlinkServer({
      statusResponses: [
        {
          status: "confirmed",
          bot_token: "bot_secret_m11",
          ilink_bot_id: "bot_m11",
          ilink_user_id: "owner_m11"
        }
      ],
      getUploadUrlResponses: [
        {
          ret: 0,
          upload_param: "upload_param_m11_fail"
        }
      ],
      uploadResponses: {
        "/upload": {
          httpStatus: 500,
          body: { ret: 500, errmsg: "cdn failed" }
        }
      }
    });

    try {
      await loginFixtureAccount(server, stateDir);
      await rememberContextToken(stateDir, "bot_m11", "user_m11", "ctx_secret_m11");

      await assert.rejects(
        runCli([
          "send",
          "--state-dir", stateDir,
          "--cdn-base-url", server.baseUrl,
          "--user", "user_m11",
          "--image", filePath,
          "--timeout", "1000"
        ]),
        (error) => {
          const parsed = JSON.parse(error.stdout);
          assert.equal(parsed.error.code, "MEDIA_UPLOAD_FAILED");
          assert.equal(error.stdout.includes("upload_param_m11_fail"), false);
          assert.equal(error.stdout.includes("ctx_secret_m11"), false);
          return true;
        }
      );

      assert.ok(server.requests.some((request) => request.pathname === "/upload"));
      assert.equal(server.requests.some((request) => request.pathname === "/ilink/bot/sendmessage"), false);
    } finally {
      await server.close();
    }
  });
});
