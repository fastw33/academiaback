import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage } from "node:http";
import { posix } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { connectDB, Course, User } from "./models.js";
import { clearSessionCookie, createPlaybackToken, createSessionToken, createUploadToken, requireAdmin, requirePlaybackToken, requireUploadToken, requireUser, serializeUser, setSessionCookie } from "./auth.js";
import { getAccessWindow, getCourseVideos, isVideoUnlocked } from "./course-videos.js";
import { bucket, s3 } from "./s3.js";
import { enqueueVideoOptimization, getVideoOptimization } from "./video-processing.js";

const app = express();
app.set("trust proxy", 1);
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const clientDisconnectCodes = new Set(["ABORT_ERR", "ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE", "HPE_INVALID_EOF_STATE"]);

function isClientDisconnect(error, req) {
  return req?.aborted || error?.name === "AbortError" || clientDisconnectCodes.has(error?.code);
}

function observeRequestErrors(req) {
  req.on("error", (error) => {
    if (!isClientDisconnect(error, req)) console.error("Request stream error:", error);
  });
}

function observeTransferErrors(stream, req, label) {
  stream.on("error", (error) => {
    if (!isClientDisconnect(error, req)) console.error(`${label} stream error:`, error);
  });
}

async function deleteVideoObjects(key) {
  if (!key.endsWith(".m3u8")) {
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: key }], Quiet: true } }));
    return;
  }

  const prefix = key.slice(0, key.lastIndexOf("/") + 1);
  let continuationToken;
  do {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
    const objects = (listed.Contents || []).flatMap((item) => item.Key ? [{ Key: item.Key }] : []);
    if (objects.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

class SafeIncomingMessage extends IncomingMessage {
  constructor(socket) {
    super(socket);
    observeRequestErrors(this);
  }
}

function getAllowedOrigins() {
  const raw = process.env.CORS_ORIGINS || process.env.FRONTEND_URL || "http://localhost:3000";
  return raw
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((origin) => origin.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

const allowedOrigins = getAllowedOrigins();

app.use((req, _res, next) => {
  if (req.listenerCount("error") === 0) observeRequestErrors(req);
  next();
});

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origen no permitido por CORS."));
  },
}));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "fastway-academia-backend" }));

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos inválidos." });
  const user = await User.findOne({ email: parsed.data.email.toLowerCase() });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Correo o contraseña incorrectos." });
  }
  setSessionCookie(res, await createSessionToken(user));
  res.json({ ok: true, role: user.role });
}));

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", requireUser, (req, res) => res.json({ user: serializeUser(req.user) }));

app.get("/api/course", requireUser, asyncRoute(async (req, res) => {
  const course = await Course.findOne({ slug: "principal", active: true }).lean();
  const videos = course ? getCourseVideos(course) : [];
  res.json({
    user: serializeUser(req.user),
    course: course ? {
      title: course.title,
      description: course.description,
      videos: videos.map(({ s3Key: _s3Key, ...video }) => video),
    } : null,
    access: getAccessWindow(req.user),
    completedVideoIds: req.user.completedVideoIds || [],
  });
}));

async function getAuthorizedVideo(req, res) {
  const course = await Course.findOne({ slug: "principal", active: true });
  if (!course) {
    res.status(404).json({ error: "No hay curso activo." });
    return null;
  }
  const videos = getCourseVideos(course);
  const video = videos.find((item) => item.id === (req.query.videoId || videos[0]?.id));
  if (!video) {
    res.status(404).json({ error: "La lección no existe." });
    return null;
  }

  if (req.user.role !== "admin" && !req.user.accessStartsAt) {
    req.user.accessStartsAt = new Date();
    await req.user.save();
  }
  const access = getAccessWindow(req.user);
  if (req.user.role !== "admin" && !access.active) {
    res.status(403).json({ error: "Tu acceso al video está bloqueado." });
    return null;
  }
  if (req.user.role !== "admin" && !isVideoUnlocked(videos, video.id, req.user.completedVideoIds || [])) {
    res.status(403).json({ error: "Completa las lecciones anteriores para continuar." });
    return null;
  }

  return video;
}

app.get("/api/video/play", requireUser, asyncRoute(async (req, res) => {
  const video = await getAuthorizedVideo(req, res);
  if (!video) return;

  const configuredApiUrl = (process.env.PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
  const apiUrl = configuredApiUrl || `${req.protocol}://${req.get("host")}`;
  const token = await createPlaybackToken({
    videoId: video.id,
    key: video.s3Key,
    userId: req.user._id.toString(),
  });
  const url = `${apiUrl}/api/video/stream?videoId=${encodeURIComponent(video.id)}&token=${encodeURIComponent(token)}`;
  res.json({ url, videoId: video.id, type: video.s3Key.endsWith(".m3u8") ? "hls" : "file" });
}));

app.get("/api/video/stream", requirePlaybackToken, asyncRoute(async (req, res) => {
  if (req.query.videoId !== req.playback.videoId) return res.status(403).json({ error: "Video no autorizado." });

  const isHls = req.playback.key.endsWith(".m3u8");
  const hlsPrefix = isHls ? req.playback.key.slice(0, req.playback.key.lastIndexOf("/") + 1) : "";
  const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
  const normalizedPath = requestedPath ? posix.normalize(requestedPath).replace(/^\/+/, "") : "master.m3u8";
  if (isHls && (normalizedPath.startsWith("..") || normalizedPath.includes("/../"))) {
    return res.status(403).json({ error: "Segmento no autorizado." });
  }
  const objectKey = isHls ? `${hlsPrefix}${normalizedPath}` : req.playback.key;

  const object = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ...(req.headers.range ? { Range: req.headers.range } : {}),
  }));

  if (isHls && objectKey.endsWith(".m3u8")) {
    const manifest = await object.Body.transformToString();
    const configuredApiUrl = (process.env.PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
    const apiUrl = configuredApiUrl || `${req.protocol}://${req.get("host")}`;
    const currentPath = normalizedPath;
    const rewritten = manifest.split(/\r?\n/).map((line) => {
      const value = line.trim();
      if (!value || value.startsWith("#") || /^https?:\/\//i.test(value)) return line;
      const resource = value.replace(/\\/g, "/");
      const path = posix.normalize(posix.join(posix.dirname(currentPath), resource));
      const query = new URLSearchParams({ videoId: req.playback.videoId, token: req.query.token, path });
      return `${apiUrl}/api/video/stream?${query}`;
    }).join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.send(rewritten);
  }

  res.status(object.ContentRange ? 206 : 200);
  res.setHeader("Content-Type", object.ContentType || "video/mp4");
  res.setHeader("Accept-Ranges", object.AcceptRanges || "bytes");
  res.setHeader("Cache-Control", isHls ? "private, max-age=21600, immutable" : "private, no-store");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (object.ContentLength !== undefined) res.setHeader("Content-Length", String(object.ContentLength));
  if (object.ContentRange) res.setHeader("Content-Range", object.ContentRange);
  if (!object.Body || typeof object.Body.pipe !== "function") throw new Error("MinIO no devolvió un stream de video.");
  observeTransferErrors(object.Body, req, "Video");
  try {
    await pipeline(object.Body, res);
  } catch (error) {
    if (!isClientDisconnect(error, req)) throw error;
  }
}));

const progressSchema = z.object({ videoId: z.string().min(1) });
app.post("/api/video/progress", requireUser, asyncRoute(async (req, res) => {
  const parsed = progressSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Lección inválida." });
  const course = await Course.findOne({ slug: "principal", active: true });
  if (!course) return res.status(404).json({ error: "No hay curso activo." });
  if (req.user.role !== "admin" && !getAccessWindow(req.user).active) return res.status(403).json({ error: "Tu acceso al curso está bloqueado." });

  const videos = getCourseVideos(course);
  const video = videos.find((item) => item.id === parsed.data.videoId);
  if (!video) return res.status(404).json({ error: "La lección no existe." });
  const completed = req.user.completedVideoIds || [];
  if (req.user.role !== "admin" && !isVideoUnlocked(videos, video.id, completed)) {
    return res.status(403).json({ error: "Completa las lecciones anteriores para continuar." });
  }
  if (!completed.includes(video.id)) {
    req.user.completedVideoIds = [...completed, video.id];
    await req.user.save();
  }
  res.json({ completedVideoIds: req.user.completedVideoIds });
}));

const videoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(2),
  description: z.string().optional().default(""),
  s3Key: z.string().min(3),
  durationLabel: z.string().optional().default(""),
});
const courseSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional().default(""),
  videos: z.array(videoSchema).min(1).max(100),
});

app.get("/api/admin/course", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const course = await Course.findOne({ slug: "principal" }).lean();
  res.json({ course: course ? { title: course.title, description: course.description, videos: getCourseVideos(course) } : null });
}));

app.put("/api/admin/course", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const parsed = courseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos del curso inválidos." });
  const videos = parsed.data.videos.map((video, order) => ({ ...video, order }));
  const currentCourse = await Course.findOne({ slug: "principal" });
  const staleVideos = currentCourse
    ? getCourseVideos(currentCourse).filter((video) => {
      const nextVideo = videos.find((item) => item.id === video.id);
      return !nextVideo || nextVideo.s3Key !== video.s3Key;
    })
    : [];

  const course = await Course.findOneAndUpdate(
    { slug: "principal" },
    {
      title: parsed.data.title,
      description: parsed.data.description,
      videos,
      s3Key: videos[0].s3Key,
      durationLabel: videos[0].durationLabel,
      slug: "principal",
      active: true,
    },
    { upsert: true, returnDocument: "after" }
  );
  if (staleVideos.length) {
    await Promise.all(staleVideos.map((video) => deleteVideoObjects(video.s3Key)));
  }
  res.json({ course });
}));

const uploadSchema = z.object({ filename: z.string().min(1), contentType: z.string().min(3).default("video/mp4") });
app.post("/api/admin/upload-url", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Archivo inválido." });
  const extension = parsed.data.filename.toLowerCase().match(/\.(mp4|mov|m4v|webm)$/)?.[0] || ".mp4";
  const id = randomUUID();
  const prefix = (process.env.S3_VIDEO_PREFIX || "courses").replace(/^\/+|\/+$/g, "");
  const key = `${prefix}/${new Date().toISOString().slice(0, 10)}/${id}${extension}`;
  const configuredApiUrl = (process.env.PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
  const apiUrl = configuredApiUrl || `${req.protocol}://${req.get("host")}`;
  const url = `${apiUrl}/api/admin/upload?key=${encodeURIComponent(key)}`;
  const token = await createUploadToken(key);
  res.json({ url, token, key, id });
}));

const optimizeVideoSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(3),
  originalBytes: z.number().int().positive().optional(),
});
app.post("/api/admin/videos/optimize", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const parsed = optimizeVideoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Video inválido." });
  const prefix = `${(process.env.S3_VIDEO_PREFIX || "courses").replace(/^\/+|\/+$/g, "")}/`;
  if (!parsed.data.key.startsWith(prefix)) return res.status(403).json({ error: "Ruta de video no autorizada." });

  const job = enqueueVideoOptimization({
    id: parsed.data.id,
    sourceKey: parsed.data.key,
    originalBytes: parsed.data.originalBytes,
  });
  res.status(job.status === "done" ? 200 : 202).json({ job });
}));

app.get("/api/admin/videos/:id/optimize", requireUser, requireAdmin, (req, res) => {
  const job = getVideoOptimization(req.params.id);
  if (!job) return res.status(404).json({ error: "No existe una optimización para este video." });
  res.json({ job });
});

app.put("/api/admin/upload", requireUploadToken, asyncRoute(async (req, res) => {
  const key = typeof req.query.key === "string" ? req.query.key : "";
  const prefix = `${(process.env.S3_VIDEO_PREFIX || "courses").replace(/^\/+|\/+$/g, "")}/`;
  const contentType = req.headers["content-type"] || "video/mp4";
  const contentLength = Number(req.headers["content-length"]);
  const maxBytes = Number(process.env.MAX_VIDEO_SIZE_MB || 2048) * 1024 * 1024;

  if (!key.startsWith(prefix) || req.uploadKey !== key) return res.status(403).json({ error: "Ruta de video no autorizada." });
  if (!contentType.startsWith("video/")) return res.status(415).json({ error: "El archivo debe ser un video." });
  if (!Number.isFinite(contentLength) || contentLength <= 0) return res.status(411).json({ error: "No se recibió el tamaño del video." });
  if (contentLength > maxBytes) return res.status(413).json({ error: `El video supera el máximo de ${process.env.MAX_VIDEO_SIZE_MB || 2048} MB.` });

  const abortController = new AbortController();
  const uploadBody = new PassThrough();
  observeTransferErrors(uploadBody, req, "Upload");
  let resolveInput;
  let rejectInput;
  const inputPromise = new Promise((resolve, reject) => {
    resolveInput = resolve;
    rejectInput = reject;
  });
  const finishInput = () => resolveInput();
  const failInput = (error) => {
    abortController.abort();
    uploadBody.destroy();
    rejectInput(error);
  };
  const abortUpload = () => {
    const error = new Error("La subida fue cancelada por el cliente.");
    error.code = "ECONNRESET";
    failInput(error);
  };

  req.once("end", finishInput);
  req.once("aborted", abortUpload);
  req.once("error", failInput);

  const storagePromise = s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: uploadBody,
    ContentLength: contentLength,
    ContentType: contentType,
  }), { abortSignal: abortController.signal }).catch((error) => {
    failInput(error);
    throw error;
  });
  req.pipe(uploadBody);

  try {
    const results = await Promise.allSettled([inputPromise, storagePromise]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed && !isClientDisconnect(failed.reason, req)) throw failed.reason;
    if (!req.aborted && !res.destroyed) res.status(201).json({ ok: true, key });
  } finally {
    req.unpipe(uploadBody);
    req.off("end", finishInput);
    req.off("aborted", abortUpload);
    req.off("error", failInput);
  }
}));

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  accessDurationDays: z.number().min(1).max(365).default(20),
});
app.get("/api/admin/users", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const users = await User.find({ role: "student" }).sort({ createdAt: -1 });
  res.json({ users: users.map(serializeUser) });
}));

app.post("/api/admin/users", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos del alumno inválidos." });
  const email = parsed.data.email.toLowerCase();
  if (await User.exists({ email })) return res.status(409).json({ error: "Ya existe un usuario con ese correo." });
  const user = await User.create({
    name: parsed.data.name,
    email,
    passwordHash: await bcrypt.hash(parsed.data.password, 12),
    role: "student",
    accessDurationDays: parsed.data.accessDurationDays,
  });
  res.json({ user: serializeUser(user) });
}));

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  accessDurationDays: z.number().min(1).max(365).optional(),
  blocked: z.boolean().optional(),
  password: z.union([z.string().min(8), z.literal("")]).optional(),
  resetAccess: z.boolean().optional(),
});
app.patch("/api/admin/users/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Datos del alumno inválidos." });
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: "Identificador de alumno inválido." });
  const user = await User.findOne({ _id: req.params.id, role: "student" });
  if (!user) return res.status(404).json({ error: "Alumno no encontrado." });
  if (parsed.data.email && parsed.data.email.toLowerCase() !== user.email) {
    const email = parsed.data.email.toLowerCase();
    if (await User.exists({ email, _id: { $ne: user._id } })) return res.status(409).json({ error: "Ya existe un usuario con ese correo." });
    user.email = email;
  }
  if (parsed.data.name !== undefined) user.name = parsed.data.name;
  if (parsed.data.accessDurationDays !== undefined) user.accessDurationDays = parsed.data.accessDurationDays;
  if (parsed.data.blocked !== undefined) user.blocked = parsed.data.blocked;
  if (parsed.data.resetAccess) {
    user.accessStartsAt = undefined;
    user.completedVideoIds = [];
  }
  if (parsed.data.password) user.passwordHash = await bcrypt.hash(parsed.data.password, 12);
  await user.save();
  res.json({ user: serializeUser(user) });
}));

app.use((error, req, res, _next) => {
  if (isClientDisconnect(error, req)) {
    if (!res.destroyed) res.destroy();
    return;
  }
  console.error(error);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: "Error interno del servidor." });
});

await connectDB();
const port = Number(process.env.PORT || 4100);
const server = createServer({ IncomingMessage: SafeIncomingMessage }, app);
server.on("clientError", (error, socket) => {
  if (!isClientDisconnect(error)) console.error("HTTP client error:", error);
  socket.destroy();
});
server.listen(port, () => console.log(`Fastway backend ready at http://localhost:${port}`));
