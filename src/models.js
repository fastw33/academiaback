import mongoose from "mongoose";

const quizQuestionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    prompt: { type: String, required: true, trim: true },
    options: { type: [String], required: true, validate: (options) => options.length === 4 },
    correctOptionIndex: { type: Number, required: true, min: 0, max: 3 },
  },
  { _id: false }
);

const quizSchema = new mongoose.Schema(
  {
    passingScore: { type: Number, default: 70, min: 1, max: 100 },
    questions: { type: [quizQuestionSchema], default: [] },
  },
  { _id: false }
);

const videoSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    s3Key: { type: String, required: true },
    durationLabel: { type: String, default: "" },
    order: { type: Number, required: true, min: 0 },
    quiz: { type: quizSchema, default: undefined },
  },
  { _id: false }
);

const quizAttemptSchema = new mongoose.Schema(
  {
    videoId: { type: String, required: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    passed: { type: Boolean, required: true },
    correct: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    answers: {
      type: [{
        questionId: { type: String, required: true },
        optionIndex: { type: Number, required: true, min: 0, max: 3 },
        isCorrect: { type: Boolean, required: true },
        _id: false,
      }],
      default: [],
    },
    attemptedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const courseSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, default: "principal" },
    title: { type: String, required: true, default: "Curso principal" },
    description: { type: String, default: "" },
    videos: { type: [videoSchema], default: [] },
    s3Key: { type: String },
    durationLabel: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

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
    watchedVideoIds: { type: [String], default: [] },
    quizAttempts: { type: [quizAttemptSchema], default: [] },
  },
  { timestamps: true }
);

export const Course = mongoose.models.Course || mongoose.model("Course", courseSchema);
export const User = mongoose.models.User || mongoose.model("User", userSchema);

export async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI es obligatoria.");
  await mongoose.connect(uri);
}
