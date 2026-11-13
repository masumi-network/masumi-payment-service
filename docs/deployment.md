# Deployment Guide

You can deploy it to any cloud service which can handle docker images.

Popular services are [AWS](https://aws.amazon.com/), [GCP](https://cloud.google.com/), [Azure](https://azure.microsoft.com/) or
[Digital Ocean](https://www.digitalocean.com/)

We recommend also using a PostgreSQL database service and do backups of the database and especially wallet data.

## Run with Docker

The Docker image no longer copies `.env` files into the build context or runtime image. Backend secrets must be
provided at container runtime, and frontend `NEXT_PUBLIC_*` values must be passed explicitly as build arguments.

1. Create the `.env` file with the correct backend runtime values or inject the values directly into Docker.
2. Build the image. The default frontend API base URL is `/api/v1`, so a plain build works:

   ```
   docker build -t masumi-payment-service .
   ```

   If you need to override public frontend values, pass them explicitly as `--build-arg`:

   ```
   docker build \
     --build-arg NEXT_PUBLIC_PAYMENT_API_BASE_URL=https://example.com/api/v1 \
     -t masumi-payment-service .
   ```

   Optional public frontend build arguments supported by the image:
   - `NEXT_PUBLIC_PAYMENT_API_BASE_URL`

   Do not pass backend secrets such as `DATABASE_URL`, `ENCRYPTION_KEY`, `ADMIN_KEY`, or Blockfrost server keys as
   build arguments.

3. Apply the database migrations from the new image, before you start it:

   ```
   docker run --rm --env-file .env masumi-payment-service sh scripts/migrate.sh
   ```

   Do this for each new release. See [Apply migrations on each release](#apply-migrations-on-each-release).

4. Run the container with runtime env injection:

   ```
   docker run --env-file .env -d -p 127.0.0.1:3001:3001 masumi-payment-service
   ```

   Replacing `masumi-payment-service` with the image name, and `3001:3001` with the `host:container` ports to
   publish.

   The service serves plain HTTP and sends no HSTS header. Without TLS in front, API keys cross the network
   unencrypted. The `127.0.0.1` prefix publishes the port on the host loopback only. Put a TLS-terminating reverse
   proxy in front of it before other hosts can reach it, and do not publish the port on all interfaces without one.

5. If you use Docker Compose, keep the same split between public build args and runtime secrets:

   ```yaml
   services:
     payment-service:
       build:
         context: .
         args:
           NEXT_PUBLIC_PAYMENT_API_BASE_URL: /api/v1
       env_file:
         - .env
       ports:
         - '127.0.0.1:3001:3001'
   ```

   The same TLS requirement applies. Keep the loopback binding unless a TLS-terminating proxy is in front.

6. Verify `.env` and `frontend/.env` are excluded from the image build context via `.dockerignore`. Only
   `.env.example` files should remain available for reference.

Otherwise you can run the project locally by following the Quickstart guide in the [README](../README.md)

## Apply migrations on each release

The release image contains `scripts/migrate.sh`. It runs `prisma migrate deploy` and exits non-zero on any failure,
so a failed migration stops the release. It also stops with an error when `DATABASE_URL` is not set, or when the
image contains no migration files.

Run it once for each release, before the new version starts. Do not run it in every app instance. A second run
that starts while the first one migrates fails with `P1002` after about 10 seconds.

### DigitalOcean App Platform

Add a pre-deploy job to the app spec. The job must run the same image as the service:

- If the app builds from this repository, the job uses the same source and Dockerfile as the service.
- If the app pulls a published image, give the job the same `image` block and the same tag as the service. A job
  that runs a different tag applies a different set of migrations.

```yaml
jobs:
  - name: migrate
    kind: PRE_DEPLOY
    run_command: sh /usr/src/app/scripts/migrate.sh
    envs:
      - key: DATABASE_URL
        scope: RUN_TIME
        value: ${db.DATABASE_URL}
```

Replace `db` with the name of the database component. If the job fails, App Platform does not deploy the new
version.

### Use the direct database URL

Migrations need a direct connection to Postgres. Do not give the migrate job a pooled (PgBouncer) URL, even when
the app itself uses one. Set the job's own `DATABASE_URL` to the direct URL.

### Keep each migration compatible with the running version

The pre-deploy job runs while the old version still serves traffic. It also applies all pending migrations in one
step, so you cannot stop between two migrations of the same release. Write each migration so that the old version
continues to work after it is applied:

- Add tables, columns, and indexes in one release.
- Drop or rename a column only in a later release, after no deployed version reads or writes it.

[docs/migrations/web3-cardano-v2.md](migrations/web3-cardano-v2.md) is an example. Its Migration B must ship in a
later release than Migration A.

## When a migration deploy fails

`prisma migrate deploy` records a failed migration and then refuses to apply
anything else, including the fix. Every subsequent deploy exits with:

```
P3009 migrate found failed migrations in the target database
```

Prisma will not clear that row on its own, by design: it cannot know whether the
failed migration left the database half-changed. You decide, and you tell it.

1. Read what actually failed. The name and the Postgres error are in the output
   of the deploy that first broke, and in `_prisma_migrations`:

   ```bash
   psql "$DATABASE_URL" -c "select migration_name, started_at, finished_at, logs from \"_prisma_migrations\" where finished_at is null and rolled_back_at is null"
   ```

2. Decide which of the two it was.
   - **It changed nothing** — it failed on its first statement, or every
     statement is guarded and the objects already existed. Mark it rolled back
     so the corrected version applies on the next deploy:

     ```bash
     pnpm exec prisma migrate resolve --config prisma/prisma.config.ts --rolled-back <migration_name>
     ```

   - **It changed something and the change is what you wanted** — a partial
     apply you have since completed by hand. Mark it applied:

     ```bash
     pnpm exec prisma migrate resolve --config prisma/prisma.config.ts --applied <migration_name>
     ```

   If it changed something and you do not want it, undo that by hand first, then
   use `--rolled-back`.

3. Deploy again, and check for drift:

   ```bash
   pnpm run prisma:migrate
   ```

   ```bash
   pnpm exec prisma migrate diff --config prisma/prisma.config.ts --from-config-datasource --to-schema prisma/schema.prisma
   ```

   "No difference detected" means the database matches the schema.

Both commands take the migration's directory name, not its path — for example
`20260630105329_hydra_tmp`. Neither runs any SQL; they only write the row that
`deploy` reads.

The commands above run from a checkout of this repository. Inside the release
image, use `node_modules/.bin/prisma` in place of `pnpm exec prisma`, and
`sh scripts/migrate.sh` in place of `pnpm run prisma:migrate`. pnpm downloads its
pinned version on first use, so it fails in a container without internet access.
For example:

```bash
docker run --rm --env-file .env masumi-payment-service node_modules/.bin/prisma migrate resolve --config prisma/prisma.config.ts --rolled-back <migration_name>
```
