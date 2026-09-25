export function getCourseVideos(course) {
  if (course.videos?.length) {
    return [...course.videos]
      .map((video) => ({
        id: video.id,
        title: video.title,
        description: video.description || "",
        s3Key: video.s3Key,
        durationLabel: video.durationLabel || "",
        order: video.order,
        quiz: video.quiz?.questions?.length ? {
          passingScore: video.quiz.passingScore ?? 70,
          questions: video.quiz.questions.map((question) => ({
            id: question.id,
            prompt: question.prompt,
            options: [...question.options],
            correctOptionIndex: question.correctOptionIndex,
          })),
        } : null,
      }))
      .sort((a, b) => a.order - b.order);
  }
  if (!course.s3Key) return [];
  return [{
    id: "video-principal",
    title: course.title,
    description: "",
    s3Key: course.s3Key,
    durationLabel: course.durationLabel || "Video principal",
    order: 0,
    quiz: null,
  }];
}

export function isVideoUnlocked(videos, videoId, completedIds) {
  const index = videos.findIndex((video) => video.id === videoId);
  return index >= 0 && videos.slice(0, index).every((video) => completedIds.includes(video.id));
}

export function getValidatedCompletedVideoIds(videos, user) {
  const passedQuizIds = new Set(
    (user.quizAttempts || []).filter((attempt) => attempt.passed).map((attempt) => attempt.videoId)
  );
  return (user.completedVideoIds || []).filter((videoId) => {
    const video = videos.find((item) => item.id === videoId);
    return !video?.quiz?.questions?.length || passedQuizIds.has(videoId);
  });
}

export function getAccessWindow(user) {
  const durationDays = user.accessDurationDays || Number(process.env.DEFAULT_ACCESS_DAYS || 20);
  const startsAt = user.accessStartsAt ? new Date(user.accessStartsAt) : null;
  const expiresAt = startsAt ? new Date(startsAt.getTime() + durationDays * 86400000) : null;
  const expired = Boolean(expiresAt && expiresAt.getTime() <= Date.now());
  const active = !user.blocked && !expired;
  const remainingMs = expiresAt ? Math.max(0, expiresAt.getTime() - Date.now()) : durationDays * 86400000;
  return {
    active,
    blocked: Boolean(user.blocked),
    expired,
    startsAt,
    expiresAt,
    durationDays,
    remainingDays: Math.ceil(remainingMs / 86400000),
  };
}
