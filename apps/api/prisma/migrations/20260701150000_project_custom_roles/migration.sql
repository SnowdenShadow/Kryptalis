-- Per-project reusable custom roles with a fine-grained permission grid.
-- Members opt into one via project_members.customRoleId (SetNull on delete, so
-- removing a role reverts affected members to their base `role`).

-- CreateTable
CREATE TABLE "project_custom_roles" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseRole" "ProjectRole" NOT NULL DEFAULT 'DEVELOPER',
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_custom_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_custom_roles_projectId_idx" ON "project_custom_roles"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_custom_roles_projectId_name_key" ON "project_custom_roles"("projectId", "name");

-- AlterTable
ALTER TABLE "project_members" ADD COLUMN "customRoleId" TEXT;

-- CreateIndex
CREATE INDEX "project_members_customRoleId_idx" ON "project_members"("customRoleId");

-- AddForeignKey
ALTER TABLE "project_custom_roles" ADD CONSTRAINT "project_custom_roles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_customRoleId_fkey" FOREIGN KEY ("customRoleId") REFERENCES "project_custom_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
