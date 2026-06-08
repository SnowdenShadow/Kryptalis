-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateTable
CREATE TABLE "mailboxes" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "localPart" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "projectId" TEXT,
    "passwordHash" TEXT NOT NULL,
    "quotaMb" INTEGER NOT NULL DEFAULT 2048,
    "usedMb" INTEGER NOT NULL DEFAULT 0,
    "status" "MailboxStatus" NOT NULL DEFAULT 'ACTIVE',
    "forwardTo" TEXT,
    "catchAll" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_aliases" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "targetMailboxId" TEXT,
    "forwardTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_address_key" ON "mailboxes"("address");

-- CreateIndex
CREATE INDEX "mailboxes_domainId_idx" ON "mailboxes"("domainId");

-- CreateIndex
CREATE INDEX "mailboxes_projectId_idx" ON "mailboxes"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "email_aliases_address_key" ON "email_aliases"("address");

-- CreateIndex
CREATE INDEX "email_aliases_domainId_idx" ON "email_aliases"("domainId");

-- CreateIndex
CREATE INDEX "email_aliases_targetMailboxId_idx" ON "email_aliases"("targetMailboxId");

-- AddForeignKey
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_aliases" ADD CONSTRAINT "email_aliases_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_aliases" ADD CONSTRAINT "email_aliases_targetMailboxId_fkey" FOREIGN KEY ("targetMailboxId") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
