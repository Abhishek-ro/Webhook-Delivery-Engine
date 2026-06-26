import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { pool } from '../../db/pool.js';
import { AppError } from '../errors.js';
import { config } from '../../shared/config.js';

const createSchema = z.object({
  client_id: z.string().min(1).max(255),
  url: z.string().url(),
  signing_secret: z.string().optional(),
});

const patchSchema = z.object({
  is_active: z.boolean().optional(),
  url: z.string().url().optional(),
});

interface EndpointRow {
  id: string;
  client_id: string;
  url: string;
  signing_secret: string;
  is_active: boolean;
  created_at: string;
}

export async function endpointsRoutes(app: FastifyInstance) {
  app.post('/endpoints', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', { issues: parsed.error.issues });

    const { client_id, url, signing_secret: provided } = parsed.data;

    if (config.NODE_ENV === 'production' && !url.startsWith('https://')) {
      throw new AppError(400, 'INVALID_URL', 'Endpoint URL must use HTTPS in production');
    }

    const secret = provided ?? `whsec_${randomBytes(32).toString('hex')}`;

    const result = await pool.query<EndpointRow>(
      `INSERT INTO endpoints (client_id, url, signing_secret)
       VALUES ($1, $2, $3)
       RETURNING id, client_id, url, signing_secret, is_active, created_at`,
      [client_id, url, secret]
    );

    return reply.code(201).send(result.rows[0]);
  });

  app.get('/endpoints', async (req) => {
    const { client_id } = req.query as { client_id?: string };

    const result = client_id
      ? await pool.query<EndpointRow>(
          `SELECT id, client_id, url, signing_secret, is_active, created_at
           FROM endpoints WHERE client_id = $1 ORDER BY created_at DESC`,
          [client_id]
        )
      : await pool.query<EndpointRow>(
          `SELECT id, client_id, url, signing_secret, is_active, created_at
           FROM endpoints ORDER BY created_at DESC`
        );

    return { data: result.rows };
  });

  app.patch('/endpoints/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', { issues: parsed.error.issues });

    const { is_active, url } = parsed.data;
    if (is_active === undefined && url === undefined) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Provide at least one of: is_active, url');
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (is_active !== undefined) { sets.push(`is_active = $${i++}`); values.push(is_active); }
    if (url !== undefined)       { sets.push(`url = $${i++}`);       values.push(url); }
    values.push(id);

    const result = await pool.query<EndpointRow>(
      `UPDATE endpoints SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      throw new AppError(404, 'ENDPOINT_NOT_FOUND', `Endpoint ${id} not found`);
    }

    return reply.code(200).send(result.rows[0]);
  });
}
