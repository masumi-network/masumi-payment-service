#!/bin/sh
# Apply the checked-in database migrations. Run it once per release, from the
# release image, before the new version starts.
set -eu

cd "$(dirname "$0")/.."

# migrate deploy exits 0 when it finds no migration files, so an image built
# without them would pass this step without migrating anything.
if ! ls prisma/migrations/*/migration.sql >/dev/null 2>&1; then
  echo "ERROR: no migrations found in prisma/migrations" >&2
  exit 1
fi

# prisma.config.ts stops with an error when DATABASE_URL is not set.
exec node_modules/.bin/prisma migrate deploy --config prisma/prisma.config.ts
