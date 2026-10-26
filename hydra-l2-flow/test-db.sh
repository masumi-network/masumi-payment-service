#!/usr/bin/env bash

# Sourced by the Hydra test harnesses. Inspect only; never remove a reused DB.
assert_test_db_loopback_binding(){
  local container="$1" expected_port="$2" loopback_host=127.0.0.1
  local inspection network_mode bindings host_ip host_port extra
  local is_safe=1
  if ! inspection="$(docker inspect --format '{{.HostConfig.NetworkMode}}{{"\n"}}{{range (index .HostConfig.PortBindings "5432/tcp")}}{{printf "%s %s\n" .HostIp .HostPort}}{{end}}' "$container" 2>/dev/null)"; then
    is_safe=0
  elif [[ "$inspection" != *$'\n'* ]]; then
    # No published PostgreSQL binding was reported.
    is_safe=0
  else
    network_mode="${inspection%%$'\n'*}"
    bindings="${inspection#*$'\n'}"
    case "$network_mode" in ''|host|container:*) is_safe=0 ;; esac
    while read -r host_ip host_port extra; do
      if [[ "$host_ip" != "$loopback_host" || "$host_port" != "$expected_port" || -n "$extra" ]]; then
        is_safe=0
        break
      fi
    done <<< "$bindings"
  fi
  [[ "$is_safe" = 1 ]] && return 0
  printf 'Refusing test database container %s: PostgreSQL must publish only %s:%s.\n' \
    "$container" "$loopback_host" "$expected_port" >&2
  printf 'Back up its data, then stop and recreate it with -p %s:%s:5432. The harness leaves this container unchanged.\n' \
    "$loopback_host" "$expected_port" >&2
  return 1
}
