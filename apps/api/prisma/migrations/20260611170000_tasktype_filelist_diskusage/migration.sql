-- Remote file manager + remote storage-quota accounting task types.
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'FILE_LIST';
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'DISK_USAGE';
