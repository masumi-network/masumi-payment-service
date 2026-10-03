ALTER TABLE "HydraHost"
ADD COLUMN "allowInsecureHttp" BOOLEAN NOT NULL DEFAULT false;

-- Preserve intentional existing HTTP deployments. New registrations require
-- the explicit API/UI opt-in before an HTTP URL is accepted.
UPDATE "HydraHost"
SET "allowInsecureHttp" = true
WHERE "baseUrl" LIKE 'http://%';
