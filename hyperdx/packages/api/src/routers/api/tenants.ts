import express from 'express';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';

import {
  createTenant,
  deleteTenant,
  getTenantById,
  getTenants,
  updateTenant,
} from '@/controllers/tenant';

const router = express.Router();

// Schema validation
const TenantSchema = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  apiKey: z.string().optional(),
  isActive: z.boolean().optional(),
  settings: z.record(z.any()).optional(),
});

// GET /tenants - Get all tenants
router.get('/', async (req, res, next) => {
  try {
    const tenants = await getTenants();
    res.json(tenants.map(t => t.toJSON({ virtuals: true })));
  } catch (e) {
    next(e);
  }
});

// GET /tenants/:id - Get tenant by ID
router.get('/:id', async (req, res, next) => {
  try {
    const tenant = await getTenantById(req.params.id);

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    res.json(tenant.toJSON({ virtuals: true }));
  } catch (e) {
    next(e);
  }
});

// POST /tenants - Create new tenant
router.post(
  '/',
  validateRequest({
    body: TenantSchema.omit({ apiKey: true }),
  }),
  async (req, res, next) => {
    try {
      const tenant = await createTenant(req.body);
      res.status(201).json({ id: tenant._id.toString() });
    } catch (e) {
      next(e);
    }
  },
);

// PUT /tenants/:id - Update tenant
router.put(
  '/:id',
  validateRequest({
    body: TenantSchema.partial(),
  }),
  async (req, res, next) => {
    try {
      const tenant = await getTenantById(req.params.id);

      if (!tenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      const updatedTenant = await updateTenant(req.params.id, req.body);

      if (!updatedTenant) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }

      res.status(200).json(updatedTenant.toJSON({ virtuals: true }));
    } catch (e) {
      next(e);
    }
  },
);

// DELETE /tenants/:id - Delete tenant
router.delete('/:id', async (req, res, next) => {
  try {
    const tenant = await deleteTenant(req.params.id);

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    res.status(200).json({ message: 'Tenant deleted successfully' });
  } catch (e) {
    next(e);
  }
});

export default router;

