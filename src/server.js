import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { connectDB, Course, User } from "./models.js";
import { clearSessionCookie, createSessionToken, requireAdmin, requireUser, serializeUser, setSessionCookie } from "./auth.js";
import { getAccessWindow, getCourseVideos, isVideoUnlocked } from "./course-videos.js";
import { bucket, s3 } from "./s3.js";

const app = express();
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
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

app.get("/api/video/play", requireUser, asyncRoute(async (req, res) => {
  const course = await Course.findOne({ slug: "principal", active: true });
  if (!course) return res.status(404).json({ error: "No hay curso activo." });
  const videos = getCourseVideos(course);
  const video = videos.find((item) => item.id === (req.query.videoId || videos[0]?.id));
  if (!video) return res.status(404).json({ error: "La lección no existe." });

  if (req.user.role !== "admin" && !req.user.accessStartsAt) {
    req.user.accessStartsAt = new Date();
    await req.user.save();
  }
  const access = getAccessWindow(req.user);
  if (req.user.role !== "admin" && !access.active) return res.status(403).json({ error: "Tu acceso al video está bloqueado." });
  if (req.user.role !== "admin" && !isVideoUnlocked(videos, video.id, req.user.completedVideoIds || [])) {
    return res.status(403).json({ error: "Completa las lecciones anteriores para continuar." });
  }

  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket,
    Key: video.s3Key,
    ResponseContentDisposition: "inline",
  }), { expiresIn: 120 });
  res.json({ url, expiresIn: 120, videoId: video.id });
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
  const removedVideos = currentCourse
    ? getCourseVideos(currentCourse).filter((video) => !videos.some((nextVideo) => nextVideo.id === video.id))
    : [];

  if (removedVideos.length) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: removedVideos.map((video) => ({ Key: video.s3Key })), Quiet: true },
    }));
  }

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
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: parsed.data.contentType }), { expiresIn: 300 });
  res.json({ url, key, id });
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

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Error interno del servidor." });
});

await connectDB();
const port = Number(process.env.PORT || 4100);
app.listen(port, () => console.log(`Fastway backend ready at http://localhost:${port}`));
