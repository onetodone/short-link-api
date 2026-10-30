-- CreateEnum
CREATE TYPE "UrlDisabledReason" AS ENUM ('UNSAFE_DESTINATION', 'MANUAL', 'ACCOUNT_SUSPENDED');

-- AlterTable
ALTER TABLE "urls" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "disabledReason" "UrlDisabledReason";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "suspendedAt" TIMESTAMP(3);
