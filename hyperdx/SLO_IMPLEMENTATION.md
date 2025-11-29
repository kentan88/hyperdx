# SLO Implementation Summary

This document summarizes the SLO (Service Level Objective) support added to HyperDX.

## Overview

SLO support has been added to HyperDX, allowing users to:
- Define SLOs with custom ClickHouse queries for numerator and denominator
- Track SLO status in real-time
- Monitor error budget remaining
- View burn rate over time
- Manage SLOs via a dedicated UI

## Architecture

### Data Storage

1. **MongoDB** (`slo_definitions` collection):
   - Stores SLO configuration and metadata
   - Primary source of truth for SLO definitions
   - Indexed by team, service name, and SLO name

2. **ClickHouse** (`slo_definitions` and `slo_measurements` tables):
   - `slo_definitions`: Denormalized copy for fast lookups (optional)
   - `slo_measurements`: Time-series data for SLO measurements
   - Partitioned by month with 1-year TTL

### Components

#### Backend (API)

1. **Models** (`packages/api/src/models/slo.ts`):
   - `ISLO` interface and Mongoose schema
   - Supports availability, latency, and error_rate metric types
   - Stores numerator/denominator ClickHouse queries
   - **NEW**: Stores `filter` and `goodCondition` for Builder mode and BubbleUp support.

2. **Controllers**:
   - `packages/api/src/controllers/slo.ts`: CRUD operations for SLOs, and `getSLOBubbleUp` logic.
   - `packages/api/src/controllers/sloStatus.ts`: Status calculation and burn rate queries

3. **Tasks** (Background Jobs):
   - `packages/api/src/tasks/runSLOChecks.ts`: Periodic task (runs every minute)
   - Computes SLO status for all active SLOs
   - Stores results in `slo_measurements` table for historical tracking and caching
   - `packages/api/src/tasks/checkAlerts`: Updated to support SLO alerts (checking error budget remaining)

4. **API Routes** (`packages/api/src/routers/api/slos.ts`):
   - `GET /api/slos` - List all SLOs
   - `GET /api/slos/:id` - Get SLO details
   - `GET /api/slos/:id/status` - Get current SLO status (from cache/measurements)
   - `GET /api/slos/:id/burn-rate` - Get burn rate over time
   - `POST /api/slos` - Create new SLO
   - `PATCH /api/slos/:id` - Update SLO
   - `DELETE /api/slos/:id` - Delete SLO
   - **NEW**: `POST /api/slos/:id/bubbleup` - Analyze attribute correlations for bad events.

5. **Migrations**:
   - `packages/api/migrations/ch/000002_create_slo_tables.up.sql`: Creates ClickHouse tables
   - `packages/api/migrations/ch/000002_create_slo_tables.down.sql`: Rollback migration

#### Frontend (App)

1. **Pages**:
   - `packages/app/pages/slos/index.tsx`: List of SLOs
   - `packages/app/pages/slos/[id].tsx`: SLO Details page

2. **Views** (Components):
   - `packages/app/src/SLOPage.tsx`: Main list view and creation modal (with Builder mode)
   - `packages/app/src/SLODetailsPage.tsx`: Details view with Burn Rate chart and **BubbleUp Analysis**

3. **API Hooks** (`packages/app/src/api.ts`):
   - `useSLOs()` - Fetch all SLOs
   - `useSLO(sloId)` - Fetch single SLO
   - `useSLOStatus(sloId)` - Fetch SLO status
   - `useSLOBurnRate(sloId, timeStart, timeEnd)` - Fetch burn rate
   - `useSLOBubbleUp(sloId, timeStart, timeEnd)` - Fetch BubbleUp analysis
   - `useCreateSLO()` - Create SLO mutation
   - `useUpdateSLO()` - Update SLO mutation
   - `useDeleteSLO()` - Delete SLO mutation

4. **Components**:
   - `packages/app/src/components/SLOStatusCard.tsx`: React component for displaying SLO status

## Usage

### Creating an SLO

Users can create SLOs via the UI (`/slos`) or API.

**Builder Mode (Recommended):**
- **Base Filter**: `ServiceName = 'api-service'`
- **Good Condition**: `SeverityNumber < 17`

**Raw SQL Mode:**
- **Numerator Query**:
  ```sql
  SELECT count() as count
  FROM default.otel_logs
  WHERE ServiceName = 'api-service'
    AND SeverityNumber < 17
    AND Timestamp >= now() - INTERVAL 30 DAY
  ```
- **Denominator Query**:
  ```sql
  SELECT count() as count
  FROM default.otel_logs
  WHERE ServiceName = 'api-service'
    AND Timestamp >= now() - INTERVAL 30 DAY
  ```

### Alerts

You can create alerts based on SLOs (Error Budget Remaining).
- Source: `SLO`
- Condition: `Error Budget Remaining < X%`

### Status Calculation

SLO status is calculated as:
- **Achieved**: `(numerator / denominator) * 100`
- **Error Budget Total**: `(1 - target/100) * time_window`
- **Error Budget Used**: `(1 - achieved/100) * time_window`
- **Error Budget Remaining**: `error_budget_total - error_budget_used`

Status levels:
- **healthy**: `achieved >= target`
- **at_risk**: `achieved < target && error_budget_remaining > 0 && error_budget_remaining <= 10%`
- **breached**: `achieved < target && error_budget_remaining <= 0`

## Advanced Features

### SLO Builder
A user-friendly "Builder" mode has been added to the SLO creation UI. Instead of writing raw SQL, users can define:
- **Base Filter (Total Events)**: SQL WHERE clause defining the set of valid events (Denominator).
- **Good Event Condition**: SQL condition that defines a successful event (Numerator = Filter AND Condition).

### BubbleUp Analysis
A "BubbleUp" style debugging tool helps identify why an SLO is failing.
- **Endpoint**: `POST /api/slos/:id/bubbleup`
- **Logic**: Compares "Bad" events (Filter AND NOT Condition) vs "Good" events (Filter AND Condition) over a time window.
- **Visualization**: Shows top attributes (e.g., `tenant_id`, `host`) that are over-represented in bad events, helping to pinpoint the root cause (e.g., "Tenant X accounts for 80% of errors").

## Migration

To apply the ClickHouse migrations:

```bash
cd hyperdx/packages/api
npm run dev:migrate-ch
```

Or using the Makefile:

```bash
make dev-migrate-db
```
