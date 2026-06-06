# 🔍 Audit Miniatur Cloud IaaS — Full Review

## Scorecard

| Area | Grade | Status |
|---|---|---|
| **Backend API** | **A-** | Sangat solid, minor issues |
| **Web Console UX** | **B** | Fungsional tapi bisa jauh lebih polished |
| **Infrastructure (docker-compose)** | **B+** | Lengkap, beberapa service belum terpakai |
| **Security** | **B-** | Beberapa gap penting |
| **Monitoring** | **C+** | Prometheus config mengarah ke exporter yang tidak ada |
| **CI/CD** | **B** | Berfungsi, tapi tidak rebuild/restart services |
| **Code Quality** | **A-** | Bersih, modular, well-structured |

---

## 1. Backend API — Grade: A-

### ✅ Yang Sudah Bagus
- Feature set **sangat lengkap** untuk mini cloud: Compute, Network, Security Groups, Floating IP, Volume, Object Storage, Snapshots, Monitoring
- Ownership enforcement konsisten (`Bukan milikmu` check di semua endpoint)
- Quota system berfungsi
- Background task untuk instance creation (non-blocking)
- Proper error handling — HTTP status codes tepat
- `recreate_instance_with_volumes` menangani network/volume changes dengan benar
- Container filtering **selalu pakai label** `iaas.instance_id` ✅

### ⚠️ Issues

| # | Severity | Issue | Detail |
|---|---|---|---|
| 1 | 🔴 Critical | **File `main.py` terlalu besar** | 1555 baris dalam satu file. Sulit maintain. AWS-level API tapi single-file structure |
| 2 | 🟡 Medium | **Tidak ada rate limiting** | Endpoint `/auth/token` rentan brute-force |
| 3 | 🟡 Medium | **`exec` endpoint tanpa ownership check** | [main.py:757-764](file:///c:/Users/ASUS/miniatur-cloud/iaas-api/main.py#L757-L764) — user manapun bisa exec command di instance siapapun kalau tahu ID-nya |
| 4 | 🟡 Medium | **Monitoring endpoints terlalu strict/loose** | `/monitoring/host` butuh admin ✅, tapi `/instances/{iid}/status` tidak cek ownership saat container belum siap |
| 5 | 🟢 Nice | **Tidak ada pagination** | `/instances`, `/volumes`, `/snapshots` return semua data — tidak masalah sekarang, tapi akan bermasalah kalau data grow |
| 6 | 🟢 Nice | **`@app.on_event("startup")` deprecated** | FastAPI merekomendasikan `lifespan` context manager |

---

## 2. Web Console UX — Grade: B

### ✅ Yang Sudah Bagus
- Arsitektur frontend **sangat rapi**: modular JS (views/, api.js, ui.js, state.js, utils.js)
- Dark theme dengan gradient — terlihat premium
- SPA-style navigation tanpa framework — impressive
- Auto-refresh via `setInterval` di setiap view
- Modal system + toast notifications berfungsi
- Proper cleanup (return cleanup function dari setiap mount)
- XSS protection via `escapeHtml` di semua render

### ⚠️ Issues

| # | Severity | Issue | Detail |
|---|---|---|---|
| 7 | 🟡 Medium | **Banyak pakai `window.prompt` / `window.confirm`** | Attach floating IP, attach volume, add SG rule, create snapshot — semua pakai prompt browser. Sangat tidak UX-friendly. Harusnya pakai modal form seperti instance detail |
| 8 | 🟡 Medium | **Network ID ditampilkan raw UUID** | Di tabel instance, kolom Network menampilkan UUID — user tidak tahu itu network apa. Harusnya resolve ke nama network |
| 9 | 🟡 Medium | **Tidak ada responsive mobile UX test** | Sidebar jadi horizontal scroll di mobile tapi button text terlalu kecil |
| 10 | 🟡 Medium | **Tidak ada loading skeleton/spinner** | Setiap view hanya menampilkan "Loading..." text — terasa raw |
| 11 | 🟢 Nice | **Tidak ada empty state illustration** | "Belum ada instance." bisa lebih engaging dengan ilustrasi + CTA |
| 12 | 🟢 Nice | **Tidak ada keyboard shortcuts** | Tidak ada shortcut untuk refresh, navigate antar tab |
| 13 | 🟢 Nice | **Toast 3 detik fixed** | Error toast hilang terlalu cepat. Success toast harusnya lebih pendek |
| 14 | 🟢 Nice | **Tidak ada favicon** | Browser tab tidak ada icon |

---

## 3. Infrastructure — Grade: B+

### ✅ Yang Sudah Bagus
- Docker Compose lengkap: Nginx, MinIO, PostgreSQL, Redis, Prometheus, Grafana, Loki
- Network isolation via `cloud-net` (172.20.0.0/16)
- Named volumes untuk semua stateful services
- `restart: unless-stopped` di semua services
- Dockerfile punya HEALTHCHECK ✅

### ⚠️ Issues

| # | Severity | Issue | Detail |
|---|---|---|---|
| 15 | 🟡 Medium | **Redis tidak dipakai** | `cloud-cache` di-declare tapi tidak ada service yang connect ke Redis. Buang RAM ~30 MB |
| 16 | 🟡 Medium | **Loki tidak dipakai** | `cloud-logs` aktif tapi tidak ada log driver yang kirim ke Loki. Buang RAM ~100 MB |
| 17 | 🟡 Medium | **Prometheus targets tidak ada** | `prometheus.yml` scrape `node-exporter:9100`, `nginx-exporter:9113`, `postgres-exporter:9187` — **tapi ketiga exporter ini tidak ada di docker-compose**. Prometheus jalan tapi scrape gagal semua |
| 18 | 🟢 Nice | **Tidak ada resource limits** | Tidak ada `mem_limit` / `cpus` di services docker-compose (selain yang di-enforce per instance oleh compute.py) |

---

## 4. Security — Grade: B-

### ✅ Yang Sudah Bagus
- JWT authentication dengan expiry (60 min)
- Bcrypt password hashing
- Ownership checks di hampir semua endpoints
- Admin-only routes properly guarded

### ⚠️ Issues

| # | Severity | Issue | Detail |
|---|---|---|---|
| 19 | 🔴 Critical | **Exec endpoint tanpa ownership** | Sudah disebutkan di #3. User biasa bisa exec `cat /etc/shadow` di instance orang lain |
| 20 | 🔴 Critical | **SECRET_KEY hardcoded di docker-compose** | `SECRET_KEY: iaas-jetson-rahasia-ganti-ini` — ini jelas placeholder yang tidak pernah diganti |
| 21 | 🟡 Medium | **CORS `allow_origins=["*"]`** | Membuka API ke semua origin. Di lab environment ok, tapi harusnya di-restrict |
| 22 | 🟡 Medium | **Token di localStorage** | JWT disimpan di `localStorage` — rentan XSS. Lebih aman pakai `httpOnly` cookie |
| 23 | 🟡 Medium | **Credentials di docker-compose** | MinIO password `CloudPass2024!` dan PostgreSQL password hardcoded di file yang di-commit |
| 24 | 🟢 Nice | **Tidak ada audit log** | Tidak ada logging siapa create/terminate instance kapan |

---

## 5. Monitoring — Grade: C+

### ⚠️ Issues

| # | Severity | Issue | Detail |
|---|---|---|---|
| 25 | 🔴 Critical | **Prometheus scrape targets tidak ada** | `node-exporter`, `nginx-exporter`, `postgres-exporter` tidak ada di docker-compose. Grafana dashboard akan kosong |
| 26 | 🟡 Medium | **Host metrics hanya dari psutil** | `/monitoring/host` pakai `psutil` yang berjalan di dalam container — mendapat metrics host karena mount docker socket, tapi disk metrics mungkin menampilkan container filesystem |
| 27 | 🟢 Nice | **Tidak ada per-instance metrics di console** | Instance status hanya "running/stopped" — tidak ada CPU/RAM usage per instance di web console (padahal API-nya ada di `/instances/{id}/status`) |

---

## 6. CI/CD — Grade: B

### ✅ Yang Sudah Bagus
- GitHub Actions + Cloudflare Tunnel SSH ke Jetson — creative setup!
- Auto-deploy on push to main
- `git stash` sebelum pull — safe

### ⚠️ Issues

| # | Severity | Issue | Detail |
|---|---|---|---|
| 28 | 🟡 Medium | **Tidak rebuild/restart services setelah deploy** | Pipeline hanya `git pull` — tidak ada `docker compose build && docker compose up -d`. Kalau ada perubahan di API/Dockerfile, perubahan tidak akan aktif sampai manual restart |

---

## 7. Code Quality — Grade: A-

### ✅ Yang Sudah Bagus
- **Frontend**: ES module imports, clean separation (api/state/ui/views), no framework dependency — sangat impressive
- **Backend**: Consistent patterns, proper exception types, clear variable naming
- **CSS**: Design system via CSS variables, responsive breakpoint
- **Dockerfile**: Multi-stage not needed (slim base), healthcheck included

### Satu Masalah Besar
- **main.py 1555 lines** — ini file terlalu besar. Rekomendasi split:
  - `routes/auth.py`
  - `routes/compute.py`
  - `routes/network.py`
  - `routes/storage.py`
  - `routes/monitoring.py`
  - `schemas.py`
  - `helpers.py`

---

## Top 5 Prioritas Perbaikan

| Priority | Issue | Impact | Effort |
|---|---|---|---|
| **1** | Fix exec endpoint ownership check | 🔴 Security hole | ⚡ 5 menit |
| **2** | Tambah Prometheus exporters ke docker-compose | Monitoring tidak berfungsi sama sekali | 🕐 30 menit |
| **3** | Ganti `window.prompt` dengan modal forms di UX | Console terasa amatir | 🕐 2-3 jam |
| **4** | Hapus Redis & Loki (atau integrasikan) | Buang ~130 MB RAM gratis | ⚡ 10 menit |
| **5** | Split main.py ke modules | Maintainability jangka panjang | 🕐 1-2 jam |

---

## Verdict

Miniatur Cloud Anda **sudah sangat solid sebagai platform IaaS mini**. Feature set-nya comprehensive (Compute, Network, Security Groups, Floating IP, Volume, Object Storage, Snapshots) — ini jauh lebih lengkap dari kebanyakan project serupa.

Yang perlu dibenahi utamanya adalah:
1. **Security gap** di exec endpoint (critical, quick fix)
2. **Monitoring pipeline yang broken** (Prometheus targets tidak ada)
3. **UX polish** (ganti window.prompt, resolve network name, loading states)

Secara keseluruhan: **B+ / sangat bagus untuk scale ini**. Dengan fix prioritas 1-5 di atas, bisa naik ke **A**.
