#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/.env}"
IMAGE="${IMAGE:-guical96/academico-login:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-academico-login}"

log() {
  printf '[academico-login] %s\n' "$*"
}

fail() {
  printf '[academico-login] ERROR: %s\n' "$*" >&2
  exit 1
}

sudo_cmd() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

install_docker_apt() {
  local distro_id id_like version_codename

  . /etc/os-release
  distro_id="${ID}"
  id_like="${ID_LIKE:-}"
  version_codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"

  case "${distro_id}" in
    ubuntu|debian)
      ;;
    *)
      if [[ " ${id_like} " == *" ubuntu "* ]]; then
        distro_id="ubuntu"
      elif [[ " ${id_like} " == *" debian "* ]]; then
        distro_id="debian"
      else
        fail "La instalacion automatica con apt solo esta soportada para distribuciones basadas en Debian/Ubuntu."
      fi
      ;;
  esac

  if [ -z "${version_codename}" ]; then
    fail "No se pudo detectar VERSION_CODENAME para configurar el repositorio de Docker."
  fi

  log "Instalando dependencias de Docker con apt..."
  sudo_cmd apt-get update
  sudo_cmd apt-get install -y ca-certificates curl gnupg

  sudo_cmd install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL "https://download.docker.com/linux/${distro_id}/gpg" \
      | sudo_cmd gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  fi
  sudo_cmd chmod a+r /etc/apt/keyrings/docker.gpg

  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "${distro_id}" "${version_codename}" \
    | sudo_cmd tee /etc/apt/sources.list.d/docker.list >/dev/null

  sudo_cmd apt-get update
  sudo_cmd apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker_dnf() {
  log "Instalando Docker con dnf..."
  sudo_cmd dnf install -y dnf-plugins-core
  sudo_cmd dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
  sudo_cmd dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker_yum() {
  log "Instalando Docker con yum..."
  sudo_cmd yum install -y yum-utils
  sudo_cmd yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  sudo_cmd yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker_if_missing() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker ya esta instalado."
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    install_docker_apt
  elif command -v dnf >/dev/null 2>&1; then
    install_docker_dnf
  elif command -v yum >/dev/null 2>&1; then
    install_docker_yum
  else
    fail "No se encontro un gestor de paquetes compatible para instalar Docker."
  fi
}

start_docker_service() {
  if docker info >/dev/null 2>&1; then
    return
  fi

  log "Iniciando servicio Docker..."
  if command -v systemctl >/dev/null 2>&1; then
    sudo_cmd systemctl enable --now docker || true
  else
    sudo_cmd service docker start || true
  fi
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    sudo docker "$@"
  fi
}

env_value() {
  local key="$1"
  if [ ! -f "${ENV_FILE}" ]; then
    return 0
  fi
  awk -F= -v key="${key}" '$1 == key { value = substr($0, index($0, "=") + 1); gsub(/\r$/, "", value); print value; exit }' "${ENV_FILE}"
}

validate_env_file() {
  local missing=()
  local required_vars=(
    PORT
    LOGIN_API_KEY
    JWT_SECRET
    JWT_DOC_SECRET
    DB_HOST
    DB_PORT
    DB_DATABASE
    DB_USER
    DB_PASSWORD
  )

  if [ ! -f "${ENV_FILE}" ]; then
    fail "No existe ${ENV_FILE}. Crea el archivo a partir de .env.example y completa las variables requeridas."
  fi

  for var_name in "${required_vars[@]}"; do
    if [ -z "$(env_value "${var_name}")" ]; then
      missing+=("${var_name}")
    fi
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    fail "Faltan variables requeridas en ${ENV_FILE}: ${missing[*]}"
  fi
}

pull_image() {
  log "Descargando imagen ${IMAGE}..."
  docker_cmd pull "${IMAGE}"
}

run_container() {
  local service_port host_port

  service_port="${CONTAINER_PORT:-$(env_value PORT)}"
  service_port="${service_port:-3001}"
  host_port="${HOST_PORT:-${service_port}}"

  if docker_cmd ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
    log "Eliminando contenedor existente ${CONTAINER_NAME}..."
    docker_cmd rm -f "${CONTAINER_NAME}" >/dev/null
  fi

  log "Levantando contenedor ${CONTAINER_NAME} en el puerto ${host_port}:${service_port}..."
  docker_cmd run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --env-file "${ENV_FILE}" \
    -e NODE_ENV=production \
    -p "${host_port}:${service_port}" \
    "${IMAGE}" >/dev/null

  log "Servicio iniciado. Contenedores activos:"
  docker_cmd ps --filter "name=${CONTAINER_NAME}"
}

main() {
  install_docker_if_missing
  start_docker_service
  validate_env_file
  pull_image
  run_container

  log "Logs recientes:"
  docker_cmd logs --tail 40 "${CONTAINER_NAME}" || true
}

main "$@"
