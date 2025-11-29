# TenantId Integration Plan for ClickHouse

## Current Architecture

### Data Ingestion Flow
```
Client (with API key) 
  → OTEL Collector (port 4317/4318)
    → bearertokenauth/hyperdx extension (validates API key)
      → transform processor (JSON parsing, severity inference)
        → ClickHouse exporter
          → ClickHouse tables
```

### Current State
- **No tenantId in ClickHouse**: Data isolation happens at query time based on user's team (MongoDB)
- **API Key = Team**: Each team has an `apiKey` field used for ingestion authentication
- **Authentication**: OTEL collector validates API keys against list from MongoDB teams
- **Location**: `packages/api/src/opamp/controllers/opampController.ts` - line 118-287

## Recommended Implementation Points

### 1. **Add tenantId Column to ClickHouse Tables** ⭐ **HIGHEST PRIORITY**

#### Files to Modify:
```
/docker/clickhouse/local/init-db.sh
/packages/api/src/fixtures.ts (for test tables)
```

#### For each table (`otel_logs`, `otel_traces`, `hyperdx_sessions`, metrics tables):
```sql
-- Add tenantId column
`TenantId` String CODEC(ZSTD(1)),

-- Add index for efficient filtering
INDEX idx_tenant_id TenantId TYPE bloom_filter(0.001) GRANULARITY 1,

-- Update PRIMARY KEY to include TenantId for better data locality
PRIMARY KEY (TenantId, ServiceName, TimestampTime)
ORDER BY (TenantId, ServiceName, TimestampTime, Timestamp)
```

**Example for otel_logs table:**
```bash
# In docker/clickhouse/local/init-db.sh around line 14-50

CREATE TABLE IF NOT EXISTS ${DATABASE}.otel_logs
(
  `TenantId` String CODEC(ZSTD(1)),  # <-- ADD THIS
  `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
  `TimestampTime` DateTime DEFAULT toDateTime(Timestamp),
  # ... rest of fields ...
  
  INDEX idx_tenant_id TenantId TYPE bloom_filter(0.001) GRANULARITY 1,  # <-- ADD THIS
  INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
  # ... rest of indexes ...
)
ENGINE = MergeTree
PARTITION BY toDate(TimestampTime)
PRIMARY KEY (TenantId, ServiceName, TimestampTime)  # <-- MODIFY THIS
ORDER BY (TenantId, ServiceName, TimestampTime, Timestamp)  # <-- MODIFY THIS
```

### 2. **Link Team to Tenant** ⭐ **REQUIRED**

Add `tenant` field to Team model:

```typescript
// packages/api/src/models/team.ts

export type ITeam = {
  _id: ObjectId;
  id: string;
  name: string;
  tenant: ObjectId;  // <-- ADD THIS
  allowedAuthMethods?: 'password'[];
  apiKey: string;
  hookId: string;
  collectorAuthenticationEnforced: boolean;
} & TeamCHSettings;

// In schema:
new Schema<ITeam>({
  name: String,
  tenant: {  // <-- ADD THIS
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
  },
  // ... rest of fields
})
```

### 3. **Create Enrichment Service/Processor** ⭐ **KEY IMPLEMENTATION**

#### Option A: Custom OTEL Collector Processor (Recommended but Complex)
Create a custom Go processor that:
- Extracts API key from auth metadata
- Queries MongoDB/cache for tenantId
- Adds tenantId to resource attributes

**Pros**: Native OTEL, high performance
**Cons**: Requires Go development, OTEL collector rebuild

#### Option B: HTTP Middleware Service (Easier, Recommended for MVP) ⭐
Create a Node.js service that acts as a proxy:

```
Client → Enrichment Service (Node.js) → OTEL Collector → ClickHouse
```

**File to create:** `/packages/api/src/enrichment-service.ts`

```typescript
import express from 'express';
import { getTeamByApiKey } from '@/controllers/team';
import { getTenantById } from '@/controllers/tenant';

const app = express();

// Proxy OTEL HTTP endpoint
app.post('/v1/logs', async (req, res) => {
  // 1. Extract API key from Authorization header
  const authHeader = req.headers.authorization;
  const apiKey = authHeader?.split('Bearer ')[1];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  
  // 2. Look up team by API key
  const team = await getTeamByApiKey(apiKey);
  if (!team) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  // 3. Get tenantId from team
  const tenantId = team.tenant.toString();
  
  // 4. Inject tenantId into OTEL data
  const otelData = req.body;
  
  // For each resource span/log/metric, add tenantId to resource attributes
  if (otelData.resourceLogs) {
    otelData.resourceLogs.forEach((rl: any) => {
      rl.resource = rl.resource || {};
      rl.resource.attributes = rl.resource.attributes || [];
      rl.resource.attributes.push({
        key: 'hdx.tenant.id',
        value: { stringValue: tenantId }
      });
    });
  }
  
  // Similar for resourceSpans and resourceMetrics...
  
  // 5. Forward to OTEL collector
  await forwardToOtelCollector(otelData, apiKey);
  
  res.status(200).send();
});

app.listen(4319, () => {
  console.log('Enrichment service listening on 4319');
});
```

#### Option C: Transform Processor with External Service (Hybrid Approach)

Modify the OTEL transform processor to call a lightweight HTTP service:

**File:** `/docker/otel-collector/config.yaml`

```yaml
processors:
  transform:
    log_statements:
      # Existing statements...
      
      # NEW: Add tenantId enrichment
      - context: resource
        statements:
          # Extract API key from metadata
          - set(resource.cache["api_key"], metadata["authorization"])
          # Call enrichment service (requires custom function or extension)
          # This is pseudo-code - actual implementation needs custom extension
```

**This approach requires a custom OTEL extension.**

### 4. **Modify OTEL Collector Config Builder** ⭐ **CRITICAL**

**File:** `/packages/api/src/opamp/controllers/opampController.ts`

Add enrichment processor to pipelines:

```typescript
export const buildOtelCollectorConfig = (teams: ITeam[]): CollectorConfig => {
  // ... existing code ...
  
  const otelCollectorConfig: CollectorConfig = {
    // ... existing config ...
    
    processors: {
      'memory_limiter': { /* ... */ },
      'batch': { /* ... */ },
      'transform': { /* ... */ },
      
      // NEW: Add HTTP enrichment processor (if using Option B)
      'http/enrichment': {
        endpoint: 'http://enrichment-service:4319',
        headers: {
          'X-Internal-Service': 'true'
        }
      }
    },
    
    service: {
      pipelines: {
        traces: {
          receivers: ['nop'],
          processors: [
            'memory_limiter', 
            'http/enrichment',  // <-- ADD THIS
            'batch'
          ],
          exporters: ['clickhouse'],
        },
        'logs/out-default': {
          receivers: ['routing/logs'],
          processors: [
            'memory_limiter',
            'transform',
            'http/enrichment',  // <-- ADD THIS
            'batch'
          ],
          exporters: ['clickhouse'],
        },
        // ... similar for metrics and rrweb logs
      }
    }
  };
  
  return otelCollectorConfig;
};
```

### 5. **Alternative: Modify ClickHouse Exporter Mapping** ⭐ **SIMPLER OPTION**

Instead of a separate service, modify the ClickHouse exporter configuration to extract tenantId from resource attributes:

**File:** `/packages/api/src/opamp/controllers/opampController.ts` (lines 187-222)

The ClickHouse exporter config would need to map the `hdx.tenant.id` attribute to the `TenantId` column. However, the current OTEL ClickHouse exporter may not support custom column mappings directly.

## Recommended Implementation Path

### Phase 1: Database Schema (Week 1)
1. ✅ Create Tenant model (DONE)
2. Add `tenant` field to Team model
3. Add `TenantId` column to all ClickHouse tables
4. Create migration script to backfill existing data

### Phase 2: Enrichment Service (Week 2)
1. Implement Option B (HTTP Middleware Service) as MVP
2. Cache team→tenant mappings in Redis for performance
3. Add monitoring and error handling

### Phase 3: Integration (Week 3)
1. Update OTEL collector config to route through enrichment service
2. Update all ClickHouse queries to filter by tenantId
3. Add tenantId to all API query builders

### Phase 4: Optimization (Week 4+)
1. Consider Option A (custom OTEL processor) for better performance
2. Add tenantId-based data retention policies
3. Implement tenant quotas and rate limiting

## Key Files to Modify

1. **ClickHouse Schema:**
   - `/docker/clickhouse/local/init-db.sh` (tables definition)
   - `/packages/api/src/fixtures.ts` (test tables)

2. **Data Models:**
   - `/packages/api/src/models/team.ts` (add tenant reference)
   - `/packages/api/src/models/tenant.ts` (already created)

3. **Ingestion Pipeline:**
   - `/packages/api/src/enrichment-service.ts` (NEW - create this)
   - `/packages/api/src/opamp/controllers/opampController.ts` (modify config)
   - `/docker/otel-collector/config.yaml` (add processor)

4. **Query Layer:**
   - All files in `/packages/api/src/routers/` that query ClickHouse
   - `/packages/api/src/controllers/` - add tenantId filters

5. **Docker Compose:**
   - `/docker-compose.yml` (add enrichment service)
   - `/docker-compose.dev.yml` (add enrichment service)

## Performance Considerations

1. **Caching**: Use Redis to cache API key → tenantId mappings
2. **Connection Pooling**: MongoDB connection pool for enrichment lookups
3. **Batch Processing**: Group multiple lookups in enrichment service
4. **ClickHouse Partitioning**: Consider partitioning by tenantId for very large tenants

## Security Considerations

1. **API Key Validation**: Validate before tenantId lookup
2. **Rate Limiting**: Per-tenant rate limits
3. **Data Isolation**: ALWAYS filter by tenantId in queries
4. **Audit Logging**: Log all tenantId assignments

## Migration Strategy

For existing data without tenantId:
```sql
-- Option 1: Default tenant
ALTER TABLE otel_logs UPDATE TenantId = 'default-tenant-id' WHERE TenantId = '';

-- Option 2: Drop old data
-- Be careful with this!
ALTER TABLE otel_logs DELETE WHERE TenantId = '';
```

## Testing

1. Unit tests for enrichment service
2. Integration tests with mock ClickHouse
3. Load testing with multiple tenants
4. Data isolation verification

## Next Steps

1. Review this plan and decide on Option A vs B vs C
2. Create tenant records in MongoDB
3. Link existing teams to tenants
4. Implement chosen enrichment approach
5. Test with sample data before production rollout


