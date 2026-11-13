#!/usr/bin/env bash
# security.sh: switch on GitHub's security features for every repository of the
# masumi-network organisation, and email one table of what is still open.
#
#   ./security.sh check  [--mail]                  check the token, the owner and the mail settings
#   ./security.sh setup  [--apply]                 show the changes, or with --apply make them
#   ./security.sh report [--no-mail] [--out FILE]  build the report and email it
#
# Settings come from the environment, or from security.env next to this script
# (see security.env.example). The environment wins over the file.
set -euo pipefail
umask 077

die() {
	echo "ERROR: $*" >&2
	exit 1
}

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Read KEY=value lines without running them. Values may be wrapped in quotes.
load_env() {
	local file=$1 line key val n=0 mode
	[ -f "$file" ] || return 0
	mode=$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file" 2>/dev/null || echo 600)
	case "$mode" in *00) ;; *) echo "WARNING: $file can be read by other users (mode $mode); run: chmod 600 $file" >&2 ;; esac
	while IFS= read -r line || [ -n "$line" ]; do
		n=$((n + 1))
		line=${line%$'\r'}
		case "$line" in '' | '#'*) continue ;; esac
		line=${line#export }
		case "$line" in *=*) ;; *) die "$file line $n: expected KEY=value" ;; esac
		key=${line%%=*}
		val=${line#*=}
		case "$key" in '' | [0-9]* | *[!A-Z0-9_]*) die "$file line $n: bad setting name: $key" ;; esac
		case "$val" in
			\"*\") val=${val#\"} val=${val%\"} ;;
			\'*\') val=${val#\'} val=${val%\'} ;;
		esac
		# A value from the environment wins, but an empty one does not hide the file.
		[ -z "${!key:-}" ] || continue
		if [ "$key" = GH_TOKEN ]; then export "$key=$val"; else printf -v "$key" '%s' "$val"; fi
	done <"$file"
}
load_env "${SECURITY_ENV:-$HERE/security.env}"

: "${OWNER:=masumi-network}" # always the Masumi organisation; the variable only exists so tests can point elsewhere
: "${MAIL_SMTP_URL:=smtps://smtp.gmail.com:465}"
: "${MAIL_REQUIRE_TLS:=true}"
: "${PRIVATE_CODE_SCANNING:=false}" # set true only on a plan that includes code scanning for private repos
: "${WRITE_PAUSE:=1}"               # seconds to wait after a repo was changed, to stay under GitHub's rate limits
export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1

need() {
	local c
	for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "$c is not installed"; done
}

require() {
	local v missing=""
	for v in "$@"; do [ -n "${!v:-}" ] || missing="$missing $v"; done
	[ -z "$missing" ] || die "missing setting(s):$missing (set them in the environment or in security.env)"
}

# ---------- GitHub helpers ----------

errmsg() { # first useful line of a failed gh call
	local m
	m=$(printf '%s\n' "$1" | sed -n 's/^gh: //p' | head -1)
	[ -n "$m" ] || m=$(printf '%s\n' "$1" | head -1)
	printf '%s' "$m" | cut -c1-160
}

ERRMSG=""
write() { # method path [json body]; sets ERRMSG when it fails
	local out
	if [ $# -ge 3 ]; then
		out=$(printf '%s' "$3" | gh api -X "$1" "$2" --input - 2>&1)
	else
		out=$(gh api -X "$1" "$2" 2>&1)
	fi || {
		ERRMSG=$(errmsg "$out")
		return 1
	}
}

# One line per repository: name, private, admin. Archived repositories are left out.
list_repos() {
	local json
	json=$(gh repo list "$OWNER" --limit 1000 --json name,isPrivate,isArchived,viewerPermission 2>&1) ||
		die "cannot list the repositories of $OWNER: $(errmsg "$json")"
	printf '%s' "$json" | jq -r --arg only "${REPOS_ONLY:-}" --arg skip "${REPOS_EXCLUDE:-}" '
		def names($s): $s | split(",") | map(gsub("^\\s+|\\s+$"; "") | ascii_downcase) | map(select(length > 0));
		names($only) as $o | names($skip) as $x | map(.name | ascii_downcase) as $all |
		($o - $all) as $unknown | ($x - $all) as $unknownx |
		if ($unknown | length) > 0 then error("REPOS_ONLY names no repository you can see: " + ($unknown | join(", ")))
		elif ($unknownx | length) > 0 then error("REPOS_EXCLUDE names no repository you can see: " + ($unknownx | join(", ")))
		else .[] | select(.isArchived | not)
			| select(($o | length) == 0 or (.name | ascii_downcase) as $n | $o | any(. == $n))
			| select((.name | ascii_downcase) as $n | $x | any(. == $n) | not)
			| [.name, (.isPrivate | tostring), (.viewerPermission == "ADMIN" | tostring)] | @tsv
		end' 2>"$TMP/list.err" || die "$(sed 's/^jq: error[^)]*): //' "$TMP/list.err" | head -1)"
}

preflight_auth() {
	local out
	out=$(gh api user -q .login 2>&1) || die "the GitHub token does not work: $(errmsg "$out")"
	echo "GitHub token OK (acts as $out), owner: $OWNER" >&2
}

# ---------- setup ----------

APPLY=0 CHANGED=0 FAILED=0 WARNED=0 CELLS="" LENIENT=0

cell() { CELLS="$CELLS  $1"; }

# ensure LABEL CURRENT WANTED METHOD PATH [JSON]: change one setting when it is not as wanted
ensure() {
	local label=$1 current=$2 wanted=$3
	shift 3
	if [ "$current" = "$wanted" ]; then
		cell "$label=ok"
	elif [ "$APPLY" = 0 ]; then
		cell "$label=WOULD-ENABLE"
		CHANGED=$((CHANGED + 1))
	elif write "$@"; then
		cell "$label=ENABLED"
		CHANGED=$((CHANGED + 1))
	elif [ "$label" = codeql ] || { [ "$label" = secrets ] && [ "$LENIENT" = 1 ]; }; then
		cell "$label=WARN:$ERRMSG"
		WARNED=$((WARNED + 1))
	else
		cell "$label=FAILED:$ERRMSG"
		FAILED=$((FAILED + 1))
		return 1
	fi
}

setup_repo() { # name private admin
	local repo=$1 private=$2 admin=$3 alerts fixes sa codeql before=$CHANGED
	CELLS=""
	LENIENT=0
	[ "$private" = false ] || LENIENT=1 # private repos may lack the plan for secret scanning: a warning, not an error
	if [ "$admin" != true ]; then
		cell "FAILED:no admin access with this token"
		FAILED=$((FAILED + 1))
	else
		alerts=off
		gh api "repos/$OWNER/$repo/vulnerability-alerts" >/dev/null 2>&1 && alerts=on
		fixes=$(gh api "repos/$OWNER/$repo/automated-security-fixes" -q .enabled 2>/dev/null || true)
		[ "$fixes" = true ] && fixes=on || fixes=off
		# security updates need the alerts (and the dependency graph) first
		if ensure alerts "$alerts" on PUT "repos/$OWNER/$repo/vulnerability-alerts"; then
			ensure fixes "$fixes" on PUT "repos/$OWNER/$repo/automated-security-fixes" || true
		else
			cell "fixes=SKIPPED"
		fi
		if [ "$private" = false ] || [ "$PRIVATE_CODE_SCANNING" = true ]; then
			sa=$(gh api "repos/$OWNER/$repo" -q '[.security_and_analysis.secret_scanning.status, .security_and_analysis.secret_scanning_push_protection.status] | join(",")' 2>/dev/null || true)
			if [ "$sa" = "" ] || [ "$sa" = "," ]; then
				cell "secrets=WARN:cannot read the setting"
				WARNED=$((WARNED + 1))
			else
				ensure secrets "$sa" enabled,enabled PATCH "repos/$OWNER/$repo" \
					'{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}' || true
			fi
			codeql=$(gh api "repos/$OWNER/$repo/code-scanning/default-setup" -q .state 2>/dev/null || true)
			ensure codeql "${codeql:-unknown}" configured PATCH "repos/$OWNER/$repo/code-scanning/default-setup" '{"state":"configured"}' || true
		else
			cell "secrets=n/a(private)  codeql=n/a(private)"
		fi
	fi
	printf '%-42s %-8s%s\n' "$repo" "$([ "$private" = true ] && echo private || echo public)" "$CELLS"
	if [ "$APPLY" = 1 ] && [ "$CHANGED" != "$before" ]; then sleep "$WRITE_PAUSE"; fi
}

cmd_setup() {
	local repos repo private admin total=0
	case "${1:-}" in '') ;; --apply) APPLY=1 ;; *) die "unknown option: $1" ;; esac
	require GH_TOKEN OWNER
	preflight_auth
	repos=$(list_repos) || exit 1
	[ -n "$repos" ] || die "no repositories found for $OWNER"
	[ "$APPLY" = 1 ] || echo "DRY RUN: nothing is changed. Add --apply to make the changes." >&2
	# The list is read from descriptor 3, so a command inside the loop that reads stdin cannot eat it.
	while IFS=$'\t' read -r -u 3 repo private admin; do
		total=$((total + 1))
		setup_repo "$repo" "$private" "$admin"
	done 3<<<"$repos"
	echo
	echo "$total repositories: $CHANGED $([ "$APPLY" = 1 ] && echo changed || echo to change), $FAILED failed, $WARNED warning(s)"
	[ "$FAILED" = 0 ]
}

# ---------- report ----------

SEV_RANK='{"critical":0,"high":1,"error":1,"medium":2,"warning":2,"low":3,"note":3}'
RESULT="[]"

fetch() { # repo path: puts the open alerts in RESULT, or the reason in ERRMSG
	local out
	if out=$(gh api --paginate "repos/$OWNER/$1/$2?state=open&per_page=100" 2>&1); then
		RESULT=$(printf '%s' "$out" | jq -s 'add // []') || {
			ERRMSG="unreadable response"
			return 1
		}
	else
		ERRMSG=$(errmsg "$out")
		return 1
	fi
}

build_html() { # date scanned rows.jsonl notscanned.jsonl codeql-off
	jq -nr --arg date "$1" --arg owner "$OWNER" --argjson scanned "$2" --slurpfile rows "$3" \
		--slurpfile skipped "$4" --arg codeql "$5" --argjson rank "$SEV_RANK" '
		def e: tostring | @html;
		def color: if . == "critical" or . == "high" or . == "error" then "#b00020"
			elif . == "medium" or . == "warning" then "#b26a00" else "#444" end;
		def link: if ((.url // "") | startswith("https://github.com/")) then "<a href=\"\(.url | e)\">open</a>" else "-" end;
		($rows | sort_by([($rank[.severity] // 9), .repo, .pkg])) as $r |
		($r | map(select(.severity == "critical" or .severity == "high" or .severity == "error")) | length) as $ch |
		"<html><body style=\"font-family:sans-serif\">\n<h2>Security report \($date | e): \($owner | e)</h2>\n" +
		"<p><b>\($r | length)</b> open alerts, <b>\($ch)</b> critical or high, in \($scanned) scanned repositories.</p>\n" +
		(if ($skipped | length) > 0 then
			"<h3>Not scanned (\($skipped | length))</h3>\n<ul>\n" +
			($skipped | map("<li><b>\(.repo | e)</b> (\(.what | e)): \(.reason | e)</li>") | join("\n")) + "\n</ul>\n"
		else "" end) +
		(if $codeql != "" then "<p>Code scanning has no data for: \($codeql | e) (not enabled, or no scan has run yet).</p>\n" else "" end) +
		(if ($r | length) == 0 then "<p>No open alerts.</p>\n" else
			"<table border=\"1\" cellpadding=\"6\" cellspacing=\"0\" style=\"border-collapse:collapse;font-size:13px\">\n" +
			"<tr><th>Repo</th><th>Type</th><th>Severity</th><th>Package / rule</th><th>File</th><th>Issue</th><th>Fixed in</th><th>Link</th></tr>\n" +
			($r | map("<tr><td>\(.repo | e)</td><td>\(.kind | e)</td><td style=\"color:\(.severity | color);font-weight:bold\">\(.severity | e)</td><td>\(.pkg | e)</td><td>\(.manifest | e)</td><td>\(.issue | e)</td><td>\(.fixed | e)</td><td>\(. | link)</td></tr>") | join("\n")) +
			"\n</table>\n" end) +
		"</body></html>"'
}

recipients() { # MAIL_TO as one valid address per line
	local a re='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' n=0
	while IFS= read -r a; do
		a=$(printf '%s' "$a" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
		[ -n "$a" ] || continue
		[[ $a =~ $re ]] || die "MAIL_TO has an invalid address: $a"
		printf '%s\n' "$a"
		n=$((n + 1))
	done < <(printf '%s\n' "$MAIL_TO" | tr ',' '\n') # trailing newline: read skips an unterminated last line
	[ "$n" -gt 0 ] || die "MAIL_TO has no address"
}

check_mail_settings() {
	local re='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' from
	require MAIL_USER MAIL_PASSWORD MAIL_TO
	from=${MAIL_FROM:-$MAIL_USER}
	[[ $from =~ $re ]] || die "MAIL_FROM (or MAIL_USER) is not a plain email address: $from"
	recipients >/dev/null
}

send_mail() { # subject html-file
	local subject=$1 html=$2 from to_header="" r msg cfg pw
	local -a args
	from=${MAIL_FROM:-$MAIL_USER}
	msg="$TMP/message.eml"
	cfg="$TMP/curl.cfg"
	while IFS= read -r r; do to_header="${to_header:+$to_header, }$r"; done < <(recipients)
	{
		printf 'From: Security Report <%s>\n' "$from"
		printf 'To: %s\n' "$to_header"
		printf 'Subject: %s\n' "$subject"
		printf 'Date: %s\n' "$(LC_ALL=C date '+%a, %d %b %Y %H:%M:%S %z')"
		printf 'Message-ID: <%s.%s@security.sh>\n' "$(date +%s)" "$$"
		printf 'MIME-Version: 1.0\nContent-Type: text/html; charset=UTF-8\nContent-Transfer-Encoding: base64\n\n'
		base64 <"$html" | fold -w 76
	} | awk '{ printf "%s\r\n", $0 }' >"$msg"
	pw=${MAIL_PASSWORD//\\/\\\\}
	pw=${pw//\"/\\\"}
	printf 'user = "%s:%s"\n' "$MAIL_USER" "$pw" >"$cfg" # kept out of the process list
	args=(--silent --show-error --url "$MAIL_SMTP_URL" --mail-from "$from" --upload-file "$msg" --config "$cfg")
	while IFS= read -r r; do args+=(--mail-rcpt "$r"); done < <(recipients)
	[ "$MAIL_REQUIRE_TLS" = false ] || args+=(--ssl-reqd)
	curl "${args[@]}" || {
		rm -f "$cfg"
		die "the email was not sent (curl exit $?)"
	}
	rm -f "$cfg"
}

cmd_report() {
	local send=1 out="" repos repo private admin scanned=0 total=0 date subject n crit codeql_off="" dep_err=""
	while [ $# -gt 0 ]; do
		case "$1" in
			--no-mail) send=0 ;;
			--out)
				[ $# -ge 2 ] || die "--out needs a file name"
				out=$2
				shift
				;;
			*) die "unknown option: $1" ;;
		esac
		shift
	done
	require GH_TOKEN OWNER
	[ "$send" = 0 ] || check_mail_settings
	preflight_auth
	repos=$(list_repos) || exit 1
	[ -n "$repos" ] || die "no repositories found for $OWNER"
	: >"$TMP/rows.jsonl"
	: >"$TMP/skipped.jsonl"
	while IFS=$'\t' read -r -u 3 repo private admin; do
		total=$((total + 1))
		if fetch "$repo" dependabot/alerts; then
			scanned=$((scanned + 1))
			printf '%s' "$RESULT" | jq -c --arg repo "$repo" '.[] | {repo: $repo, kind: "Dependency",
				severity: (.security_advisory.severity // "unknown"),
				pkg: ((.dependency.package.ecosystem // "?") + ": " + (.dependency.package.name // "?")),
				manifest: (.dependency.manifest_path // "-"), issue: (.security_advisory.summary // "-"),
				fixed: (.security_vulnerability.first_patched_version.identifier // "no fix yet"), url: .html_url}' >>"$TMP/rows.jsonl"
		else
			dep_err=$ERRMSG
			jq -cn --arg repo "$repo" --arg reason "$ERRMSG" '{repo: $repo, what: "Dependabot", reason: $reason}' >>"$TMP/skipped.jsonl"
		fi
		if [ "$private" = false ] || [ "$PRIVATE_CODE_SCANNING" = true ]; then
			if fetch "$repo" code-scanning/alerts; then
				printf '%s' "$RESULT" | jq -c --arg repo "$repo" '.[] | {repo: $repo, kind: "Code",
					severity: (.rule.security_severity_level // .rule.severity // "unknown"),
					pkg: (.rule.id // "-"), manifest: ((.most_recent_instance.location.path // "-") + ":" + ((.most_recent_instance.location.start_line // 0) | tostring)),
					issue: (.rule.description // "-"), fixed: "-", url: .html_url}' >>"$TMP/rows.jsonl"
			else
				codeql_off="${codeql_off:+$codeql_off, }$repo ($ERRMSG)"
			fi
		fi
	done 3<<<"$repos"
	[ "$scanned" -gt 0 ] || die "no repository could be scanned (last error: $dep_err)"
	date=$(date -u +%Y-%m-%d)
	n=$(wc -l <"$TMP/rows.jsonl" | tr -d ' ')
	crit=$(jq -s '[.[] | select(.severity == "critical" or .severity == "high" or .severity == "error")] | length' "$TMP/rows.jsonl")
	subject="Security report $date: $n open ($crit critical/high) in $scanned repos"
	[ "$scanned" = "$total" ] || subject="$subject, $((total - scanned)) not scanned"
	build_html "$date" "$scanned" "$TMP/rows.jsonl" "$TMP/skipped.jsonl" "$codeql_off" >"$TMP/report.html"
	[ -z "$out" ] || cp "$TMP/report.html" "$out"
	echo "$subject"
	[ "$send" = 0 ] || send_mail "$subject" "$TMP/report.html"
	[ "$send" = 0 ] || echo "Email sent to $(recipients | tr '\n' ' ')"
	# The email went out first, so the gap is visible there; the exit code makes a scheduled job turn red.
	[ "$scanned" = "$total" ] || {
		echo "ERROR: $((total - scanned)) of $total repositories could not be scanned (listed in the report)" >&2
		return 1
	}
}

# ---------- check ----------

cmd_check() {
	local mail=0 ok=1 out login type repos total=0 admin_n=0 repo private admin scopes
	case "${1:-}" in '') ;; --mail) mail=1 ;; *) die "unknown option: $1" ;; esac
	need gh jq curl base64
	echo "PASS  gh, jq, curl and base64 are installed"
	require GH_TOKEN OWNER
	out=$(gh api user -q .login 2>&1) || die "the GitHub token does not work: $(errmsg "$out")"
	login=$out
	scopes=$(gh api -i user 2>/dev/null | tr -d '\r' | sed -n 's/^[Xx]-[Oo][Aa]uth-[Ss]copes: //p' | head -1)
	echo "PASS  token works, acts as $login (classic token scopes: ${scopes:-none shown; a fine-grained token}) "
	type=$(gh api "users/$OWNER" -q .type 2>&1) || die "owner $OWNER not found: $(errmsg "$type")"
	echo "PASS  owner $OWNER is a $type"
	repos=$(list_repos) || exit 1
	while IFS=$'\t' read -r -u 3 repo private admin; do
		[ -n "$repo" ] || continue
		total=$((total + 1))
		[ "$admin" = true ] && admin_n=$((admin_n + 1))
	done 3<<<"$repos"
	if [ "$total" = 0 ]; then
		echo "FAIL  no repositories in scope"
		ok=0
	else
		echo "PASS  $total repositories in scope (archived ones left out)"
	fi
	if [ "$total" = 0 ]; then
		:
	elif [ "$admin_n" = "$total" ]; then
		echo "PASS  admin access on all of them (needed by: setup --apply)"
	else
		echo "FAIL  admin access on only $admin_n of $total (setup --apply cannot change the rest; report still works)"
		ok=0
	fi
	if (check_mail_settings) 2>"$TMP/mail.err"; then
		echo "PASS  mail settings are complete (to: $(recipients | tr '\n' ' '))"
		if [ "$mail" = 1 ]; then
			printf '<html><body>Test message from security.sh.</body></html>\n' >"$TMP/test.html"
			send_mail "Security report: test message" "$TMP/test.html"
			echo "PASS  test email sent"
		fi
	else
		echo "FAIL  mail: $(sed 's/^ERROR: //' "$TMP/mail.err" | head -1) (only needed for: report)"
		ok=0
	fi
	[ "$ok" = 1 ]
}

usage() {
	if [ "${1:-2}" = 0 ]; then sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; else sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2; fi
	exit "${1:-2}"
}

main() {
	local cmd=${1:-}
	[ $# -eq 0 ] || shift
	case "$cmd" in
		check) need gh jq curl base64 && cmd_check "$@" ;;
		setup) need gh jq && cmd_setup "$@" ;;
		report) need gh jq curl base64 awk && cmd_report "$@" ;;
		-h | --help | help) usage 0 ;;
		*) usage ;;
	esac
}
main "$@"
