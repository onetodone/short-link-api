-- AlterTable
ALTER TABLE "users" ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3);

-- Existing accounts accepted the terms in effect when they registered.
UPDATE "users" SET "termsAcceptedAt" = "createdAt";

ALTER TABLE "users" ALTER COLUMN "termsAcceptedAt" SET NOT NULL;
