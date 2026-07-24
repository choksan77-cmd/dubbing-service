-- CreateEnum
CREATE TYPE "DubJobStatus" AS ENUM ('pending', 'downloading', 'transcribing', 'translating', 'dubbing', 'muxing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "DubJobSourceType" AS ENUM ('upload', 'youtube');

-- CreateTable
CREATE TABLE "DubJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" "DubJobSourceType" NOT NULL,
    "sourceUrl" TEXT,
    "originalFilename" TEXT,
    "targetLanguage" TEXT NOT NULL,
    "status" "DubJobStatus" NOT NULL DEFAULT 'pending',
    "transcript" JSONB,
    "translatedTranscript" JSONB,
    "errorMessage" TEXT,
    "outputPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DubJob_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DubJob" ADD CONSTRAINT "DubJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
