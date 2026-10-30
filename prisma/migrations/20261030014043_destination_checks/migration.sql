-- AlterTable
ALTER TABLE "urls" ADD COLUMN     "destinationCheckedAt" TIMESTAMP(3),
ADD COLUMN     "destinationSetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing destinations were set when the link was created.
UPDATE "urls" SET "destinationSetAt" = "createdAt";
