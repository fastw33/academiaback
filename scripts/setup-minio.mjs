import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import mongoose from "mongoose";

const required = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_BUCKET",
  "S3_ENDPOINT",
];

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!mongoUri) throw new Error("Missing MONGO_URI");

for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}

const client = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const bucket = process.env.S3_BUCKET;
const videoPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), "..", "..", "Sistemas Genika", "Page-Fastway", "public", "videos", "video-web-equilibrado-720p.mp4");
const key = `${process.env.S3_VIDEO_PREFIX || "courses"}/fastway/curso-principal.mp4`;

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`Bucket ready: ${bucket}`);
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Bucket created: ${bucket}`);
}

try {
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ["*"],
            AllowedMethods: ["GET", "HEAD", "PUT"],
            AllowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
            ExposeHeaders: ["ETag", "Accept-Ranges", "Content-Range", "Content-Length"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    })
  );
  console.log("Bucket CORS configured");
} catch (error) {
  if (error?.$metadata?.httpStatusCode !== 501) throw error;
  console.log("Bucket CORS API not supported; using MinIO global CORS");
}

const file = await stat(videoPath);
await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(videoPath),
    ContentLength: file.size,
    ContentType: "video/mp4",
  })
);

const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
if (object.ContentLength !== file.size) throw new Error("Uploaded video size does not match source file");

await mongoose.connect(mongoUri);
const courseSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    videos: { type: [new mongoose.Schema({
      id: { type: String, required: true },
      title: { type: String, required: true },
      description: { type: String, default: "" },
      s3Key: { type: String, required: true },
      durationLabel: { type: String, default: "" },
      order: { type: Number, required: true },
    }, { _id: false })], default: [] },
    s3Key: { type: String },
    durationLabel: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
const Course = mongoose.models.Course || mongoose.model("Course", courseSchema);

await Course.findOneAndUpdate(
  { slug: "principal" },
  {
    slug: "principal",
    title: "Formación Fastway",
    description: "Contenido de formación corporativa para el equipo Fastway.",
    videos: [{
      id: "video-principal",
      title: "Introducción a Fastway",
      description: "Presentación general de nuestra operación logística.",
      s3Key: key,
      durationLabel: "22 s",
      order: 0,
    }],
    s3Key: key,
    durationLabel: "Video principal",
    active: true,
  },
  { upsert: true, returnDocument: "after" }
);

await mongoose.disconnect();
console.log(`Video uploaded: s3://${bucket}/${key} (${file.size} bytes)`);
console.log("Course configured: principal");
