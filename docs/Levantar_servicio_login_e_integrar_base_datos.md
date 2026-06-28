# Prueba local de integracion: base de datos + servicio de login

Este documento contiene primero los comandos usados para validar localmente la integracion entre:

- base de datos PostgreSQL levantada desde `/home/azureuser/academico-esquema-bd`;
- servicio `academico-login` levantado desde `/home/azureuser/academico-login`;
- Docker Compose en ambos repositorios;
- conexion SSL entre login y PostgreSQL;
- endpoints REST principales del servicio de login.

## 1. Comandos exactos usados en la prueba local

### 1.1. Guardar el `.env` original del login

```bash
cd /home/azureuser/academico-login
cp -p .env /tmp/academico-login.env.before-local-test
```

### 1.2. Configurar temporalmente el `.env` local del login

Durante la prueba se reemplazo temporalmente `/home/azureuser/academico-login/.env` por estos valores:

```env
PORT=3001
NODE_ENV=production
LOGIN_API_KEY=local-login-api-key
JWT_SECRET=local-jwt-secret
JWT_DOC_SECRET=local-jwt-secret
JWT_ACCESS_TTL=2h
JWT_REFRESH_TTL=7d
DB_HOST=academic-postgres-db
DB_PORT=5432
DB_DATABASE=academic_management_db
DB_USER=academic_user
DB_PASSWORD=academic_password
```

Comando equivalente para escribir ese archivo:

```bash
cd /home/azureuser/academico-login
cat > .env <<'EOF'
PORT=3001
NODE_ENV=production
LOGIN_API_KEY=local-login-api-key
JWT_SECRET=local-jwt-secret
JWT_DOC_SECRET=local-jwt-secret
JWT_ACCESS_TTL=2h
JWT_REFRESH_TTL=7d
DB_HOST=academic-postgres-db
DB_PORT=5432
DB_DATABASE=academic_management_db
DB_USER=academic_user
DB_PASSWORD=academic_password
EOF
```

### 1.3. Levantar la base local desde `academico-esquema-bd`

```bash
cd /home/azureuser/academico-esquema-bd
docker compose up -d --build
```

### 1.4. Verificar que PostgreSQL tenga SSL activo

```bash
cd /home/azureuser/academico-esquema-bd

set -e
for i in $(seq 1 60); do
  if docker exec academic-postgres-db pg_isready -U academic_user -d academic_management_db >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" = "60" ]; then
    docker logs academic-postgres-db
    exit 1
  fi
done

docker exec academic-postgres-db \
  psql -U academic_user -d academic_management_db -Atc "SHOW ssl;"
```

Resultado esperado:

```text
on
```

### 1.5. Aplicar migraciones `V2` en adelante del esquema academico

Este paso deja `academico.usuarios` y `academico.roles` con las columnas esperadas por `academico-login`.

Advertencia: `V2__simplificar_esquema.sql` elimina y recrea tablas. Usar solo en base local de pruebas o en una base que se pueda reinicializar.

```bash
cd /home/azureuser/academico-esquema-bd

docker run --rm \
  --network academico-esquema-bd_default \
  -v "$PWD":/work \
  -w /work \
  -e PGPASSWORD=academic_password \
  -e PGSSLMODE=require \
  postgres:15-alpine \
  sh -lc '
    for file in $(find migrations -name "V*__*.sql" | sort -V); do
      case "$file" in
        */V1__*) continue ;;
      esac
      echo "Aplicando $file"
      psql -v ON_ERROR_STOP=1 \
        -h academic-postgres-db \
        -p 5432 \
        -U academic_user \
        -d academic_management_db \
        -f "$file"
    done
  '
```

### 1.6. Si el contenedor de base desaparece, recrearlo

Durante la prueba el volumen quedo disponible, pero el contenedor no estaba presente al validar. Se recreo con:

```bash
cd /home/azureuser/academico-esquema-bd
docker compose up -d --build
```

### 1.7. Verificar columnas y tablas requeridas por login

```bash
docker exec academic-postgres-db \
  psql -U academic_user -d academic_management_db -Atc \
  "SELECT column_name FROM information_schema.columns WHERE table_schema='academico' AND table_name='usuarios' ORDER BY ordinal_position;"
```

Columnas esperadas, entre otras:

```text
id
rol_id
nombres
apellidos
email
password_hash
identificacion
estado
```

Verificar tablas principales:

```bash
docker exec academic-postgres-db \
  psql -U academic_user -d academic_management_db -Atc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='academico' AND table_name IN ('usuarios','roles','auth_sessions') ORDER BY table_name;"
```

Antes del bootstrap del login deben existir al menos:

```text
roles
usuarios
```

### 1.8. Ejecutar bootstrap del login contra la base local

```bash
cd /home/azureuser/academico-login

docker run --rm \
  --network academico-esquema-bd_default \
  -v "$PWD":/work \
  -w /work \
  -e PGPASSWORD=academic_password \
  -e PGSSLMODE=require \
  postgres:15-alpine \
  psql -v ON_ERROR_STOP=1 \
    -h academic-postgres-db \
    -p 5432 \
    -U academic_user \
    -d academic_management_db \
    -f database/scripts/bootstrap_login_schema.sql
```

Este script crea o actualiza:

- `academico.auth_sessions`;
- indices usados por login;
- roles base;
- usuarios de prueba.

Usuarios de prueba creados:

| Usuario | Password | Rol |
| --- | --- | --- |
| `estudiante@demo.com` | `password123` | `estudiante` |
| `docente@demo.com` | `password123` | `docente` |
| `administrador@demo.com` | `admin123` | `administrador` |

### 1.9. Verificar bootstrap del login

```bash
docker exec academic-postgres-db \
  psql -U academic_user -d academic_management_db -Atc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='academico' AND table_name IN ('usuarios','roles','auth_sessions') ORDER BY table_name;"
```

Resultado esperado:

```text
auth_sessions
roles
usuarios
```

Verificar usuarios:

```bash
docker exec academic-postgres-db \
  psql -U academic_user -d academic_management_db -Atc \
  "SELECT u.email || '|' || r.nombre || '|' || u.estado FROM academico.usuarios u JOIN academico.roles r ON r.id = u.rol_id ORDER BY u.email;"
```

Resultado esperado:

```text
administrador@demo.com|administrador|activo
docente@demo.com|docente|activo
estudiante@demo.com|estudiante|activo
```

### 1.10. Levantar `academico-login`

```bash
cd /home/azureuser/academico-login
docker compose up -d --build
```

Si existe un contenedor previo con el mismo nombre y Docker devuelve conflicto:

```bash
docker rm -f academico-login
cd /home/azureuser/academico-login
docker compose up -d --build
```

### 1.11. Conectar `academico-login` a la red de la base local

```bash
cd /home/azureuser/academico-login

docker network connect academico-esquema-bd_default academico-login 2>/dev/null || true
```

Verificar redes del contenedor:

```bash
docker inspect academico-login \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

Resultado esperado:

```text
academico-esquema-bd_default academico-login_default
```

Verificar que el contenedor tenga el `DB_HOST` local:

```bash
docker exec academico-login sh -lc 'printf "%s\n" "$DB_HOST"'
```

Resultado esperado:

```text
academic-postgres-db
```

### 1.12. Verificar logs de arranque del login

```bash
docker logs --tail 80 academico-login
```

En la prueba se verifico que el servicio mapeara estas rutas:

```text
/api/health
/api/ready
/api/live
/api/v1/auth/login
/api/v1/auth/refresh
/api/v1/auth/logout
/api/v1/auth/validate-token
/api/v1/auth/validate-token-2
/api/v1/whitelist/all
```

### 1.13. Probar endpoints REST con HTTP/2 h2c

El servicio Fastify esta levantado con `http2: true`, por lo que las pruebas REST se hicieron con:

```bash
curl --http2-prior-knowledge
```

Comando completo de validacion usado:

```bash
cd /home/azureuser/academico-login

set -euo pipefail
BASE_URL=http://localhost:3001
API_KEY=local-login-api-key
CURL_HTTP2=(curl --http2-prior-knowledge -sS)
failures=0

call() {
  local response status body
  response=$("${CURL_HTTP2[@]}" -w '\n%{http_code}' "$@")
  status=${response##*$'\n'}
  body=${response%$'\n'*}
  printf '%s\n%s' "$status" "$body"
}

json_field() {
  local field="$1"
  node -e "const fs=require('fs'); const body=fs.readFileSync(0,'utf8'); const parsed=JSON.parse(body); const value=parsed['$field']; if (value === undefined || value === null) process.exit(2); if (typeof value === 'object') process.stdout.write(JSON.stringify(value)); else process.stdout.write(String(value));"
}

expect_status() {
  local name="$1" expected="$2" status="$3" detail="${4:-}"
  if [ "$status" = "$expected" ]; then
    printf 'PASS %-32s status=%s %s\n' "$name" "$status" "$detail"
  else
    printf 'FAIL %-32s expected=%s got=%s %s\n' "$name" "$expected" "$status" "$detail"
    failures=$((failures + 1))
  fi
}

response=$(call "$BASE_URL/api/health")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
health_status=$(printf '%s' "$body" | json_field status)
expect_status health 200 "$status" "status=$health_status"

response=$(call "$BASE_URL/api/ready")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
ready=$(printf '%s' "$body" | json_field ready)
expect_status ready 200 "$status" "ready=$ready"

response=$(call "$BASE_URL/api/live")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
alive=$(printf '%s' "$body" | json_field alive)
expect_status live 200 "$status" "alive=$alive"

response=$(call -H "x-api-key: $API_KEY" "$BASE_URL/api/v1/whitelist/all")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
whitelist_count=$(printf '%s' "$body" | node -e "const fs=require('fs'); const parsed=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(String(parsed.length));")
expect_status whitelist 200 "$status" "routes=$whitelist_count"

response=$(call "$BASE_URL/api/v1/whitelist/all")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
error_code=$(printf '%s' "$body" | json_field error)
expect_status whitelist_without_api_key 401 "$status" "error=$error_code"

response=$(call -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d '{"username":"estudiante@demo.com","password":"password123"}')
login_status=$(printf '%s' "$response" | sed -n '1p')
login_body=$(printf '%s' "$response" | sed '1d')
access_token=$(printf '%s' "$login_body" | json_field accessToken)
refresh_token=$(printf '%s' "$login_body" | json_field refreshToken)
session_id=$(printf '%s' "$login_body" | json_field sessionId)
expires_in=$(printf '%s' "$login_body" | json_field expiresIn)
expect_status login 200 "$login_status" "session=$session_id expiresIn=$expires_in"

response=$(call -X POST "$BASE_URL/api/v1/auth/validate-token" \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d "{\"token\":\"$access_token\"}")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
is_valid=$(printf '%s' "$body" | json_field isValid)
expect_status validate_token 200 "$status" "isValid=$is_valid"
[ "$is_valid" = "true" ] || failures=$((failures + 1))

response=$(call -X POST "$BASE_URL/api/v1/auth/validate-token-2" \
  -H "x-api-key: $API_KEY" \
  -H "Authorization: Bearer $access_token")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
is_valid=$(printf '%s' "$body" | json_field isValid)
role=$(printf '%s' "$body" | json_field role)
expect_status validate_token_2 200 "$status" "isValid=$is_valid role=$role"
[ "$is_valid" = "true" ] || failures=$((failures + 1))

response=$(call -X POST "$BASE_URL/api/v1/auth/refresh" \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d "{\"refreshToken\":\"$refresh_token\"}")
refresh_status=$(printf '%s' "$response" | sed -n '1p')
refresh_body=$(printf '%s' "$response" | sed '1d')
new_access_token=$(printf '%s' "$refresh_body" | json_field accessToken)
refresh_session_id=$(printf '%s' "$refresh_body" | json_field sessionId)
expect_status refresh 200 "$refresh_status" "session=$refresh_session_id"
[ "$refresh_session_id" = "$session_id" ] || failures=$((failures + 1))

response=$(call -X POST "$BASE_URL/api/v1/auth/logout" \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d "{\"refreshToken\":\"$refresh_token\"}")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
success=$(printf '%s' "$body" | json_field success)
revoked=$(printf '%s' "$body" | json_field revoked)
expect_status logout 200 "$status" "success=$success revoked=$revoked"
[ "$success" = "true" ] && [ "$revoked" = "true" ] || failures=$((failures + 1))

response=$(call -X POST "$BASE_URL/api/v1/auth/validate-token-2" \
  -H "x-api-key: $API_KEY" \
  -H "Authorization: Bearer $new_access_token")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
is_valid_after_logout=$(printf '%s' "$body" | json_field isValid)
expect_status validate_after_logout 200 "$status" "isValid=$is_valid_after_logout"
[ "$is_valid_after_logout" = "false" ] || failures=$((failures + 1))

response=$(call -X POST "$BASE_URL/api/v1/auth/refresh" \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d "{\"refreshToken\":\"$refresh_token\"}")
status=$(printf '%s' "$response" | sed -n '1p')
body=$(printf '%s' "$response" | sed '1d')
refresh_error=$(printf '%s' "$body" | json_field error)
expect_status refresh_after_logout 401 "$status" "error=$refresh_error"

db_session=$(docker exec academic-postgres-db psql -U academic_user -d academic_management_db -Atc "SELECT email || '|' || CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END FROM academico.auth_sessions WHERE session_id = '$session_id';")
printf 'PASS %-32s %s\n' db_session "$db_session"
case "$db_session" in
  estudiante@demo.com\|revoked) ;;
  *) failures=$((failures + 1)) ;;
esac

if [ "$failures" -ne 0 ]; then
  printf 'FAILURES=%s\n' "$failures"
  exit 1
fi
printf 'ALL_REST_ENDPOINT_CHECKS_PASSED\n'
```

Resultado obtenido en la prueba:

```text
PASS health                           status=200 status=healthy
PASS ready                            status=200 ready=true
PASS live                             status=200 alive=true
PASS whitelist                        status=200 routes=2
PASS whitelist_without_api_key        status=401 error=Unauthorized
PASS login                            status=200 session=SESSION-... expiresIn=7200
PASS validate_token                   status=200 isValid=true
PASS validate_token_2                 status=200 isValid=true role=ESTUDIANTE
PASS refresh                          status=200 session=SESSION-...
PASS logout                           status=200 success=true revoked=true
PASS validate_after_logout            status=200 isValid=false
PASS refresh_after_logout             status=401 error=Unauthorized
PASS db_session                       estudiante@demo.com|revoked
ALL_REST_ENDPOINT_CHECKS_PASSED
```

### 1.14. Limpiar contenedores e imagenes creadas para la prueba

```bash
set -e

cd /home/azureuser/academico-login
docker compose down

cd /home/azureuser/academico-esquema-bd
docker compose down

docker rmi academico-login:latest academico-postgres-ssl:15-alpine postgres:15-alpine || true

dangling=$(docker images -f dangling=true -q | sort -u)
if [ -n "$dangling" ]; then
  docker rmi $dangling || true
fi

docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | sort
```

### 1.15. Restaurar el `.env` original del login

```bash
cd /home/azureuser/academico-login
cp -p /tmp/academico-login.env.before-local-test .env
rm -f /tmp/academico-login.env.before-local-test
```

## 2. Ajustes necesarios encontrados durante la prueba

Durante la prueba se encontraron dos problemas que debieron corregirse para que el flujo funcionara completo.

### 2.1. Filtro global de excepciones con Fastify

El servicio usa Fastify. El filtro global intentaba responder con:

```js
response.status(status).send(errorResponse);
```

Eso es estilo Express. En Fastify corresponde usar:

```js
response.code(status).send(errorResponse);
```

Se ajusto [src/filters/http-exception.filter.js](/home/azureuser/academico-login/src/filters/http-exception.filter.js) para soportar ambos casos.

### 2.2. Bootstrap compatible con `academico-esquema-bd`

El script [database/scripts/bootstrap_login_schema.sql](/home/azureuser/academico-login/database/scripts/bootstrap_login_schema.sql) usaba `updated_at` en el `ON CONFLICT`. El esquema simplificado de `academico-esquema-bd` usa `actualizado_en`, por lo que se elimino esa asignacion del conflicto para hacerlo compatible.

## 3. Valores locales usados en `.env`

Cuando `academico-login` corre dentro de Docker y la base viene de `/home/azureuser/academico-esquema-bd`, usar:

```env
PORT=3001
NODE_ENV=production
LOGIN_API_KEY=local-login-api-key
JWT_SECRET=local-jwt-secret
JWT_DOC_SECRET=local-jwt-secret
JWT_ACCESS_TTL=2h
JWT_REFRESH_TTL=7d
DB_HOST=academic-postgres-db
DB_PORT=5432
DB_DATABASE=academic_management_db
DB_USER=academic_user
DB_PASSWORD=academic_password
```

Si `academico-login` corre directamente en el host, `DB_HOST` debe ser `localhost`. Si corre en Docker, `DB_HOST` debe ser `academic-postgres-db` y el contenedor debe estar conectado a la red `academico-esquema-bd_default`.

## 4. Comandos rapidos para una nueva prueba local

Esta es la version corta del flujo completo.

```bash
cd /home/azureuser/academico-login
cp -p .env /tmp/academico-login.env.before-local-test
cat > .env <<'EOF'
PORT=3001
NODE_ENV=production
LOGIN_API_KEY=local-login-api-key
JWT_SECRET=local-jwt-secret
JWT_DOC_SECRET=local-jwt-secret
JWT_ACCESS_TTL=2h
JWT_REFRESH_TTL=7d
DB_HOST=academic-postgres-db
DB_PORT=5432
DB_DATABASE=academic_management_db
DB_USER=academic_user
DB_PASSWORD=academic_password
EOF

cd /home/azureuser/academico-esquema-bd
docker compose up -d --build

docker run --rm \
  --network academico-esquema-bd_default \
  -v "$PWD":/work \
  -w /work \
  -e PGPASSWORD=academic_password \
  -e PGSSLMODE=require \
  postgres:15-alpine \
  sh -lc '
    for file in $(find migrations -name "V*__*.sql" | sort -V); do
      case "$file" in
        */V1__*) continue ;;
      esac
      psql -v ON_ERROR_STOP=1 -h academic-postgres-db -p 5432 -U academic_user -d academic_management_db -f "$file"
    done
  '

cd /home/azureuser/academico-login
docker run --rm \
  --network academico-esquema-bd_default \
  -v "$PWD":/work \
  -w /work \
  -e PGPASSWORD=academic_password \
  -e PGSSLMODE=require \
  postgres:15-alpine \
  psql -v ON_ERROR_STOP=1 -h academic-postgres-db -p 5432 -U academic_user -d academic_management_db -f database/scripts/bootstrap_login_schema.sql

docker compose up -d --build
docker network connect academico-esquema-bd_default academico-login 2>/dev/null || true
```

Probar login:

```bash
curl --http2-prior-knowledge -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "x-api-key: local-login-api-key" \
  -d '{
    "username": "estudiante@demo.com",
    "password": "password123"
  }'
```

Limpiar:

```bash
cd /home/azureuser/academico-login
docker compose down

cd /home/azureuser/academico-esquema-bd
docker compose down

docker rmi academico-login:latest academico-postgres-ssl:15-alpine postgres:15-alpine || true

cd /home/azureuser/academico-login
cp -p /tmp/academico-login.env.before-local-test .env
rm -f /tmp/academico-login.env.before-local-test
```
