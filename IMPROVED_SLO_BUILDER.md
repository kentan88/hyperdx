# Improved SLO Builder - Feature Overview

## 🎯 Problem with Old Builder

The previous "Builder" mode still required users to:
- Write SQL WHERE clauses manually
- Know exact field names (SeverityNumber, StatusCode, etc.)
- Understand SQL operators and syntax
- Debug syntax errors
- No guidance on best practices

**Result**: Builder mode wasn't much easier than Raw SQL mode.

## ✨ New Visual Builder Features

### 1. **Template Mode (Recommended)** 🌟

Pre-built templates for common SLO patterns:

#### For Logs:
- **Log Error Rate**: Measures % of non-error logs
- **Error Log Percentage**: Tracks error log percentage

#### For Traces:
- **P99 Latency**: 99% of requests complete within target latency
- **Request Success Rate**: % of successful requests (StatusCode = 1)
- **Request Error Rate**: % of failed requests

**User Experience**:
```
1. Select a template
2. Enter service name (e.g., "checkout-service")
3. For latency: Set target (e.g., 200ms)
4. Click "Apply Template"
5. Done! ✅
```

### 2. **Custom Builder Mode** 🔧

Visual condition builder with:

#### Base Filter Builder
- Dropdown selection for fields (ServiceName, Duration, SpanName, etc.)
- Visual operator selection (equals, contains, less than, etc.)
- Smart value inputs (numbers vs strings)
- Add/remove multiple conditions
- Real-time SQL preview

#### Success Criteria Builder
- Same visual approach for defining "good" events
- Suggestions based on metric type and source table
- Field descriptions and examples

**Example Flow**:
```
Base Filter:
  [ServiceName] [equals] [checkout-service]
  [SpanName] [contains] [/api/]
  
Success Criteria:
  [StatusCode] [equals] [1]
  [Duration] [less than] [200]
```

### 3. **Smart Context Awareness** 🧠

The builder adapts based on:

**Source Table Selected**:
- **Logs**: Shows SeverityNumber, SeverityText, Body, LogAttributes
- **Traces**: Shows StatusCode, Duration, SpanName, SpanAttributes

**Metric Type Selected**:
- **Latency**: Suggests Duration fields, shows latency input
- **Availability**: Focuses on StatusCode or SeverityNumber
- **Error Rate**: Similar to availability with inverted logic

**Field Type Detection**:
- **String fields**: Shows "equals", "contains", "not contains" operators
- **Number fields**: Shows "<", "<=", ">", ">=", "=" operators
- **Auto-quotes**: Handles SQL quoting automatically

### 4. **Helpful Guidance** 💡

#### Visual Alerts:
- Blue info boxes explaining what logs vs traces are used for
- Recommendations for each metric type
- Template descriptions with use cases

#### Live SQL Preview:
- See generated SQL before applying
- Understand what the builder creates
- Learn SQL syntax patterns

#### Smart Defaults:
- Templates start with common patterns
- Service name is required (prevents mistakes)
- Latency defaults to 200ms (reasonable starting point)

### 5. **Error Prevention** 🛡️

- **Required fields**: Can't submit without service name
- **Validation**: Ensures conditions are complete
- **Visual feedback**: Green success alerts when conditions are generated
- **Preview before create**: See exactly what will be created

## 📊 Comparison

| Feature | Old Builder | New Builder |
|---------|-------------|-------------|
| Write SQL | ✅ Required | ❌ Optional |
| Know field names | ✅ Required | ❌ Dropdowns provided |
| Understand operators | ✅ Required | ❌ Visual selection |
| Syntax errors | ⚠️ Common | ✅ Prevented |
| Templates | ❌ None | ✅ 5 presets |
| Context-aware | ❌ No | ✅ Yes (logs vs traces) |
| Real-time preview | ❌ No | ✅ Yes |
| Learning curve | 📈 High | 📉 Low |

## 🎨 User Experience Flow

### Beginner User (Template Mode)
```
1. Open "Create SLO" modal
2. See: "Use Template ✨" (selected by default)
3. Choose metric type (Availability/Latency/Error Rate)
4. Select data source (Logs/Traces)
5. See recommended template auto-selected
6. Enter service name: "my-api"
7. [If latency] Set target: 300ms
8. Preview SQL in accordion
9. Click "Apply Template"
10. Review and click "Create SLO"
```
**Time**: ~1 minute, **SQL Knowledge**: None needed

### Advanced User (Custom Builder Mode)
```
1. Switch to "Custom Builder 🔧"
2. Add conditions visually:
   - ServiceName = 'my-api'
   - SpanName LIKE '%/checkout%'
3. Add success criteria:
   - StatusCode = 1
   - Duration < 500
4. See SQL preview update in real-time
5. Click "Apply Custom Conditions"
6. Review and create
```
**Time**: ~2 minutes, **SQL Knowledge**: Minimal

### Expert User (Raw SQL Mode)
```
1. Switch to "Raw SQL"
2. Write custom queries
3. Full control for complex cases
```
**Time**: Variable, **SQL Knowledge**: Required

## 🚀 Benefits

### For Users:
- ✅ **Faster SLO creation** (1 min vs 5+ min)
- ✅ **Fewer errors** (visual validation)
- ✅ **Better understanding** (see what's generated)
- ✅ **Learn by doing** (templates teach patterns)
- ✅ **Confidence** (preview before creating)

### For Product:
- ✅ **Lower barrier to entry** (more SLO adoption)
- ✅ **Fewer support tickets** (self-explanatory UI)
- ✅ **Best practices** (templates encode good patterns)
- ✅ **Faster time to value** (quick wins)

### For Development:
- ✅ **Type-safe** (no linter errors)
- ✅ **Maintainable** (clear component structure)
- ✅ **Extensible** (easy to add more templates)
- ✅ **Reusable** (builder component can be used elsewhere)

## 📝 Example Templates

### Trace-Based Latency SLO
```typescript
Template: "P99 Latency"
Input: 
  - Service: "checkout-service"
  - Target: 200ms

Generated:
  Filter: "ServiceName = 'checkout-service' AND SpanKind = 'SPAN_KIND_SERVER'"
  Condition: "StatusCode = 1 AND Duration < 200"
  
Meaning: "99% of checkout requests should succeed and complete in under 200ms"
```

### Log-Based Error Rate SLO
```typescript
Template: "Log Error Rate"
Input: 
  - Service: "api-gateway"

Generated:
  Filter: "ServiceName = 'api-gateway'"
  Condition: "SeverityNumber < 17"
  
Meaning: "99.9% of logs from api-gateway should be non-errors (INFO level or below)"
```

## 🎯 Next Steps (Future Enhancements)

1. **Service Name Autocomplete**: Fetch available services from ClickHouse
2. **Real-time Event Count**: Show "~1.2M events match your filter"
3. **Historical Preview**: "Based on last 7 days, your SLO would be at 99.7%"
4. **More Templates**: Add journey-based, composite, and multi-service SLOs
5. **Template Marketplace**: Community-contributed SLO patterns
6. **AI Suggestions**: "Based on your service, we recommend..."

## 🏁 Conclusion

The new builder transforms SLO creation from a SQL-writing exercise into a guided, visual experience. It empowers beginners while still serving advanced users, dramatically reducing the time and expertise needed to implement effective SLOs.

**Key Takeaway**: Users can now create production-ready SLOs in 60 seconds without writing a single line of SQL. 🎉

