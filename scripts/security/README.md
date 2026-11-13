# Security setup and report

One script, `security.sh`, for the **masumi-network** organisation. It

- **setup**: switches on Dependabot alerts and automatic fix PRs for every repo of the organisation, and secret scanning, push protection and CodeQL for the public repos;
- **report**: emails one table of every open alert across those repos;
- **check**: tests the token, the owner and the mail settings before anything else.

Needs `bash`, `gh`, `jq`, `curl` (all present on GitHub Actions runners and on a normal Mac).

## Quick start

1. `cp security.env.example security.env` and fill it in (it is git-ignored, never commit it):
   - `GH_TOKEN`: a classic token with the scopes `repo` and `read:org`, created by an **org owner** (or a security manager). If the org uses SAML SSO, authorize the token for it.
   - `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_TO`: the sender, its password (Gmail: an app password) and the recipients (comma separated). `MAIL_SMTP_URL` defaults to Gmail.
2. Run, in this order:

```
./security.sh check --mail      # token, owner, admin access, mail settings, sends a test email
./security.sh setup             # DRY RUN: shows what would change, changes nothing
./security.sh setup --apply     # makes the changes
./security.sh report --no-mail --out report.html   # look at it first
./security.sh report            # builds it and emails it
```

## What each command does

| Command                           | Changes anything?                                                                 | Exit code                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `check [--mail]`                  | No (`--mail` sends one test email)                                                | 1 if something is wrong                                                                                    |
| `setup`                           | No, dry run                                                                       | 1 if a repo cannot be changed (for example no admin access)                                                |
| `setup --apply`                   | Yes: only settings that are off get switched on; running it again changes nothing | 1 if a repo could not be fully set up                                                                      |
| `report [--no-mail] [--out FILE]` | No                                                                                | 1 if the email was not sent, or if any repo could not be scanned (the email still goes out and lists them) |

- Archived repos are skipped. Forks are included. `REPOS_ONLY=a,b` limits it to those repos, `REPOS_EXCLUDE=c,d` leaves some out. Names are matched without regard to case, and a name that matches no repo is an error (so a typo can never widen what `--apply` touches).
- Private repos get Dependabot alerts and fix PRs only. CodeQL and secret scanning on private repos need a paid GitHub plan; if the org has it, set `PRIVATE_CODE_SCANNING=true`.
- CodeQL fails on a repo with no supported language. That is shown as a warning, not an error.
- Run `setup --apply` again whenever new repos are created (or use an org security configuration for new repos).
- `setup --apply` waits `WRITE_PAUSE` seconds (default 1) after each repo it changed, to stay under GitHub's rate limits.
- If GitHub answers a read with a temporary error, `setup` may show a change that was not needed; applying it is harmless, and running it again fixes the display.
- Keep `security.env` at mode 600 (`chmod 600 security.env`); the script warns if others can read it.
- The report lists repos it could not scan (for example Dependabot alerts still off) in their own section, so a gap is visible.

## Run it every day

`security-report.yml.example` runs `report` daily. It is not active here: copy it to `.github/workflows/` of a private repo that holds the files of this folder at its root. Put the token in the repo secret `SECURITY_REPORT_TOKEN` and the mail settings in `MAIL_USER`, `MAIL_PASSWORD` and `MAIL_TO`. Give that token only read access if you can (the report does not change anything); use the admin token just for `setup --apply`, from a laptop.

GitHub can start scheduled runs late or skip them. Check the run history if an email is missing.

## Not covered

- A `dependabot.yml` per repo (for example to keep Dependabot away from the pinned Mesh SDK packages in masumi-payment-service). Do it per repo.
- Renew the token before it expires: the report fails with "the GitHub token does not work".
