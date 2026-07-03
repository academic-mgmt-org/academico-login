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

cleanup() {
  rm -rf "$SSH_DIR" "$ENV_FILE_LOCAL"
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
   REMOTE_TMP_DIR='$REMOTE_TMP_DIR' \
   bash -se" << 'REMOTE_SCRIPT'
set -euo pipefail

CORDONED_BURST_NODES=""

uncordon_burst_nodes() {
  local node
  for node in $CORDONED_BURST_NODES; do
    kubectl uncordon "$node" >/dev/null 2>&1 || true
  done
}

cleanup() {
  uncordon_burst_nodes
  rm -rf "$REMOTE_TMP_DIR"
}
trap cleanup EXIT

cordon_burst_nodes_for_single_replica_rollout() {
  local current_replicas="0"
  local node

  current_replicas="$(
    kubectl -n "$K8S_NAMESPACE" get deployment "$K8S_DEPLOYMENT" \
      -o jsonpath='{.status.replicas}' 2>/dev/null || true
  )"
  current_replicas="${current_replicas:-0}"

  if [ "$current_replicas" -gt 1 ]; then
    return
  fi

  for node in $(kubectl get nodes -l academico.utn.edu.ec/login-placement=burst -o name 2>/dev/null || true); do
    kubectl cordon "$node"
    CORDONED_BURST_NODES="$CORDONED_BURST_NODES $node"
  done
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

cordon_burst_nodes_for_single_replica_rollout
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
uncordon_burst_nodes
kubectl -n "$K8S_NAMESPACE" get deployment,service,hpa,pdb -l app.kubernetes.io/name="$K8S_DEPLOYMENT" -o wide
REMOTE_SCRIPT

echo "Production Kubernetes deployment completed."
