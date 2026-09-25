import bcrypt from "bcryptjs";
import mongoose from "mongoose";

const { MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

if (!MONGODB_URI || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Missing MONGODB_URI, ADMIN_EMAIL or ADMIN_PASSWORD.");
  process.exit(1);
}

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["student", "admin"], default: "student", required: true },
    accessStartsAt: { type: Date },
    accessDurationDays: { type: Number, default: 20, min: 1 },
    blocked: { type: Boolean, default: false },
    completedVideoIds: { type: [String], default: [] },
  },
  { timestamps: true }
);

await mongoose.connect(MONGODB_URI);
const User = mongoose.models.User || mongoose.model("User", userSchema);

const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
await User.findOneAndUpdate(
  { email: ADMIN_EMAIL.toLowerCase() },
  {
    email: ADMIN_EMAIL.toLowerCase(),
    name: "Administrador",
    passwordHash,
    role: "admin",
    accessDurationDays: 365,
    blocked: false,
  },
  { upsert: true, new: true }
);

await mongoose.disconnect();
console.log(`Admin ready: ${ADMIN_EMAIL}`);
