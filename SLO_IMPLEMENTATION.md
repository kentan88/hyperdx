# SLO Implementation Summary

This document summarizes the SLO (Service Level Objective) support added to HyperDX.

## Overview

SLO support has been added to HyperDX, allowing users to:
- Define SLOs with custom ClickHouse queries for numerator and denominator
- Track SLO status in real-time
- Monitor error budget remaining
- View burn rate over time

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

2. **Controllers**:
   - `packages/api/src/controllers/slo.ts`: CRUD operations for SLOs
   - `packages/api/src/controllers/sloStatus.ts`: Status calculation and burn rate queries

3. **API Routes** (`packages/api/src/routers/api/slos.ts`):
   - `GET /api/slos` - List all SLOs
   - `GET /api/slos/:id` - Get SLO details
   - `GET /api/slos/:id/status` - Get current SLO status
   - `GET /api/slos/:id/burn-rate` - Get burn rate over time
   - `POST /api/slos` - Create new SLO
   - `PATCH /api/slos/:id` - Update SLO
   - `DELETE /api/slos/:id` - Delete SLO

4. **Migrations**:
   - `packages/api/migrations/ch/000002_create_slo_tables.up.sql`: Creates ClickHouse tables
   - `packages/api/migrations/ch/000002_create_slo_tables.down.sql`: Rollback migration

#### Frontend (App)

1. **API Hooks** (`packages/app/src/api.ts`):
   - `useSLOs()` - Fetch all SLOs
   - `useSLOStatus(sloId)` - Fetch SLO status
   - `useSLOBurnRate(sloId, timeStart, timeEnd)` - Fetch burn rate
   - `useCreateSLO()` - Create SLO mutation
   - `useUpdateSLO()` - Update SLO mutation
   - `useDeleteSLO()` - Delete SLO mutation

2. **Components**:
   - `packages/app/src/components/SLOStatusCard.tsx`: React component for displaying SLO status

## Usage

### Creating an SLO

#### Log-Based Availability SLO

```typescript
const createSLO = useCreateSLO();

createSLO.mutate({
  serviceName: 'api-service',
  sloName: 'log-availability-99.9',
  metricType: 'availability',
  targetValue: 99.9,
  timeWindow: '30d',
  sourceTable: 'otel_logs',
  numeratorQuery: `
    SELECT count() as count
    FROM default.otel_logs
    WHERE ServiceName = 'api-service'
      AND SeverityNumber < 17  -- Success (info and below)
      AND Timestamp >= now() - INTERVAL 30 DAY
  `,
  denominatorQuery: `
    SELECT count() as count
    FROM default.otel_logs
    WHERE ServiceName = 'api-service'
      AND Timestamp >= now() - INTERVAL 30 DAY
  `,
  alertThreshold: 80, // Alert when error budget drops below 80%
});
```

#### Trace-Based Latency SLO

```typescript
createSLO.mutate({
  serviceName: 'checkout-service',
  sloName: 'latency-p99-200ms',
  metricType: 'latency',
  targetValue: 99.0,
  timeWindow: '30d',
  sourceTable: 'otel_traces',
  numeratorQuery: `
    SELECT count() as count
    FROM default.otel_traces
    WHERE ServiceName = 'checkout-service'
      AND SpanName LIKE 'POST /checkout%'
      AND Duration < 200  -- Duration in milliseconds
      AND Timestamp >= now() - INTERVAL 30 DAY
  `,
  denominatorQuery: `
    SELECT count() as count
    FROM default.otel_traces
    WHERE ServiceName = 'checkout-service'
      AND SpanName LIKE 'POST /checkout%'
      AND Timestamp >= now() - INTERVAL 30 DAY
  `,
  alertThreshold: 80,
});
```

#### Trace-Based Availability SLO (Error Rate)

```typescript
createSLO.mutate({
  serviceName: 'api-service',
  sloName: 'trace-availability-99.5',
  metricType: 'availability',
  targetValue: 99.5,
  timeWindow: '30d',
  sourceTable: 'otel_traces',
  numeratorQuery: `
    SELECT count() as count
    FROM default.otel_traces
    WHERE ServiceName = 'api-service'
      AND StatusCode = 1  -- 1 = OK in OpenTelemetry
      AND Timestamp >= now() - INTERVAL 30 DAY
  `,
  denominatorQuery: `
    SELECT count() as count
    FROM default.otel_traces
    WHERE ServiceName = 'api-service'
      AND Timestamp >= now() - INTERVAL 30 DAY
  `,
  alertThreshold: 80,
});
```

#### Builder Mode Examples

**Logs (Error Rate)**:
```typescript
{
  sourceTable: 'otel_logs',
  filter: "ServiceName = 'api'",
  goodCondition: "SeverityNumber < 17",  // Non-error logs
}
```

**Traces (Latency)**:
```typescript
{
  sourceTable: 'otel_traces',
  filter: "ServiceName = 'checkout' AND SpanName LIKE 'POST /api/%'",
  goodCondition: "StatusCode = 1 AND Duration < 1000",  // Success with <1s latency
}
```

### Choosing Between Logs and Traces

**Use `otel_logs` when:**
- Measuring error rates based on log severity
- Tracking application-level events or incidents
- Working with services that primarily emit logs

**Use `otel_traces` when:**
- Measuring request latency (using `Duration` field)
- Tracking request success/failure rates (using `StatusCode`)
- Monitoring distributed transactions across services
- Measuring user-facing API reliability

**Key Field Differences:**

| Field | Logs | Traces |
|-------|------|--------|
| Severity | `SeverityNumber`, `SeverityText` | N/A |
| Success/Failure | `SeverityNumber < 17` | `StatusCode = 1` (OK) or `StatusCode = 2` (ERROR) |
| Latency | Not directly available | `Duration` (milliseconds) |
| Operation Name | `Body` or custom attributes | `SpanName` |
| Attributes | `LogAttributes` | `SpanAttributes` |

### Query Requirements

Both `numeratorQuery` and `denominatorQuery` must:
- Return a single row with a `count` column
- Be valid ClickHouse SELECT queries
- Not include time filters (they are applied automatically based on `timeWindow`)
- Use the correct `sourceTable` specified in the SLO configuration

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

## Next Steps

### Phase 2: Real-time SLO Tracking

1. **Materialized Views**: Create materialized views that continuously calculate SLO measurements
2. **Background Jobs**: Add scheduled tasks to compute and store SLO measurements periodically
3. **Caching**: Cache SLO status calculations for better performance

### Phase 3: Alert Integration

1. **SLO Alert Rules**: Extend the alert system to support SLO burn rate alerts
2. **Burn Rate Detection**: Alert when error budget is being consumed too quickly
3. **Incident Integration**: Auto-create incidents when SLO is breached

### Phase 4: UI Enhancements

1. **SLO Dashboard Page**: Create a dedicated page for managing and viewing SLOs
2. **SLO Creation Form**: Build a user-friendly form for creating SLOs
3. **Burn Rate Charts**: Add time-series charts for burn rate visualization
4. **Dashboard Integration**: Allow adding SLO status cards to existing dashboards

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

## Notes

- SLO definitions are stored in MongoDB for configuration management
- ClickHouse `slo_definitions` table is optional and used for performance optimization
- SLO measurements can be computed on-demand or from pre-computed `slo_measurements` table
- The implementation follows HyperDX's schema-agnostic philosophy by allowing custom ClickHouse queries

