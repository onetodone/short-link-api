-- DropForeignKey
ALTER TABLE "urls" DROP CONSTRAINT "urls_userId_fkey";

-- AddForeignKey
ALTER TABLE "urls" ADD CONSTRAINT "urls_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
