#!/usr/bin/env bash
# Runs the webapp against the Kubernetes backend through SSH tunnels.
#
#   ./backend_server.sh             build, tunnel, wait for /health, serve on :3001
#   ./backend_server.sh --stop      stop the server and every tunnel started here
#   ./backend_server.sh --tunnel    just the backend API tunnel (use with `npm run dev`)
#   ./backend_server.sh --monitoring  just Grafana + Prometheus
#
# Local ports, all on 127.0.0.1 unless APP_HOST says otherwise:
#   3001  web app          3002  Grafana          3003  Prometheus       8001  backend API
#
# Why the tunnels are supervised: `kubectl port-forward` exits on any API-server
# hiccup, pod restart or idle reset. It is the remote command of the ssh session,
# so its death used to take the whole tunnel down and leave the running web app
# proxying to a closed port - ECONNREFUSED until someone noticed. Both layers now
# restart themselves: a `while` loop on the remote side for port-forward, and a
# `while` loop here for the ssh connection.
#
# Two ports, one owner: the remote ports are a shared resource on the dev host, so a
# forward never fights for one. Locally, a supervisor that is already running the same
# `-L` forward is adopted instead of duplicated; remotely, an existing listener on the
# port is reused instead of bound over. Doing neither is what filled .run/tunnel.log
# with tens of thousands of "address already in use" retries: the loop reconnected
# every two seconds forever while the traffic quietly flowed through whichever
# unsupervised forward had won the race.
set -uo pipefail

SSH_TARGET="${SSH_TARGET:-projgrup@172.20.2.204}"
NAMESPACE="${NAMESPACE:-devops-system}"
SERVICE="${SERVICE:-svc/devops-api}"
SERVICE_PORT="${SERVICE_PORT:-8000}"
REMOTE_PORT="${REMOTE_PORT:-18000}"   # port-forward listener on the remote host
LOCAL_PORT="${LOCAL_PORT:-8001}"      # 8000 is taken by the local WSL k3s forward
APP_HOST="${APP_HOST:-0.0.0.0}"
APP_PORT="${APP_PORT:-3001}"
BACKEND_URL="http://127.0.0.1:${LOCAL_PORT}"

# Monitoring is deployed by kube-prometheus-stack and is ClusterIP-only, so it is
# reached the same way as the API: a supervised port-forward per service.
MONITORING_NAMESPACE="${MONITORING_NAMESPACE:-monitoring}"
GRAFANA_SERVICE="${GRAFANA_SERVICE:-svc/monitoring-grafana}"
GRAFANA_SERVICE_PORT="${GRAFANA_SERVICE_PORT:-80}"
GRAFANA_PORT="${GRAFANA_PORT:-3002}"
GRAFANA_REMOTE_PORT="${GRAFANA_REMOTE_PORT:-13002}"
PROMETHEUS_SERVICE="${PROMETHEUS_SERVICE:-svc/monitoring-kube-prometheus-prometheus}"
PROMETHEUS_SERVICE_PORT="${PROMETHEUS_SERVICE_PORT:-9090}"
PROMETHEUS_PORT="${PROMETHEUS_PORT:-3003}"
PROMETHEUS_REMOTE_PORT="${PROMETHEUS_REMOTE_PORT:-13003}"

cd "$(dirname "$0")"
mkdir -p .run
TUNNEL_PID_FILE=.run/tunnel.pid
APP_PID_FILE=.run/app.pid
TUNNEL_LOG=.run/tunnel.log
APP_LOG=.run/app.log

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

port_busy() {
  # `ss` is present on WSL/Ubuntu; fall back to bash's own /dev/tcp probe.
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

stop_from_pid_file() {
  local file=$1 name=$2 pid
  [ -f "$file" ] || return 0
  pid=$(cat "$file")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "stopping $name (pid $pid)"
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
  fi
  rm -f "$file"
}

# The `-L` spec is unique per forward, so it identifies a supervisor even when the pid
# file has been overwritten. That is the failure this guards against: a second supervisor
# for the same forward orphans the first, which then loops forever losing the race for the
# remote port - reconnecting every two seconds and hammering the remote sshd until
# unrelated ssh and git operations start timing out.
# A pgrep ERE, not a literal: the supervisor's command line spells the forward as
# -L "127.0.0.1:.." (the quotes are part of the script text it was started with) while
# its ssh child spells it bare, so the quote has to be optional or half the processes
# are missed. The dots are escaped so they cannot match anything else.
forward_signature() {
  printf -- '-L "?127\\.0\\.0\\.1:%s:127\\.0\\.0\\.1:%s' "$1" "$2"
}

# Every local process carrying this forward: the supervisor and its ssh child alike.
# The `--` matters: the pattern starts with `-L`, which pgrep would otherwise read as
# its own options and then match nothing at all.
forward_pids() { pgrep -f -- "$(forward_signature "$1" "$2")" 2>/dev/null; }

# Only the supervisor loops. Matching the `-L` spec alone is not enough: it also hits the
# ssh child, and a pid file naming the child is useless because killing ssh just makes
# the loop reconnect a moment later. The fifo template appears in the supervisor's
# command line and nowhere else, so it tells the two apart - and keeps an unrelated shell
# that merely mentions the ports from being mistaken for a tunnel.
supervisor_pids() {
  local pid
  while read -r pid; do
    [ -n "$pid" ] || continue
    case "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" in
      *mlm-tunnel*) printf '%s\n' "$pid" ;;
    esac
  done < <(forward_pids "$1" "$2")
  return 0
}

stop_forward_orphans() {
  local local_port=$1 remote_port=$2 pids
  pids=$(forward_pids "$local_port" "$remote_port")
  [ -z "$pids" ] && return 0
  log "sweeping orphaned tunnel processes for 127.0.0.1:${local_port}: $(echo "$pids" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  return 0
}

# The supervisor loops append forever; a night of reconnect churn should not fill the disk.
trim_log() {
  local file=$1 max=${2:-5242880}
  [ -f "$file" ] || return 0
  if [ "$(wc -c <"$file")" -gt "$max" ]; then
    tail -c 262144 "$file" > "$file.trimmed" && mv "$file.trimmed" "$file"
    log "trimmed $file (kept the last 256 KiB)"
  fi
}

stop_all() {
  stop_from_pid_file "$APP_PID_FILE" "web app"
  stop_from_pid_file "$TUNNEL_PID_FILE" "backend tunnel"
  stop_from_pid_file .run/grafana.pid "Grafana tunnel"
  stop_from_pid_file .run/prometheus.pid "Prometheus tunnel"
  # Backstop: a pid file only ever names the newest supervisor, so sweep by signature too.
  stop_forward_orphans "$LOCAL_PORT" "$REMOTE_PORT"
  stop_forward_orphans "$GRAFANA_PORT" "$GRAFANA_REMOTE_PORT"
  stop_forward_orphans "$PROMETHEUS_PORT" "$PROMETHEUS_REMOTE_PORT"
}

# remote_script <namespace> <service> <remote-port> <service-port>
#
# The remote half of one forward. Emitted as a script and shipped base64-encoded (see
# start_forward) so neither this file's quoting nor the remote shell's re-parsing can
# mangle it.
remote_script() {
  local ns=$1 service=$2 remote_port=$3 service_port=$4
  cat <<REMOTE
# Kill our own port-forward and exit as soon as the ssh session goes away. ssh hands
# this script the session's stdin, so EOF means the tunnel is gone. Without this,
# sshd leaves kubectl running as an orphan that still holds 127.0.0.1:${remote_port},
# and every later reconnect then fails to bind that port for as long as it lives.
pf=
cleanup() { [ -n "\$pf" ] && kill "\$pf" 2>/dev/null; exit 0; }
trap cleanup TERM INT HUP
# fd 8 is not optional: a non-interactive shell points an asynchronous command's stdin
# at /dev/null unless an explicit redirection says otherwise, so a bare \`cat &\` here
# would read EOF instantly and tear the tunnel down a second after it came up. An
# explicit \`<&8\` overrides that default and gives the watchdog the real ssh channel.
exec 8<&0
( cat <&8 >/dev/null; kill -TERM \$\$ 2>/dev/null ) &

served() { ss -ltn "sport = :${remote_port}" 2>/dev/null | grep -q LISTEN; }

# Someone else may already own this port. This host keeps a hand-written pf-keeper.sh
# permanently on 18000, and racing it can never succeed - that race is what produced
# the endless "address already in use" reconnect storm in .run/tunnel.log. So ride
# along: the ssh -L forward is happy to use the listener that is already there.
if served; then
  echo "remote 127.0.0.1:${remote_port} is already served by another process; reusing it" >&2
  # Take over only once it has been gone three checks running. A keeper restarting its
  # own kubectl leaves the port free for a moment, and grabbing it in that window would
  # only invert the storm onto them.
  gone=0
  while [ "\$gone" -lt 3 ]; do
    if served; then gone=0; else gone=\$((gone + 1)); fi
    sleep 3
  done
  echo "remote listener on ${remote_port} went away; taking over" >&2
fi

while true; do
  kubectl port-forward -n ${ns} --address 127.0.0.1 ${service} ${remote_port}:${service_port} &
  pf=\$!
  wait "\$pf"
  echo "port-forward exited (\$?), retrying in 2s" >&2
  sleep 2
done
REMOTE
}

# start_forward <label> <pid-file> <local-port> <remote-port> <namespace> <service> <service-port>
#
# One supervised local:remote:service chain, used for the backend API and for each
# monitoring service. Both layers self-heal, as described at the top of this file.
start_forward() {
  local label=$1 pid_file=$2 local_port=$3 remote_port=$4 ns=$5 service=$6 service_port=$7 existing remote_b64
  trim_log "$TUNNEL_LOG"
  # Adopt a supervisor that is already running this exact forward, whatever the pid file
  # says. Starting a second one is what produced the reconnect storm.
  existing=$(supervisor_pids "$local_port" "$remote_port" | head -n 1)
  if [ -n "$existing" ]; then
    echo "$existing" > "$pid_file"
    log "${label} already supervised (pid ${existing}) on 127.0.0.1:${local_port}"
    return 0
  fi
  if port_busy "$local_port"; then
    log "ERROR: 127.0.0.1:${local_port} is already in use by something else."
    log "       Run './backend_server.sh --stop', or point ${label} at a free port."
    return 1
  fi

  log "starting supervised tunnel 127.0.0.1:${local_port} -> ${SSH_TARGET} -> ${service}:${service_port} (${label})"
  remote_b64=$(remote_script "$ns" "$service" "$remote_port" "$service_port" | base64 -w0)
  # setsid: survives this shell, and gives the loop its own process group so
  # --stop can take down ssh and the loop together.
  #
  # fd 9 is load-bearing. It gives ssh a stdin that never reaches EOF while this
  # supervisor lives and closes the instant it dies, which is exactly the signal the
  # remote script waits on to kill its own port-forward. A fifo opened read-write never
  # reports EOF, and unlinking it immediately keeps it out of everyone's way.
  # It has to be an fd rather than `sleep infinity | ssh`: in a pipeline bash waits for
  # every member, so once ssh exited the loop would block on the sleep forever and never
  # reconnect - the tunnel would stay down instead of healing.
  setsid bash -c '
    echo $$ > "'"$pid_file"'"
    fifo=$(mktemp -u "${TMPDIR:-/tmp}/mlm-tunnel.XXXXXX")
    mkfifo "$fifo" && exec 9<>"$fifo" && rm -f "$fifo"
    while true; do
      ssh -T <&9 \
        -o ExitOnForwardFailure=yes \
        -o ServerAliveInterval=15 \
        -o ServerAliveCountMax=3 \
        -o TCPKeepAlive=yes \
        -L "127.0.0.1:'"$local_port"':127.0.0.1:'"$remote_port"'" \
        "'"$SSH_TARGET"'" \
        "eval \"\$(printf %s '"$remote_b64"' | base64 -d)\""
      echo "ssh tunnel exited ($?), reconnecting in 3s" >&2
      sleep 3
    done
  ' >>"$TUNNEL_LOG" 2>&1 &
  # The loop records its own pid above; wait for the file so --stop always works.
  for _ in 1 2 3 4 5; do [ -s "$pid_file" ] && break; sleep 0.2; done
}

start_tunnel() {
  start_forward "backend API" "$TUNNEL_PID_FILE" "$LOCAL_PORT" "$REMOTE_PORT" \
    "$NAMESPACE" "$SERVICE" "$SERVICE_PORT"
}

# Monitoring is a convenience, not a dependency: a failed forward is reported and the
# web app still starts.
start_monitoring() {
  start_forward "Grafana" .run/grafana.pid "$GRAFANA_PORT" "$GRAFANA_REMOTE_PORT" \
    "$MONITORING_NAMESPACE" "$GRAFANA_SERVICE" "$GRAFANA_SERVICE_PORT" ||
    log "WARNING: Grafana is not reachable on :${GRAFANA_PORT}"
  start_forward "Prometheus" .run/prometheus.pid "$PROMETHEUS_PORT" "$PROMETHEUS_REMOTE_PORT" \
    "$MONITORING_NAMESPACE" "$PROMETHEUS_SERVICE" "$PROMETHEUS_SERVICE_PORT" ||
    log "WARNING: Prometheus is not reachable on :${PROMETHEUS_PORT}"
}

wait_for_backend() {
  local attempt
  log "waiting for ${BACKEND_URL}/health"
  for attempt in $(seq 1 60); do
    if curl -fsS -m 3 "${BACKEND_URL}/health" >/dev/null 2>&1; then
      log "backend is up"
      return 0
    fi
    sleep 2
  done
  log "ERROR: no /health response after 120s. Last tunnel output:"
  tail -n 20 "$TUNNEL_LOG" 2>/dev/null
  log "Check: ssh ${SSH_TARGET} 'kubectl get pods -n ${NAMESPACE}'"
  return 1
}

case "${1:-}" in
  --stop)
    stop_all
    exit 0
    ;;
  --tunnel)
    start_tunnel || exit 1
    wait_for_backend || exit 1
    log "tunnel ready. Point the app at it with:"
    log "  MLMANAGE_API_URL=${BACKEND_URL} npm run dev -- -p ${APP_PORT}"
    exit 0
    ;;
  --monitoring)
    start_monitoring
    log "Grafana:    http://127.0.0.1:${GRAFANA_PORT}"
    log "Prometheus: http://127.0.0.1:${PROMETHEUS_PORT}"
    exit 0
    ;;
esac

start_tunnel || exit 1
start_monitoring

log "building"
if ! npm run build; then
  log "ERROR: build failed; leaving the tunnel up for retries"
  exit 1
fi

wait_for_backend || exit 1

# The backend URL is passed in the environment, which takes precedence over
# .env.local, so nothing has to rewrite a file to switch backends.
stop_from_pid_file "$APP_PID_FILE" "previous web app"
if port_busy "$APP_PORT"; then
  log "ERROR: port ${APP_PORT} is held by a process this script did not start"
  log "       (likely a server left over from an earlier run). Free it with:"
  log "         pkill -f next-server        # or kill the pid shown below"
  ss -ltnp "sport = :${APP_PORT}" 2>/dev/null | tail -n +2
  exit 1
fi
log "serving on http://${APP_HOST}:${APP_PORT} against ${BACKEND_URL}"
setsid bash -c '
  echo $$ > "'"$APP_PID_FILE"'"
  exec env MLMANAGE_API_URL="'"$BACKEND_URL"'" npm run start -- -H "'"$APP_HOST"'" -p "'"$APP_PORT"'"
' >>"$APP_LOG" 2>&1 &
for _ in 1 2 3 4 5; do [ -s "$APP_PID_FILE" ] && break; sleep 0.2; done

sleep 3
if ! kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null; then
  log "ERROR: the web app exited immediately. Last output:"
  tail -n 20 "$APP_LOG"
  exit 1
fi

log "ready. Logs: $APP_LOG and $TUNNEL_LOG"
log "  web app:    http://127.0.0.1:${APP_PORT}"
log "  Grafana:    http://127.0.0.1:${GRAFANA_PORT}"
log "  Prometheus: http://127.0.0.1:${PROMETHEUS_PORT}"
log "stop everything with: ./backend_server.sh --stop"
