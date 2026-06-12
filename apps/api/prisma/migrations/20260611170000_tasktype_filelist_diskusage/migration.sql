-- Remote file manager + remote storage-quota accounting task types.
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'FILE_LIST';
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'FILE_DELETE';
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'DISK_USAGE';
-- Remote SFTP: push the desired account set to an agent's embedded server.
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'SFTP_SYNC';
