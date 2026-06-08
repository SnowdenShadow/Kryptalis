-- CreateEnum
CREATE TYPE "MailServerStatus" AS ENUM ('STOPPED', 'DEPLOYING', 'RUNNING', 'ERROR');

-- CreateTable
CREATE TABLE "mail_servers" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "status" "MailServerStatus" NOT NULL DEFAULT 'STOPPED',
    "smtpPort" INTEGER NOT NULL DEFAULT 2525,
    "submissionPort" INTEGER NOT NULL DEFAULT 587,
    "imapPort" INTEGER NOT NULL DEFAULT 1143,
    "imapsPort" INTEGER NOT NULL DEFAULT 993,
    "smtpsPort" INTEGER NOT NULL DEFAULT 465,
    "dkimSelector" TEXT NOT NULL DEFAULT 'kryptalis',
    "dkimPublicKey" TEXT,
    "dkimPrivateKey" TEXT,
    "hostname" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_servers_domainId_key" ON "mail_servers"("domainId");

-- AddForeignKey
ALTER TABLE "mail_servers" ADD CONSTRAINT "mail_servers_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
