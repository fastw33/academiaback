import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import ffmpegPath from "ffmpeg-static";
import { Course } from "./models.js";
import { bucket, s3 } from "./s3.js";

const jobs = new Map();
const queue = [];
let queueRunning = false;

function publicJob(job) {
  return {
    id: job.id,
    sourceKey: job.sourceKey,
    optimizedKey: job.optimizedKey || null,
    status: job.status,
    progress: job.progress,
    error: job.error || null,
    originalBytes: job.originalBytes || null,
    optimizedBytes: job.optimizedBytes || null,
  };
}

function parseTimestamp(value) {
  const match = value.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function inputHasAudio(inputUrl) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, ["-hide_banner", "-i", inputUrl, "-t", "0", "-f", "null", "-"], { windowsHide: true });
    let diagnostics = "";
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-16000);
    });
    process.once("error", reject);
    process.once("close", () => resolve(/Stream #.*Audio:/i.test(diagnostics)));
  });
}

async function runFfmpeg(inputUrl, outputDirectory, job) {
  const hasAudio = await inputHasAudio(inputUrl);
  const maps = hasAudio
    ? ["-map", "[v360out]", "-map", "0:a:0", "-map", "[v720out]", "-map", "0:a:0", "-map", "[v1080out]", "-map", "0:a:0"]
    : ["-map", "[v360out]", "-map", "[v720out]", "-map", "[v1080out]"];
  const audio = hasAudio
    ? ["-c:a", "aac", "-ar", "48000", "-b:a:0", "96k", "-b:a:1", "128k", "-b:a:2", "128k"]
    : [];
  const variants = hasAudio
    ? "v:0,a:0,name:360p v:1,a:1,name:720p v:2,a:2,name:1080p"
    : "v:0,name:360p v:1,name:720p v:2,name:1080p";
  const args = [
    "-hide_banner",
    "-y",
    "-i", inputUrl,
    "-filter_complex",
    "[0:v]split=3[v360][v720][v1080];[v360]scale=w=-2:h=360[v360out];[v720]scale=w=-2:h=720[v720out];[v1080]scale=w=-2:h=1080[v1080out]",
    ...maps,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-b:v:0", "700k", "-maxrate:v:0", "800k", "-bufsize:v:0", "1200k",
    "-b:v:1", "2100k", "-maxrate:v:1", "2400k", "-bufsize:v:1", "3600k",
    "-b:v:2", "4200k", "-maxrate:v:2", "4800k", "-bufsize:v:2", "7200k",
    ...audio,
    "-force_key_frames", "expr:gte(t,n_forced*6)",
    "-f", "hls",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", variants,
    "-hls_segment_filename", join(outputDirectory, "%v", "segment_%05d.ts"),
    "-progress", "pipe:2",
    "-nostats",
    join(outputDirectory, "%v", "index.m3u8"),
  ];

  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, { windowsHide: true });
    let durationSeconds = 0;
    let diagnostics = "";

    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-8000);
      const duration = chunk.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/)?.[1];
      if (duration) durationSeconds = parseTimestamp(duration);

      const outTime = chunk.match(/out_time=(\d+:\d+:\d+(?:\.\d+)?)/)?.[1];
      if (outTime && durationSeconds > 0) {
        job.progress = Math.min(94, Math.max(1, Math.round((parseTimestamp(outTime) / durationSeconds) * 94)));
      }
    });
    process.once("error", reject);
    process.once("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg terminó con código ${code}. ${diagnostics.trim().slice(-1200)}`));
    });
  });
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

function contentTypeFor(path) {
  if (path.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (path.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

async function uploadHlsDirectory(outputDirectory, job) {
  const files = await listFiles(outputDirectory);
  const sizes = await Promise.all(files.map((path) => stat(path)));
  job.optimizedBytes = sizes.reduce((total, item) => total + item.size, 0);

  for (let index = 0; index < files.length; index += 6) {
    const batch = files.slice(index, index + 6);
    await Promise.all(batch.map(async (path) => {
      const relativePath = relative(outputDirectory, path).split("\\").join("/");
      const info = await stat(path);
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${job.outputPrefix}/${relativePath}`,
        Body: createReadStream(path),
        ContentLength: info.size,
        ContentType: contentTypeFor(path),
      }));
    }));
    job.progress = Math.min(99, 95 + Math.round(((index + batch.length) / files.length) * 4));
  }
}

async function replacePublishedVideo(job) {
  const course = await Course.findOne({ "videos.id": job.id });
  if (!course) return false;
  const video = course.videos.find((item) => item.id === job.id);
  if (!video || video.s3Key !== job.sourceKey) return false;

  video.s3Key = job.optimizedKey;
  if (course.videos[0]?.id === job.id) course.s3Key = job.optimizedKey;
  await course.save();
  return true;
}

async function processJob(job) {
  const workingDirectory = await mkdtemp(join(tmpdir(), "fastway-video-"));
  const outputDirectory = join(workingDirectory, "hls");

  try {
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all(["360p", "720p", "1080p"].map((name) => mkdir(join(outputDirectory, name), { recursive: true })));
    job.status = "processing";
    job.progress = 1;
    const inputUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: job.sourceKey }), {
      expiresIn: 6 * 60 * 60,
    });
    await runFfmpeg(inputUrl, outputDirectory, job);

    job.status = "uploading";
    job.progress = 95;
    await uploadHlsDirectory(outputDirectory, job);

    await replacePublishedVideo(job);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: job.sourceKey }));
    job.status = "done";
    job.progress = 100;
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "No se pudo optimizar el video.";
    console.error(`Video optimization failed for ${job.sourceKey}:`, error);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (queue.length) await processJob(queue.shift());
  } finally {
    queueRunning = false;
  }
}

export function enqueueVideoOptimization({ id, sourceKey, originalBytes }) {
  const existing = jobs.get(id);
  if (existing && existing.sourceKey === sourceKey && existing.status !== "failed") return publicJob(existing);

  if (sourceKey.endsWith("/master.m3u8")) {
    const complete = { id, sourceKey, optimizedKey: sourceKey, status: "done", progress: 100, originalBytes };
    jobs.set(id, complete);
    return publicJob(complete);
  }

  const outputPrefix = sourceKey.slice(0, -extname(sourceKey).length) + "-hls";
  const optimizedKey = `${outputPrefix}/master.m3u8`;
  const job = {
    id,
    sourceKey,
    optimizedKey,
    outputPrefix,
    originalBytes,
    status: "queued",
    progress: 0,
    error: null,
  };
  jobs.set(id, job);
  queue.push(job);
  void runQueue();
  return publicJob(job);
}

export function getVideoOptimization(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}
