# Deployment Guide

You can deploy it to any cloud service which can handle docker images.

Popular services are [AWS](https://aws.amazon.com/), [GCP](https://cloud.google.com/), [Azure](https://azure.microsoft.com/) or
[Digital Ocean](https://www.digitalocean.com/)

We recommend also using a PostgreSQL database service and do backups of the database and especially wallet data.

## Run with Docker

The Docker image no longer copies `.env` files into the build context or runtime image. Backend secrets must be
provided at container runtime, and frontend `NEXT_PUBLIC_*` values must be passed explicitly as build arguments.

1. Create the `.env` file with the correct backend runtime values or inject the values directly into Docker (migrate
   the database and optionally seed it first).
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

3. Run the container with runtime env injection:

   ```
   docker run --env-file .env -d -p 3001:3001 masumi-payment-service
   ```

   Replacing `masumi-payment-service` with the image name, and `3001:3001` with the `host:container` ports to
   publish.

4. If you use Docker Compose, keep the same split between public build args and runtime secrets:

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
         - '3001:3001'
   ```

5. Verify `.env` and `frontend/.env` are excluded from the image build context via `.dockerignore`. Only
   `.env.example` files should remain available for reference.

Otherwise you can run the project locally by following the Quickstart guide in the [README](../README.md)

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
   psql "$DATABASE_URL" -c "select migration_name, started_at, finished_at, logs from \"_prisma_migrations\" where finished_at is null"
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
