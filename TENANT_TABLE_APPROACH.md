# Per-Tenant Table Approach - MINIMAL CHANGES ✨

## Overview
Instead of adding a `tenantId` column, each tenant gets their own ClickHouse tables:
- `otel_logs_<tenantId>`
- `otel_traces_<tenantId>` 
- `hyperdx_sessions_<tenantId>`
- Metric tables per tenant

## Key Advantages

✅ **Much simpler implementation** - Leverage existing infrastructure
✅ **Natural data isolation** - No risk of cross-tenant queries
✅ **Better performance** - No tenantId filtering needed
✅ **Easy tenant deletion** - Just drop their tables
✅ **Independent retention policies** - Per-tenant TTL settings
✅ **Easier to implement quotas** - Monitor table size per tenant

## Architecture Already Supports This!

Looking at the code, the system **ALREADY** has the infrastructure for dynamic table names:

1. **Sources model** already stores table names:
```typescript
// packages/api/src/models/source.ts
{
  from: {
    databaseName: String,
    tableName: String,  // <-- Already configurable!
  }
}
```

2. **OTEL Collector config** already supports custom table names:
```typescript
// packages/api/src/opamp/controllers/opampController.ts (line 200)
'clickhouse/rrweb': {
  logs_table_name: 'hyperdx_sessions',  // <-- Already configurable!
}
```

3. **Queries** already use dynamic table names from sources:
```typescript
// packages/api/src/routers/external-api/v2/charts.ts (line 236)
from: {
  databaseName: source.from.databaseName,
  tableName: source.from.tableName,  // <-- Already dynamic!
}
```

## Implementation Changes (MINIMAL!)

### 1. Modify Team Model to Link to Tenant
**File:** `/packages/api/src/models/team.ts`

```typescript
export type ITeam = {
  _id: ObjectId;
  id: string;
  name: string;
  tenant: ObjectId;  // <-- ADD THIS LINE
  allowedAuthMethods?: 'password'[];
  apiKey: string;
  // ... rest
}

// In schema:
tenant: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Tenant',
  required: true,
},
```

### 2. Create Per-Tenant OTEL Collector Configs
**File:** `/packages/api/src/opamp/controllers/opampController.ts`

**CURRENT** (lines 118-287):
```typescript
export const buildOtelCollectorConfig = (teams: ITeam[]): CollectorConfig => {
  // ... builds ONE config for ALL teams
}
```

**NEW** - Change to build config PER TEAM:
```typescript
// Instead of accepting all teams, accept ONE team
export const buildOtelCollectorConfig = (team: ITeam, tenantId: string): CollectorConfig => {
  const apiKeys = [team.apiKey];
  
  // ... same setup ...
  
  const otelCollectorConfig: CollectorConfig = {
    // ... same setup ...
    
    exporters: {
      nop: null,
      
      // RRWeb sessions - per tenant table
      'clickhouse/rrweb': {
        endpoint: '${env:CLICKHOUSE_ENDPOINT}',
        database: '${env:HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE}',
        username: '${env:CLICKHOUSE_USER}',
        password: '${env:CLICKHOUSE_PASSWORD}',
        ttl: '720h',
        logs_table_name: `hyperdx_sessions_${tenantId}`,  // <-- PER TENANT
        timeout: '5s',
        retry_on_failure: {
          enabled: true,
          initial_interval: '5s',
          max_interval: '30s',
          max_elapsed_time: '300s',
        },
      },
      
      // Main exporter - per tenant tables
      clickhouse: {
        endpoint: '${env:CLICKHOUSE_ENDPOINT}',
        database: '${env:HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE}',
        username: '${env:CLICKHOUSE_USER}',
        password: '${env:CLICKHOUSE_PASSWORD}',
        ttl: '720h',
        logs_table_name: `otel_logs_${tenantId}`,      // <-- PER TENANT
        traces_table_name: `otel_traces_${tenantId}`,  // <-- PER TENANT
        metrics_table_name: `otel_metrics_${tenantId}`, // <-- PER TENANT
        timeout: '5s',
        retry_on_failure: {
          enabled: true,
          initial_interval: '5s',
          max_interval: '30s',
          max_elapsed_time: '300s',
        },
      },
    },
    // ... rest unchanged
  };
  
  return otelCollectorConfig;
};
```

### 3. Modify OpAMP Controller to Generate Per-Team Configs
**File:** `/packages/api/src/opamp/controllers/opampController.ts` (around line 326-331)

**CURRENT:**
```typescript
const teams = await getAllTeams([
  'apiKey',
  'collectorAuthenticationEnforced',
]);
const otelCollectorConfig = buildOtelCollectorConfig(teams);
```

**NEW** - Need to identify which team this collector instance is for:
```typescript
// Option A: Each team gets its own OTEL collector instance
// The collector identifies itself via instance UID or API key
const apiKey = extractApiKeyFromAgent(agent);
const team = await getTeamByApiKey(apiKey);

if (!team) {
  throw new Error('Team not found');
}

// Populate tenant reference if needed
await team.populate('tenant');
const tenantId = team.tenant._id.toString();

const otelCollectorConfig = buildOtelCollectorConfig(team, tenantId);
```

### 4. Auto-Create Tables When Tenant is Created
**File:** `/packages/api/src/controllers/tenant.ts`

```typescript
import { getClickhouseClient } from '@/utils/clickhouse';

export async function createTenant(tenant: Omit<ITenant, 'id' | '_id'>) {
  // Create tenant in MongoDB
  const newTenant = await Tenant.create(tenant);
  const tenantId = newTenant._id.toString();
  
  // Create ClickHouse tables for this tenant
  await createClickhouseTablesForTenant(tenantId);
  
  return newTenant;
}

async function createClickhouseTablesForTenant(tenantId: string) {
  const client = await getClickhouseClient();
  const database = process.env.HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE || 'default';
  
  // Create logs table
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${database}.otel_logs_${tenantId}
      (
        Timestamp DateTime64(9) CODEC(Delta(8), ZSTD(1)),
        TimestampTime DateTime DEFAULT toDateTime(Timestamp),
        TraceId String CODEC(ZSTD(1)),
        SpanId String CODEC(ZSTD(1)),
        TraceFlags UInt8,
        SeverityText LowCardinality(String) CODEC(ZSTD(1)),
        SeverityNumber UInt8,
        ServiceName LowCardinality(String) CODEC(ZSTD(1)),
        Body String CODEC(ZSTD(1)),
        ResourceSchemaUrl LowCardinality(String) CODEC(ZSTD(1)),
        ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
        ScopeSchemaUrl LowCardinality(String) CODEC(ZSTD(1)),
        ScopeName String CODEC(ZSTD(1)),
        ScopeVersion LowCardinality(String) CODEC(ZSTD(1)),
        ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
        LogAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
        INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
        INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_log_attr_value mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
        INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
      )
      ENGINE = MergeTree
      PARTITION BY toDate(TimestampTime)
      PRIMARY KEY (ServiceName, TimestampTime)
      ORDER BY (ServiceName, TimestampTime, Timestamp)
      TTL TimestampTime + toIntervalDay(30)
      SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
    `,
    clickhouse_settings: {
      wait_end_of_query: 1,
    },
  });
  
  // Create traces table
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${database}.otel_traces_${tenantId}
      (
        -- Same schema as otel_traces but with tenant-specific name
        -- Copy from docker/clickhouse/local/init-db.sh lines 59-94
      )
      ENGINE = MergeTree
      PARTITION BY toDate(Timestamp)
      ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))
      TTL toDate(Timestamp) + toIntervalDay(30)
      SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
    `,
    clickhouse_settings: {
      wait_end_of_query: 1,
    },
  });
  
  // Create sessions table
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${database}.hyperdx_sessions_${tenantId}
      (
        -- Same schema as hyperdx_sessions
        -- Copy from docker/clickhouse/local/init-db.sh lines 96-130
      )
      ENGINE = MergeTree
      PARTITION BY toDate(TimestampTime)
      ORDER BY (__hdx_materialized_rum.sessionId, toDateTime(TimestampTime), Timestamp)
      TTL toDate(TimestampTime) + toIntervalDay(30)
      SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
    `,
    clickhouse_settings: {
      wait_end_of_query: 1,
    },
  });
  
  // Metric tables if needed...
}
```

### 5. Update Source Creation to Use Tenant-Specific Table Names
**File:** `/packages/api/src/controllers/sources.ts` (or wherever sources are created)

When creating a source for a team:
```typescript
export async function createSource(teamId: string, sourceData: any) {
  // Get team
  const team = await Team.findById(teamId).populate('tenant');
  if (!team) throw new Error('Team not found');
  
  const tenantId = team.tenant._id.toString();
  
  // Override table name with tenant-specific name
  const source = await Source.create({
    ...sourceData,
    from: {
      databaseName: sourceData.from.databaseName,
      tableName: `${sourceData.from.tableName}_${tenantId}`,  // <-- Add tenant suffix
    },
  });
  
  return source;
}
```

### 6. Helper Function to Get Tenant's Table Name
**File:** `/packages/api/src/utils/tenant.ts` (NEW FILE)

```typescript
export function getTenantTableName(baseTableName: string, tenantId: string): string {
  return `${baseTableName}_${tenantId}`;
}

export function parseTenantFromTableName(tableName: string): string | null {
  // otel_logs_507f1f77bcf86cd799439011 -> 507f1f77bcf86cd799439011
  const match = tableName.match(/^(.+)_([a-f0-9]{24})$/);
  return match ? match[2] : null;
}
```

## Deployment Options

### Option A: One OTEL Collector Per Team (Simple)
Each team gets its own OTEL collector container that writes to its tenant's tables.

**Pros:** 
- Complete isolation
- Easy to scale per tenant
- No API key collision

**Cons:**
- More containers to manage
- Higher resource usage

### Option B: Shared OTEL Collector with API Key Routing (Current)
One collector accepts all teams' data, routes based on API key.

**Challenge:** Need to determine tenantId from API key during ingestion.

**Solution:** Modify the bearer token auth to also inject tenant context:
- Could use OTEL collector's routing connector
- Or use resource detection processor to add tenant metadata

### Option C: Hybrid - One Collector, Dynamic Config Per Request
The collector config is updated dynamically as teams are added/removed (current OpAMP approach).

**Recommended:** Start with Option C (current approach), just add tenant table names.

## Migration Strategy

### For Existing Data (If Any)

**Option 1:** Copy existing tables to tenant-specific tables:
```sql
-- Copy existing data to first tenant's tables
CREATE TABLE otel_logs_<firstTenantId> AS otel_logs;
CREATE TABLE otel_traces_<firstTenantId> AS otel_traces;
CREATE TABLE hyperdx_sessions_<firstTenantId> AS hyperdx_sessions;

-- Drop old tables
DROP TABLE otel_logs;
DROP TABLE otel_traces;
DROP TABLE hyperdx_sessions;
```

**Option 2:** Start fresh (if pre-production):
```sql
DROP TABLE IF EXISTS otel_logs;
DROP TABLE IF EXISTS otel_traces;
DROP TABLE IF EXISTS hyperdx_sessions;
```

## Summary of Changes

### Files to Modify:
1. ✅ `/packages/api/src/models/team.ts` - Add `tenant` field
2. ✅ `/packages/api/src/models/tenant.ts` - Already created
3. ✅ `/packages/api/src/controllers/tenant.ts` - Add table creation logic
4. ✅ `/packages/api/src/opamp/controllers/opampController.ts` - Modify to use per-tenant table names
5. ✅ `/packages/api/src/controllers/sources.ts` - Auto-append tenant suffix to table names

### Files to Create:
1. `/packages/api/src/utils/tenant.ts` - Helper functions for table names

### No Changes Needed:
- ❌ Query layer (already uses `source.from.tableName`)
- ❌ ClickHouse exporter (already supports custom table names)
- ❌ Most API code (table names come from sources)

## Comparison: Column vs Separate Tables

| Aspect | TenantId Column | Separate Tables |
|--------|----------------|-----------------|
| **Code Changes** | Many (all queries need WHERE tenantId) | Few (infrastructure exists) |
| **Query Performance** | Need to filter every query | No filtering needed |
| **Data Isolation** | Logical (must remember filter) | Physical (impossible to cross) |
| **Tenant Deletion** | DELETE WHERE tenantId = X | DROP TABLE |
| **Schema Changes** | Apply once to big table | Apply to each tenant table |
| **Table Management** | 1 table per type | N tables per type |
| **Cross-Tenant Analytics** | Easy (one query) | Complex (UNION ALL) |
| **ClickHouse Partitioning** | All tenants share | Independent per tenant |

## Recommendation

**Use Separate Tables Approach** because:

1. ✅ **90% of infrastructure already exists** - Just need to:
   - Link teams to tenants
   - Modify OTEL config generation
   - Create tables on tenant creation

2. ✅ **Better isolation** - Impossible to leak data across tenants

3. ✅ **Better performance** - No tenantId filtering overhead

4. ✅ **Easier to implement quotas** - Monitor table size

5. ✅ **Simpler queries** - No WHERE tenantId needed

The only downside is managing more tables, but ClickHouse handles this well, and you probably won't have thousands of tenants.

## Next Steps

1. Add `tenant` field to Team model
2. Create table creation function in tenant controller
3. Modify `buildOtelCollectorConfig` to accept team and use tenant table names
4. Test with 2-3 sample tenants
5. Migrate existing data (if any)


