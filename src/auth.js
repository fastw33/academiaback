import { jwtVerify, SignJWT } from "jose";
import { User } from "./models.js";

const cookieName = "curso_session";
const uploadAudience = "fastway-academia-upload";
const playbackAudience = "fastway-academia-playback";
const secret = () => {
  const value = process.env.JWT_SECRET || process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("JWT_SECRET debe tener al menos 32 caracteres.");
  return new TextEncoder().encode(value);
};

export async function createSessionToken(user) {
  return new SignJWT({ email: user.email, role: user.role, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user._id.toString())
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
}

export async function createUploadToken(key) {
  return new SignJWT({ scope: "video:upload", key })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(uploadAudience)
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(secret());
}

export async function createPlaybackToken({ videoId, key, userId }) {
  return new SignJWT({ scope: "video:play", videoId, key })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(playbackAudience)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret());
}

export function setSessionCookie(res, token) {
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/" });
}

export async function requireUser(req, res, next) {
  const token = req.cookies[cookieName];
  if (!token) return res.status(401).json({ error: "Sesión requerida." });
  try {
    const { payload } = await jwtVerify(token, secret());
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: "Sesión inválida." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Sesión inválida." });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acceso de administrador requerido." });
  next();
}

export async function requireUploadToken(req, res, next) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Autorización de subida requerida." });

  try {
    const { payload } = await jwtVerify(token, secret(), { audience: uploadAudience });
    if (payload.scope !== "video:upload" || typeof payload.key !== "string") {
      return res.status(403).json({ error: "Autorización de subida inválida." });
    }
    req.uploadKey = payload.key;
    next();
  } catch {
    return res.status(401).json({ error: "La autorización de subida venció o no es válida." });
  }
}

export async function requirePlaybackToken(req, res, next) {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) return res.status(401).json({ error: "Autorización de reproducción requerida." });

  try {
    const { payload } = await jwtVerify(token, secret(), { audience: playbackAudience });
    if (payload.scope !== "video:play" || typeof payload.videoId !== "string" || typeof payload.key !== "string") {
      return res.status(403).json({ error: "Autorización de reproducción inválida." });
    }
    req.playback = { videoId: payload.videoId, key: payload.key };
    next();
  } catch {
    return res.status(401).json({ error: "La autorización de reproducción venció o no es válida." });
  }
}

export function serializeUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    accessDurationDays: user.accessDurationDays,
    accessStartsAt: user.accessStartsAt || null,
    blocked: user.blocked,
    completedVideoIds: user.completedVideoIds || [],
  };
}
