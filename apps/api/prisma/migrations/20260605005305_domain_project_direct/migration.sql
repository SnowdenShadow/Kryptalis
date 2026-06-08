-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "domains_projectId_idx" ON "domains"("projectId");

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
