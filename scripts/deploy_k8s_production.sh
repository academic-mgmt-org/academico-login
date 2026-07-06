#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name"
    exit 1
  fi
}

validate_env_name() {
  local name="$1"
  if [[ ! "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Invalid environment variable name: $name"
    exit 1
  fi
}

validate_k8s_name() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
    echo "Invalid Kubernetes name for $name: $value"
    exit 1
  fi
}

validate_port_forward_address() {
  local address="$1"
  local bind_address=""
  local octet=""
  local -a bind_addresses=()
  local -a octets=()

  if [ -z "$address" ]; then
    echo "LOCAL_PORT_FORWARD_ADDRESS must be localhost, an IPv4 address, or a comma-separated list of them."
    exit 1
  fi

  IFS=, read -r -a bind_addresses <<< "$address"
  for bind_address in "${bind_addresses[@]}"; do
    if [ "$bind_address" = "localhost" ]; then
      continue
    fi

    if [[ ! "$bind_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      echo "LOCAL_PORT_FORWARD_ADDRESS must be localhost, an IPv4 address, or a comma-separated list of them: $address"
      exit 1
    fi

    IFS=. read -r -a octets <<< "$bind_address"
    for octet in "${octets[@]}"; do
      if (( 10#$octet > 255 )); then
        echo "LOCAL_PORT_FORWARD_ADDRESS must be localhost, an IPv4 address, or a comma-separated list of them: $address"
        exit 1
      fi
    done
  done
}

validate_safe_path() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^/[-A-Za-z0-9_./]+$ ]]; then
    echo "Invalid absolute path for $name: $value"
    exit 1
  fi
}

write_env_line() {
  local name="$1"
  local value="$2"

  if [[ "$value" == *$'\n'* ]]; then
    echo "Environment variable $name contains a newline and cannot be written to a Kubernetes env file."
    exit 1
  fi

  printf '%s=%s\n' "$name" "$value"
}

for name in \
  CONTAINER_REGISTRY \
  IMAGE_REPOSITORY \
  TAG \
  K8S_SSH_HOST \
  K8S_SSH_USER \
  K8S_SSH_PRIVATE_KEY_B64 \
  K8S_NAMESPACE \
  K8S_MANIFEST_DIR \
  K8S_REMOTE_MANIFEST_PATH \
  K8S_DEPLOYMENT \
  K8S_CONTAINER \
  IMAGE_PULL_SECRET_NAME \
  APP_SECRET_NAME \
  APP_PORT \
  ENV_VARIABLE_NAMES; do
  require_env "$name"
done

ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-5m}"
validate_k8s_name K8S_NAMESPACE "$K8S_NAMESPACE"
validate_k8s_name K8S_DEPLOYMENT "$K8S_DEPLOYMENT"
validate_k8s_name K8S_CONTAINER "$K8S_CONTAINER"
validate_k8s_name IMAGE_PULL_SECRET_NAME "$IMAGE_PULL_SECRET_NAME"
validate_k8s_name APP_SECRET_NAME "$APP_SECRET_NAME"
validate_safe_path K8S_REMOTE_MANIFEST_PATH "$K8S_REMOTE_MANIFEST_PATH"

if [[ ! "$APP_PORT" =~ ^[0-9]+$ ]]; then
  echo "APP_PORT must be numeric: $APP_PORT"
  exit 1
fi

if [[ ! "$ROLLOUT_TIMEOUT" =~ ^[0-9]+[smh]$ ]]; then
  echo "ROLLOUT_TIMEOUT must use kubectl duration syntax, for example 5m: $ROLLOUT_TIMEOUT"
  exit 1
fi

if [ ! -d "$K8S_MANIFEST_DIR" ]; then
  echo "Missing Kubernetes manifest directory: $K8S_MANIFEST_DIR"
  exit 1
fi

IMAGE="${CONTAINER_REGISTRY}/${IMAGE_REPOSITORY}:${TAG}"
if [[ ! "$IMAGE" =~ ^[A-Za-z0-9./:_-]+$ ]]; then
  echo "Invalid image reference: $IMAGE"
  exit 1
fi

DOCKER_CONFIG_FILE="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
if [ ! -f "$DOCKER_CONFIG_FILE" ]; then
  echo "Missing Docker config after ACR login: $DOCKER_CONFIG_FILE"
  exit 1
fi

SSH_DIR="$(mktemp -d)"
ENV_FILE_LOCAL="$(mktemp)"
SMOKE_FILE_LOCAL="$(mktemp)"
SMOKE_COMMAND_LOCAL="$(mktemp)"

cleanup() {
  rm -rf "$SSH_DIR" "$ENV_FILE_LOCAL" "$SMOKE_FILE_LOCAL" "$SMOKE_COMMAND_LOCAL"
}
trap cleanup EXIT

for name in $ENV_VARIABLE_NAMES; do
  validate_env_name "$name"
  require_env "$name"
done

umask 077
{
  write_env_line PORT "$APP_PORT"
  for name in $ENV_VARIABLE_NAMES; do
    write_env_line "$name" "${!name}"
  done
} > "$ENV_FILE_LOCAL"

POST_ROLLOUT_SMOKE_ENV_VARIABLE_NAMES="${POST_ROLLOUT_SMOKE_ENV_VARIABLE_NAMES:-}"
for name in $POST_ROLLOUT_SMOKE_ENV_VARIABLE_NAMES; do
  validate_env_name "$name"
  require_env "$name"
done

{
  write_env_line POST_ROLLOUT_SMOKE_ENABLED "${POST_ROLLOUT_SMOKE_ENABLED:-false}"
  write_env_line POST_ROLLOUT_SMOKE_BASE_URL "${POST_ROLLOUT_SMOKE_BASE_URL:-http://127.0.0.1:$APP_PORT}"
  write_env_line POST_ROLLOUT_SMOKE_RETRIES "${POST_ROLLOUT_SMOKE_RETRIES:-12}"
  write_env_line POST_ROLLOUT_SMOKE_SLEEP_SECONDS "${POST_ROLLOUT_SMOKE_SLEEP_SECONDS:-5}"
  write_env_line POST_ROLLOUT_SMOKE_TIMEOUT_SECONDS "${POST_ROLLOUT_SMOKE_TIMEOUT_SECONDS:-5}"
  write_env_line POST_ROLLOUT_SMOKE_ENV_VARIABLE_NAMES "$POST_ROLLOUT_SMOKE_ENV_VARIABLE_NAMES"
  for name in $POST_ROLLOUT_SMOKE_ENV_VARIABLE_NAMES; do
    write_env_line "$name" "${!name}"
  done
} > "$SMOKE_FILE_LOCAL"

printf '%s\n' "${POST_ROLLOUT_SMOKE_COMMAND:-}" > "$SMOKE_COMMAND_LOCAL"
LEGACY_DOCKER_CLEANUP_ENABLED="${LEGACY_DOCKER_CLEANUP_ENABLED:-false}"
LOCAL_PORT_FORWARD_ENABLED="${LOCAL_PORT_FORWARD_ENABLED:-false}"
LOCAL_PORT_FORWARD_ADDRESS="${LOCAL_PORT_FORWARD_ADDRESS:-}"

case "${LOCAL_PORT_FORWARD_ENABLED,,}" in
  1|true|yes|y|on|0|false|no|n|off|"") ;;
  *)
    echo "Invalid LOCAL_PORT_FORWARD_ENABLED: $LOCAL_PORT_FORWARD_ENABLED"
    exit 1
    ;;
esac

if [ -n "$LOCAL_PORT_FORWARD_ADDRESS" ]; then
  validate_port_forward_address "$LOCAL_PORT_FORWARD_ADDRESS"
fi

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
printf '%s' "$K8S_SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_DIR/key"
chmod 600 "$SSH_DIR/key"
ssh-keyscan -T 10 "$K8S_SSH_HOST" > "$SSH_DIR/known_hosts"

SSH_OPTS=(
  -i "$SSH_DIR/key"
  -o IdentitiesOnly=yes
  -o UserKnownHostsFile="$SSH_DIR/known_hosts"
  -o StrictHostKeyChecking=yes
)
REMOTE="${K8S_SSH_USER}@${K8S_SSH_HOST}"

REMOTE_TMP_DIR="$(
  ssh "${SSH_OPTS[@]}" "$REMOTE" "mktemp -d"
)"

echo "Copying Kubernetes manifests to $K8S_SSH_HOST..."
ssh "${SSH_OPTS[@]}" "$REMOTE" "rm -rf '$K8S_REMOTE_MANIFEST_PATH' && mkdir -p '$K8S_REMOTE_MANIFEST_PATH'"
scp "${SSH_OPTS[@]}" "$K8S_MANIFEST_DIR"/*.yml "$REMOTE:$K8S_REMOTE_MANIFEST_PATH/"

echo "Copying deployment secrets to $K8S_SSH_HOST..."
scp "${SSH_OPTS[@]}" "$ENV_FILE_LOCAL" "$REMOTE:$REMOTE_TMP_DIR/app.env"
scp "${SSH_OPTS[@]}" "$SMOKE_FILE_LOCAL" "$REMOTE:$REMOTE_TMP_DIR/smoke.env"
scp "${SSH_OPTS[@]}" "$SMOKE_COMMAND_LOCAL" "$REMOTE:$REMOTE_TMP_DIR/smoke.sh"
scp "${SSH_OPTS[@]}" "$DOCKER_CONFIG_FILE" "$REMOTE:$REMOTE_TMP_DIR/dockerconfigjson"

echo "Applying production Kubernetes deployment..."
ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "K8S_NAMESPACE='$K8S_NAMESPACE' \
   K8S_REMOTE_MANIFEST_PATH='$K8S_REMOTE_MANIFEST_PATH' \
   K8S_DEPLOYMENT='$K8S_DEPLOYMENT' \
   K8S_CONTAINER='$K8S_CONTAINER' \
   IMAGE_PULL_SECRET_NAME='$IMAGE_PULL_SECRET_NAME' \
   APP_SECRET_NAME='$APP_SECRET_NAME' \
   ROLLOUT_TIMEOUT='$ROLLOUT_TIMEOUT' \
   IMAGE='$IMAGE' \
   LEGACY_DOCKER_CLEANUP_ENABLED='$LEGACY_DOCKER_CLEANUP_ENABLED' \
   LOCAL_PORT_FORWARD_ENABLED='$LOCAL_PORT_FORWARD_ENABLED' \
   LOCAL_PORT_FORWARD_ADDRESS='$LOCAL_PORT_FORWARD_ADDRESS' \
   REMOTE_TMP_DIR='$REMOTE_TMP_DIR' \
   bash -se" << 'REMOTE_SCRIPT'
set -euo pipefail

cleanup() {
  rm -rf "$REMOTE_TMP_DIR"
}
trap cleanup EXIT

read_env_value() {
  local file="$1"
  local name="$2"

  awk -v key="$name" '
    index($0, key "=") == 1 {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$file"
}

validate_port_forward_address() {
  local address="$1"
  local bind_address=""
  local octet=""
  local -a bind_addresses=()
  local -a octets=()

  if [ -z "$address" ]; then
    echo "LOCAL_PORT_FORWARD_ADDRESS must be localhost, an IPv4 address, or a comma-separated list of them."
    exit 1
  fi

  IFS=, read -r -a bind_addresses <<< "$address"
  for bind_address in "${bind_addresses[@]}"; do
    if [ "$bind_address" = "localhost" ]; then
      continue
    fi

    if [[ ! "$bind_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      echo "LOCAL_PORT_FORWARD_ADDRESS must be localhost, an IPv4 address, or a comma-separated list of them: $address"
      exit 1
    fi

    IFS=. read -r -a octets <<< "$bind_address"
    for octet in "${octets[@]}"; do
      if (( 10#$octet > 255 )); then
        echo "LOCAL_PORT_FORWARD_ADDRESS must be localhost, an IPv4 address, or a comma-separated list of them: $address"
        exit 1
      fi
    done
  done
}

resolve_default_port_forward_address() {
  local address=""

  address="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "src") {
          print $(i + 1)
          exit
        }
      }
    }
  ' || true)"

  if [ -z "$address" ]; then
    address="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [ -z "$address" ]; then
    printf '%s' "127.0.0.1"
    return
  fi

  if [ "$address" = "127.0.0.1" ]; then
    printf '%s' "$address"
  else
    printf '127.0.0.1,%s' "$address"
  fi
}

is_enabled() {
  case "${1,,}" in
    1|true|yes|y|on) return 0 ;;
    0|false|no|n|off|"") return 1 ;;
    *)
      echo "Invalid boolean value: $1"
      exit 1
      ;;
  esac
}

export_env_file() {
  local file="$1"
  local line=""
  local name=""
  local value=""

  while IFS= read -r line || [ -n "$line" ]; do
    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      continue
    fi

    name="${line%%=*}"
    value="${line#*=}"
    export "$name=$value"
  done < "$file"
}

resolve_post_rollout_smoke_base_url() {
  local app_port=""
  local base_url=""
  local service_ip=""

  app_port="$(read_env_value "$REMOTE_TMP_DIR/app.env" PORT)"
  base_url="${POST_ROLLOUT_SMOKE_BASE_URL:-}"

  if is_enabled "${LOCAL_PORT_FORWARD_ENABLED:-false}"; then
    return
  fi

  case "$base_url" in
    "http://127.0.0.1:$app_port"|"http://localhost:$app_port")
      service_ip="$(kubectl -n "$K8S_NAMESPACE" get service "$K8S_DEPLOYMENT" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
      if [ -n "$service_ip" ] && [ "$service_ip" != "None" ]; then
        export POST_ROLLOUT_SMOKE_BASE_URL="http://$service_ip:$app_port"
        echo "Resolved post-rollout smoke base URL to Kubernetes service $K8S_DEPLOYMENT at $POST_ROLLOUT_SMOKE_BASE_URL."
      fi
      ;;
  esac
}

cleanup_legacy_docker_containers() {
  local enabled="${LEGACY_DOCKER_CLEANUP_ENABLED:-false}"
  local image_repo=""
  local container_id=""
  local container_image=""
  local container_name=""
  local container_ports=""
  local docker_cmd=()
  local ids=()

  if ! is_enabled "$enabled"; then
    echo "Legacy Docker container cleanup disabled."
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed; skipping legacy container cleanup."
    return
  fi

  if docker info >/dev/null 2>&1; then
    docker_cmd=(docker)
  elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    docker_cmd=(sudo -n docker)
  else
    echo "Docker is not accessible; skipping legacy container cleanup."
    return
  fi

  image_repo="${IMAGE%:*}"
  while IFS='|' read -r container_id container_image container_name container_ports; do
    if [ -z "$container_id" ]; then
      continue
    fi

    if [ "$container_name" = "$K8S_DEPLOYMENT" ] || [[ "$container_image" == "$image_repo:"* ]]; then
      ids+=("$container_id")
      echo "Marked legacy Docker container for removal: $container_name ($container_image, ports: ${container_ports:-none})."
    fi
  done < <("${docker_cmd[@]}" ps -a --format '{{.ID}}|{{.Image}}|{{.Names}}|{{.Ports}}')

  if [ "${#ids[@]}" -eq 0 ]; then
    echo "No legacy Docker containers matched $K8S_DEPLOYMENT or $image_repo:*."
    return
  fi

  "${docker_cmd[@]}" rm -f "${ids[@]}"
  echo "Removed ${#ids[@]} legacy Docker container(s)."
}

ensure_local_port_forward() {
  local enabled="${LOCAL_PORT_FORWARD_ENABLED:-false}"
  local address="${LOCAL_PORT_FORWARD_ADDRESS:-}"
  local app_port=""
  local service_port=""
  local kubectl_path=""
  local user_name=""
  local home_dir=""
  local kubeconfig_line=""
  local unit_name=""
  local unit_path=""
  local forward_script_path=""
  local endpoint_ref=""

  if ! is_enabled "$enabled"; then
    echo "Local Kubernetes port-forward disabled."
    return
  fi

  if [ -z "$address" ]; then
    address="$(resolve_default_port_forward_address)"
  fi
  validate_port_forward_address "$address"

  app_port="$(read_env_value "$REMOTE_TMP_DIR/app.env" PORT)"
  if [[ ! "$app_port" =~ ^[0-9]+$ ]]; then
    echo "Cannot configure local port-forward because PORT is not numeric: $app_port"
    exit 1
  fi

  service_port="$(kubectl -n "$K8S_NAMESPACE" get service "$K8S_DEPLOYMENT" -o jsonpath='{.spec.ports[?(@.name=="grpc")].port}' 2>/dev/null || true)"
  if [ -z "$service_port" ]; then
    service_port="$(kubectl -n "$K8S_NAMESPACE" get service "$K8S_DEPLOYMENT" -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || true)"
  fi
  if [ "$service_port" != "$app_port" ]; then
    echo "Cannot configure local port-forward: service $K8S_NAMESPACE/$K8S_DEPLOYMENT exposes port ${service_port:-unknown}, expected $app_port."
    exit 1
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl is required to persist local port-forward."
    exit 1
  fi
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo "Passwordless sudo is required to persist local port-forward."
    exit 1
  fi

  kubectl_path="$(command -v kubectl || true)"
  if [ -z "$kubectl_path" ]; then
    echo "kubectl is required to persist local port-forward."
    exit 1
  fi

  user_name="$(id -un)"
  home_dir="$(getent passwd "$user_name" | cut -d: -f6)"
  if [ -z "$home_dir" ]; then
    home_dir="$HOME"
  fi
  if [ -f "$home_dir/.kube/config" ]; then
    kubeconfig_line="Environment=KUBECONFIG=$home_dir/.kube/config"
  fi

  unit_name="academico-${K8S_NAMESPACE}-${K8S_DEPLOYMENT}-${app_port}-port-forward.service"
  unit_path="/etc/systemd/system/$unit_name"
  forward_script_path="$home_dir/.local/bin/$unit_name.sh"
  endpoint_ref="endpoints/$K8S_DEPLOYMENT"

  mkdir -p "$(dirname "$forward_script_path")"
  cat > "$forward_script_path" <<'FORWARD_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

pod=""
for _ in $(seq 1 30); do
  pod="$(
    "$KUBECTL_PATH" -n "$K8S_NAMESPACE" get endpoints "$K8S_DEPLOYMENT" \
      -o jsonpath='{.subsets[0].addresses[0].targetRef.name}' 2>/dev/null || true
  )"

  if [ -n "$pod" ]; then
    break
  fi

  sleep 1
done

if [ -z "$pod" ]; then
  echo "No ready endpoint found for $K8S_NAMESPACE/$K8S_DEPLOYMENT." >&2
  exit 1
fi

exec "$KUBECTL_PATH" -n "$K8S_NAMESPACE" port-forward \
  --address "$PORT_FORWARD_ADDRESS" \
  "pod/$pod" \
  "$APP_PORT:$APP_PORT"
FORWARD_SCRIPT
  chmod 700 "$forward_script_path"

  sudo tee "$unit_path" >/dev/null <<UNIT
[Unit]
Description=Local Kubernetes port-forward for $K8S_NAMESPACE/$K8S_DEPLOYMENT on $address:$app_port
After=network-online.target k3s.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$user_name
WorkingDirectory=$home_dir
Environment=HOME=$home_dir
$kubeconfig_line
Environment=KUBECTL_PATH=$kubectl_path
Environment=K8S_NAMESPACE=$K8S_NAMESPACE
Environment=K8S_DEPLOYMENT=$K8S_DEPLOYMENT
Environment=PORT_FORWARD_ADDRESS=$address
Environment=APP_PORT=$app_port
ExecStart=$forward_script_path
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload
  sudo systemctl enable "$unit_name" >/dev/null
  sudo systemctl restart "$unit_name"
  sleep 2

  if ! systemctl is-active --quiet "$unit_name"; then
    echo "Local port-forward service failed: $unit_name"
    sudo systemctl status "$unit_name" --no-pager || true
    exit 1
  fi

  echo "Local Kubernetes port-forward active on $address:$app_port for $K8S_NAMESPACE/$endpoint_ref."
}

run_post_rollout_smoke_test() {
  local enabled=""
  local retries=""
  local sleep_seconds=""
  local attempt=""

  enabled="$(read_env_value "$REMOTE_TMP_DIR/smoke.env" POST_ROLLOUT_SMOKE_ENABLED)"
  if ! is_enabled "$enabled"; then
    echo "Post-rollout smoke test disabled."
    return
  fi

  if [ ! -s "$REMOTE_TMP_DIR/smoke.sh" ]; then
    echo "POST_ROLLOUT_SMOKE_COMMAND is required when post-rollout smoke test is enabled."
    exit 1
  fi

  retries="$(read_env_value "$REMOTE_TMP_DIR/smoke.env" POST_ROLLOUT_SMOKE_RETRIES)"
  sleep_seconds="$(read_env_value "$REMOTE_TMP_DIR/smoke.env" POST_ROLLOUT_SMOKE_SLEEP_SECONDS)"

  retries="${retries:-12}"
  sleep_seconds="${sleep_seconds:-5}"
  export_env_file "$REMOTE_TMP_DIR/app.env"
  export_env_file "$REMOTE_TMP_DIR/smoke.env"
  resolve_post_rollout_smoke_base_url

  echo "Running post-rollout smoke test..."
  for attempt in $(seq 1 "$retries"); do
    if bash "$REMOTE_TMP_DIR/smoke.sh"; then
      echo "Post-rollout smoke test passed."
      return
    fi

    echo "Post-rollout smoke test attempt $attempt/$retries failed."
    sleep "$sleep_seconds"
  done

  echo "Post-rollout smoke test failed after $retries attempts."
  exit 1
}

kubectl apply -f "$K8S_REMOTE_MANIFEST_PATH/namespace.yml"

kubectl -n "$K8S_NAMESPACE" create secret generic "$APP_SECRET_NAME" \
  --from-env-file="$REMOTE_TMP_DIR/app.env" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

kubectl -n "$K8S_NAMESPACE" create secret generic "$IMAGE_PULL_SECRET_NAME" \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson="$REMOTE_TMP_DIR/dockerconfigjson" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

if [ -f "$K8S_REMOTE_MANIFEST_PATH/deployment.yml" ]; then
  kubectl set image --local \
    -f "$K8S_REMOTE_MANIFEST_PATH/deployment.yml" \
    "$K8S_CONTAINER=$IMAGE" \
    -o yaml > "$REMOTE_TMP_DIR/deployment.yml"
  mv "$REMOTE_TMP_DIR/deployment.yml" "$K8S_REMOTE_MANIFEST_PATH/deployment.yml"
fi

kubectl apply -f "$K8S_REMOTE_MANIFEST_PATH"
kubectl -n "$K8S_NAMESPACE" set image "deployment/$K8S_DEPLOYMENT" "$K8S_CONTAINER=$IMAGE"
kubectl -n "$K8S_NAMESPACE" rollout status "deployment/$K8S_DEPLOYMENT" --timeout="$ROLLOUT_TIMEOUT"
kubectl -n "$K8S_NAMESPACE" get deployment,service,hpa,pdb -l app.kubernetes.io/name="$K8S_DEPLOYMENT" -o wide
cleanup_legacy_docker_containers
ensure_local_port_forward
run_post_rollout_smoke_test
REMOTE_SCRIPT

echo "Production Kubernetes deployment completed."
