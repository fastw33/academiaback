import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Course } from "./models.js";
import { bucket, s3 } from "./s3.js";

const ffmpegPath = process.env.FFMPEG_PATH || (process.platform === "win32"
  ? (await import("ffmpeg-static")).default
  : "ffmpeg");

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
    warning: job.warning || null,
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

function runVariant(inputUrl, outputDirectory, variant, hasAudio, progressStart, progressSpan, job) {
  const variantDirectory = join(outputDirectory, variant.name);
  const args = [
    "-hide_banner",
    "-y",
    "-i", inputUrl,
    "-map", "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0"] : []),
    "-vf", `scale=w=-2:h=${variant.height}`,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-threads", "1",
    "-filter_threads", "1",
    "-pix_fmt", "yuv420p",
    "-b:v", variant.bitrate,
    "-maxrate", variant.maxrate,
    "-bufsize", variant.bufsize,
    ...(hasAudio ? ["-c:a", "aac", "-ar", "48000", "-b:a", variant.audioBitrate] : []),
    "-force_key_frames", "expr:gte(t,n_forced*6)",
    "-f", "hls",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", join(variantDirectory, "segment_%05d.ts"),
    "-progress", "pipe:2",
    "-nostats",
    join(variantDirectory, "index.m3u8"),
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
        const variantProgress = Math.min(1, parseTimestamp(outTime) / durationSeconds);
        job.progress = Math.min(94, Math.max(1, Math.round(progressStart + variantProgress * progressSpan)));
      }
    });
    process.once("error", reject);
    process.once("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg terminó con código ${code}${signal ? ` por señal ${signal}` : ""}. ${diagnostics.trim().slice(-1200)}`));
    });
  });
}

async function runFfmpeg(inputUrl, outputDirectory, job) {
  const hasAudio = await inputHasAudio(inputUrl);
  const variants = [
    { name: "360p", height: 360, bitrate: "850k", maxrate: "950k", bufsize: "1400k", audioBitrate: "96k", bandwidth: 1050000, averageBandwidth: 950000, resolution: "640x360" },
    { name: "720p", height: 720, bitrate: "2300k", maxrate: "2600k", bufsize: "3900k", audioBitrate: "128k", bandwidth: 2800000, averageBandwidth: 2450000, resolution: "1280x720" },
  ];
  const completedVariants = [];

  for (const [index, variant] of variants.entries()) {
    try {
      await runVariant(inputUrl, outputDirectory, variant, hasAudio, index === 0 ? 0 : 70, index === 0 ? 70 : 24, job);
      completedVariants.push(variant);
    } catch (error) {
      if (index === 0) throw error;
      job.warning = `La calidad 720p no pudo generarse: ${error instanceof Error ? error.message : "error desconocido"}`;
      console.warn(job.warning);
      await rm(join(outputDirectory, variant.name), { recursive: true, force: true });
    }
  }

  const codecs = hasAudio ? 'CODECS="avc1.64001e,mp4a.40.2"' : 'CODECS="avc1.64001e"';
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    ...completedVariants.flatMap((variant) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},AVERAGE-BANDWIDTH=${variant.averageBandwidth},RESOLUTION=${variant.resolution},${codecs}`,
      `${variant.name}/index.m3u8`,
    ]),
    "",
  ].join("\n");
  await writeFile(join(outputDirectory, "master.m3u8"), master, "utf8");
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
  const inputPath = join(workingDirectory, `source${extname(job.sourceKey) || ".mp4"}`);

  try {
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all(["360p", "720p"].map((name) => mkdir(join(outputDirectory, name), { recursive: true })));
    job.status = "downloading";
    job.progress = 0;
    const source = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: job.sourceKey }));
    if (!source.Body || typeof source.Body.pipe !== "function") throw new Error("MinIO no devolvió el archivo original.");
    if (source.ContentLength !== undefined) job.originalBytes = source.ContentLength;
    await pipeline(source.Body, createWriteStream(inputPath));

    job.status = "processing";
    job.progress = 1;
    await runFfmpeg(inputPath, outputDirectory, job);

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
