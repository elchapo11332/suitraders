# SUI Network DEX Screener

A real-time DEX (Decentralized Exchange) aggregator and dashboard for the Sui blockchain. Aggregates token data, prices, and liquidity from RaidenX, GeckoTerminal, and Cetus.

## Architecture

This is a **pnpm monorepo** with the following structure:

- `artifacts/sui-dex/` — React + Vite frontend (SUI DEX dashboard UI) on port 5000
- `artifacts/api-server/` — Express.js backend API server on port 3000
- `artifacts/mockup-sandbox/` — Replit mockup sandbox for UI component development
- `artifacts/data/` — Static data (social-links.json)
- `lib/api-client-react/` — Generated React Query API client
- `lib/api-spec/` — OpenAPI spec + code generation (orval)
- `lib/api-zod/` — Zod schemas for API validation
- `lib/db/` — Drizzle ORM + PostgreSQL database client

## Tech Stack

- **Frontend:** React 19, Vite, Tailwind CSS v4, Radix UI, Recharts, Framer Motion, wouter
- **Backend:** Express.js v5, Pino logging, CORS
- **Database:** PostgreSQL via Drizzle ORM
- **Package Manager:** pnpm (workspace/monorepo)
- **Build:** esbuild (API), Vite (frontend)
- **Runtime:** Node.js 20

## Running the App

The app is started via `bash start.sh` (configured as "Start application" workflow):
1. Starts the API server on port 3000 (`artifacts/api-server`)
2. Starts the Vite dev server on port 5000 (`artifacts/sui-dex`)

The Vite config proxies `/api` requests to the backend at `localhost:3000`.

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (provisioned by Replit)
- `PORT` — Frontend port (5000 for dev)
- `API_PORT` — Backend API port (3000)
- `BASE_PATH` — Vite base path (/ for dev)
- `ADMIN_PASSWORD` — Admin panel password (defaults to "admin1234")

## Key Features

- Real-time SUI token pair data from RaidenX and GeckoTerminal APIs
- Trending pairs sorted by 24h volume
- Token price changes (5m, 1h, 6h, 24h)
- Liquidity, volume, buy/sell transaction counts
- Admin panel for managing token metadata and social links
- In-memory caching for external API responses
