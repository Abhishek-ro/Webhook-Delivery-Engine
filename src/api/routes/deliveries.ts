import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { list, getDetail } from '../../db/deliveries.repo.js';
import type { DeliveryListFilters } from '../../db/deliveries.repo.js';
import { AppError } from '../errors.js';
import { encodeCursor, decodeCursor } from '../cursor.js';

const VALID_STATUSES = ['PENDING', 'DELIVERING', 'DELIVERED', 'FAILED', 'DLQ'] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

const listQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter((s): s is ValidStatus => VALID_STATUSES.includes(s as ValidStatus))
        : [],
    ),
  endpoint_id: z.string().uuid().optional(),
  from: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  to: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  limit: z.coerce.number().int().min(1).max(200).default(50).catch(50),
  cursor: z.string().optional(),
});

export async function deliveriesRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/deliveries
  app.get('/deliveries', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query parameters', {
        issues: parsed.error.issues,
      });
    }

    const { status, endpoint_id, from, to, limit, cursor: cursorStr } = parsed.data;

    let cursor: { updatedAt: string; id: string } | null = null;
    if (cursorStr) {
      cursor = decodeCursor(cursorStr);
    }

    // Build filters without undefined keys (exactOptionalPropertyTypes)
    const filters: DeliveryListFilters = { statuses: status };
    if (endpoint_id) filters.endpointId = endpoint_id;
    if (from) filters.from = from;
    if (to) filters.to = to;

    const { rows, hasMore } = await list(filters, cursor, limit);

    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1]!;
      nextCursor = encodeCursor({
        updatedAt: last.updated_at.toISOString(),
        id: last.id,
      });
    }

    return reply.send({ data: rows, next_cursor: nextCursor });
  });

  // GET /v1/deliveries/:id
  app.get('/deliveries/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new AppError(404, 'DELIVERY_NOT_FOUND', 'Delivery ' + id + ' not found');
    }

    const detail = await getDetail(id);
    if (!detail) {
      throw new AppError(404, 'DELIVERY_NOT_FOUND', 'Delivery ' + id + ' not found');
    }

    return reply.send(detail);
  });
}
