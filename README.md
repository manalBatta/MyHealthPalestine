# HealthPal

A Node.js + MySQL backend for coordinating healthcare services: consultations, treatment requests, donations (Stripe), inventory/medicine coordination, workshops/missions, support groups, anonymous sessions, health guides, and public health alerts. Real-time messaging via Socket.io, email via Postmark.

## Tech Stack

- Node.js, Express, Socket.io
- MySQL (mysql2)
- JWT auth with role-based access
- Stripe (donations), Postmark (email)
- Docker + docker-compose for local/dev

## Quick Start (Docker)

```bash
cp docker-compose.env.example .env   # add your secrets (Stripe, Postmark, JWT)
docker-compose down -v               # optional: reset DB
docker-compose up -d                 # starts MySQL (3307) + backend (3000)
```

- API base URL defaults to `http://localhost:3000/healthpal`
- MySQL exposed on host port `3307` (container 3306)

## Environment Variables

See `docker-compose.env.example` for all keys. Key items:

- `JWT_SECRET`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM`, `POSTMARK_FROM_NAME`
- `BASE_URL`, `BACKEND_PORT`, `MYSQL_PORT`, `DB_HOST/USER/PASSWORD/NAME`

## Seeding Data

On a fresh DB, `database/schema.sql` and `database/seed.sql` run automatically (mounted into `/docker-entrypoint-initdb.d`). Seed users all have password `123456`.

- Force re-seed: `docker-compose down -v && docker-compose up -d`
- Check tables: `docker-compose exec mysql mysql -u healthpal_user -phealthpal_password healthpal -e "SHOW TABLES;"`

## Running Without Docker (local)

```bash
cd backend
npm install
cp ../docker-compose.env.example .env   # or create your own
node server.js
```

Ensure MySQL is running locally and env vars point to it.

## Notable Endpoints (base = /healthpal)

- Auth: `/auth/*`
- Users: `/users`
- Consultations & Slots: `/consultation-slots`, `/consultations`
- Treatment Requests & Donations: `/treatment-requests`, `/donations` (creates Stripe Payment Intent)
- Stripe Webhook: `/stripe-webhook` (registered before `express.json`)
- Recovery Updates: `/recovery-updates`
- Medicine Requests & Inventory: `/medicine-requests`, `/inventory-registry`
- Workshops & Registrations: `/workshops`, `/workshop-registrations`
- Missions & Surgical Missions: `/missions`, `/mission-registrations`, `/surgical-missions`
- Support Groups: `/support-groups`, `/support-group-members`, `/support-group-messages`
- Anonymous Sessions: `/anonymous-sessions`, `/anonymous-messages`
- Health Guides & Alerts: `/health-guides`, `/public-health-alerts`
