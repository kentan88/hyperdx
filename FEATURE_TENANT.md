# Create a new tenant
curl -X POST http://localhost:8080/tenants \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corporation",
    "slug": "acme",
    "isActive": true,
    "settings": {
      "maxUsers": 100,
      "features": ["analytics", "reporting"]
    }
  }'

# Get all tenants
curl http://localhost:8080/tenants

# Get tenant by ID
curl http://localhost:8080/tenants/:tenantId

# Update tenant
curl -X PUT http://localhost:8080/tenants/:tenantId \
  -H "Content-Type: application/json" \
  -d '{"isActive": false}'

# Delete tenant
curl -X DELETE http://localhost:8080/tenants/:tenantId