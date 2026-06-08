-- AlterTable
ALTER TABLE "databases" ADD COLUMN     "applicationId" TEXT,
ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "databases_projectId_idx" ON "databases"("projectId");

-- CreateIndex
CREATE INDEX "databases_applicationId_idx" ON "databases"("applicationId");

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
