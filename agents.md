# AGENTS.md - Miniatur Cloud IaaS

## 1. Project Overview

- Name: Miniatur Cloud IaaS
- Description: Mini cloud platform on Jetson Nano that simulates IaaS instance lifecycle like AWS EC2
- Goal: Let users create, manage, and SSH into lightweight container-based instances
- Target users: Lecturer/students for Komputasi Awan practicum and demo users
- Version: v0.1.0
- Status: Backend operational, web console upgrade in progress

---

## 2. Tech Stack

### Web Console (`/html`)

- Language: HTML + CSS + Vanilla JavaScript
- Runtime: Static file served by Nginx
- API Access: All requests must use `/api/` prefix when accessed through gateway

### Backend API (`/iaas-api`)

- Language: Python 3.10
- Framework: FastAPI
- ORM: SQLAlchemy
- Database: SQLite (`/app/iaas.db` inside `iaas-api` container)
- Auth: JWT bearer token (60-minute expiry)
- Container orchestration: Docker Engine

### Infrastructure (`/docker-compose.yml`)

- Gateway: Nginx (`cloud-gateway`, port `80`)
- Storage: MinIO (`cloud-storage`, ports `9000/9001`)
- Database: PostgreSQL 15 (`cloud-db`, port `5432`)
- Cache: Redis 7 (`cloud-cache`, port `6379`)
- Metrics: Prometheus (`cloud-metrics`, port `9090`)
- Dashboard: Grafana (`cloud-dashboard`, port `3000`)
- Logs: Loki (`cloud-logs`, port `3100`)
- Core API: FastAPI (`iaas-api`, port `8000`)

---

## 3. Commands

### API Testing

```bash
# Get JWT token (Jetson: use python3.10, never python3)
TOKEN=$(curl -s -X POST http://localhost:8000/auth/token \
  -d 'username=admin&password=admin123' \
  | python3.10 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# List instances
curl -s http://localhost:8000/instances \
  -H "Authorization: Bearer $TOKEN" | python3.10 -m json.tool
```

### Container Management

```bash
# View all containers
docker ps

# Stop all instance containers (safe: excludes iaas-api)
docker ps -q --filter "label=iaas.instance_id" | xargs -r docker stop

# Remove all instance containers
docker ps -aq --filter "label=iaas.instance_id" | xargs -r docker rm
```

### Service Management

```bash
# Rebuild and restart iaas-api
cd ~/miniatur-cloud
docker compose build iaas-api && docker compose up -d iaas-api
docker logs iaas-api -f

# Reload nginx after console changes
docker exec cloud-gateway nginx -s reload
```

---

## 4. Project Structure

```
miniatur-cloud/
├── agents.md
├── docker-compose.yml
├── .github/
│   └── workflows/
│       └── deploy.yml
├── iaas-api/
│   ├── main.py
│   ├── compute.py
│   ├── models.py
│   ├── requirements.txt
│   └── Dockerfile
├── html/
│   └── index.html
├── nginx/
│   └── nginx.conf
└── prometheus/
    └── prometheus.yml
```

Placement rules:

- New API route: `iaas-api/main.py` (or split module if agreed)
- Docker lifecycle logic: `iaas-api/compute.py`
- Data models: `iaas-api/models.py`
- Web console changes: `html/index.html` (or small static asset set only)
- Gateway/proxy changes: `nginx/nginx.conf`
- Do not create new top-level folders without confirmation

---

## 5. Naming Conventions

```
# Python
- Files: snake_case
- Classes: PascalCase
- Functions: snake_case
- Variables: snake_case
- Constants: UPPER_SNAKE_CASE

# API
- Resource endpoints: plural nouns (/instances, /catalog/images)
- Action endpoints: explicit action body (/instances/{id}/action)

# Containers
- Instance container name: iaas-<first-8-char-uuid>
- Required label: iaas.instance_id
```

---

## 6. Code Conventions

```
# General
- Prefer readability over cleverness
- Keep functions focused on one responsibility
- Extract repeated logic

# Python/FastAPI
- Use explicit exception handling, never bare except
- Return correct HTTP status codes
- Keep auth checks consistent for protected endpoints
- Avoid leaking internal stack traces or engine details in responses

# Frontend (Static JS)
- Use /api/ prefix for all backend calls through Nginx
- Always handle loading and error states in UI actions
- Never hardcode secrets in HTML/JS
```

---

## 7. Web Console Rules

```
# Core requirements
- Login page posting to /api/auth/token
- Dashboard showing host metrics and instance summary
- Instance management (create/start/stop/terminate)
- Show ssh_command and ssh_password after instance is ready
- Admin-only user management panel
- Monitoring tab (Grafana iframe or API-based charts)

# Technical constraints
- Keep console static (single HTML file or small static set)
- No additional Node.js backend
- Calls through gateway must use /api/ prefix
```

---

## 8. API Design Rules

```
# Base URLs
- Direct API: http://192.168.1.2:8000
- Via gateway: http://192.168.1.2/api/

# Auth endpoints
- POST /auth/token
- POST /auth/register
- GET /auth/me

# Instance endpoints
- GET /instances
- POST /instances
- GET /instances/{id}
- POST /instances/{id}/action
- POST /instances/{id}/exec

# Monitoring endpoints
- GET /monitoring/host
- GET /monitoring/summary

# Catalog endpoints
- GET /catalog/images
- GET /catalog/instance-types
```

Instance lifecycle states:

- `pending -> running -> stopped -> terminated`
- `error` is allowed for failed provisioning paths

---

## 9. Instance Orchestration Rules

```
# Provisioning flow
1. Create DB record with pending status
2. Find next available SSH port (start at 2201)
3. Generate random SSH password
4. Create Docker container with resource limits on cloud-net
5. Configure SSH inside container
6. Persist container_id, ip_address, ssh_port, ssh_password
7. Update status to running

# Critical filtering rule
- NEVER filter instance containers by name prefix iaas-
- ALWAYS filter by label: --filter "label=iaas.instance_id"
```

---

## 10. Data and Storage Rules

```
# API persistence
- Primary app DB used by FastAPI runtime is SQLite at /app/iaas.db inside container
- SQLAlchemy models: User, Instance, Volume

# Object storage
- MinIO available for S3-compatible object storage use cases
- Access through /storage/ and /storage-console/ routed by Nginx
```

---

## 11. Security Rules

```
# Never do this
- Never hardcode secrets into source files
- Never expose JWTs, passwords, or internal credentials in logs/UI
- Never leave protected endpoints without bearer auth
- Never run instance-wide destructive docker commands without filters

# Known credentials (lab only, keep private)
- API admin: admin / admin123
- MinIO: admin / CloudPass2024!
- Grafana: admin / admin123
- PostgreSQL: clouduser / CloudPass2024!
```

---

## 12. Git Rules

```
# Workflow
- Edit locally
- Push to main
- GitHub Actions deploy.yml triggers remote pull on Jetson

# Branching recommendation
- Prefer feature branches + PR for non-trivial changes
- Keep one logical change per commit

# Safety
- Never commit private credentials or environment secrets
```

---

## 13. Current Priorities

```
# Priority 1
- Upgrade web console into AWS-like experience
- Complete login, dashboard, instance lifecycle controls, SSH info, monitoring tab

# Priority 2
- Improve Grafana dashboard
- Add Prometheus datasource and container CPU/RAM/network panels
```

---

## 13.A Current API Snapshot

| Endpoint | Method | Auth | Notes |
| --- | --- | --- | --- |
| `/health` | GET | No | Health check |
| `/auth/token` | POST | No | Login via OAuth2PasswordRequestForm |
| `/auth/register` | POST | No | Register user |
| `/auth/me` | GET | Bearer | Current user |
| `/instances` | GET | Bearer | User instances (admin sees all) |
| `/instances` | POST | Bearer | Create instance (async, starts as `pending`) |
| `/instances/{id}` | GET | Bearer | Instance detail incl. SSH info |
| `/instances/{id}/action` | POST | Bearer | `start`, `stop`, `terminate` |
| `/instances/{id}/exec` | POST | Bearer | Execute command in container |
| `/monitoring/host` | GET | Bearer | Host CPU/RAM/disk |
| `/monitoring/summary` | GET | Bearer | User/instance summary |
| `/catalog/images` | GET | No | Image catalog |
| `/catalog/instance-types` | GET | No | Flavor catalog |

---

## 14. Testing

```
# Priority tests
1. Instance create/start/stop/terminate end-to-end
2. Container filtering safety with label iaas.instance_id
3. Auth-protected route access
4. Monitoring endpoint correctness
5. Web console API path correctness (/api/* via gateway)
```

---

## 15. Do Not

If a request is ambiguous, clarify before risky changes.

```
- Do not use python3 on Jetson for project scripts (system is 3.6.9)
- Do not use docker-compose (hyphen); use docker compose
- Do not filter containers by iaas- name prefix
- Do not run destructive docker/sql commands without strict targeting
- Do not expose generated SSH passwords in public logs
```

---

## 16. Environment Notes

```
- Jetson OS: Ubuntu 18.04 (L4T)
- Project Python: python3.10
- System python3: 3.6.9 (do not use)
- Docker compose command: docker compose
- Jetson host IP: 192.168.1.2
- Jetson project path: /home/sugara-jetson/miniatur-cloud/
```

---

## 17. Team and Ownership

| Area | Folder/Service | Owner |
| --- | --- | --- |
| API and orchestration | `iaas-api/` | Backend owner |
| Gateway and console serving | `nginx/`, `html/` | Web/Gateway owner |
| Infra observability | `prometheus/`, Grafana | Infra owner |

Rules:

- Coordinate before changing another owner area
- Discuss API contract changes before implementation
- Cross-area changes should be reviewed by related owner

---

## 18. Integration Contracts

### Console <-> API

```
- Console must call backend through /api/ path when served by Nginx
- Login request format follows OAuth2PasswordRequestForm
- Bearer token required for all protected routes
```

### API <-> Docker Engine

```
- Provisioning and lifecycle actions are mediated by compute.py
- Instance containers must include label iaas.instance_id
- Resource limits must follow selected instance_type
```

### CI/CD Contract

```
- Current deploy pipeline performs git pull on Jetson
- Rebuild/restart services are manual unless workflow is extended
```
