#!/bin/sh
# Apply the checked-in database migrations. Run it once per release, from the
# release image, before the new version starts.
set -eu

cd "$(dirname "$0")/.."

# prisma.config.ts falls back to a placeholder URL when DATABASE_URL is missing,
# which would only show up as a connection error against localhost.
if ! node --input-type=commonjs -e "require('dotenv/config'); process.exit(process.env.DATABASE_URL ? 0 : 1)"; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

# migrate deploy exits 0 when it finds no migration files, so an image built
# without them would pass this step without migrating anything.
if ! ls prisma/migrations/*/migration.sql >/dev/null 2>&1; then
  echo "ERROR: no migrations found in prisma/migrations" >&2
  exit 1
fi

# Called directly instead of through pnpm, which downloads its pinned version
# on first use and so needs network access inside the release image.
exec node_modules/.bin/prisma migrate deploy --config prisma/prisma.config.ts
