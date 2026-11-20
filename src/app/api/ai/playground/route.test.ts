import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ roles: [] as string[] }));

vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) },
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async (rol: string) => {
    h.roles.push(rol);
    throw Object.assign(new Error('prohibido'), { status: 403 });
  },
  toErrorResponse: (err: { status?: number }) => ({ body: { error: 'x' }, status: err.status ?? 500 }),
}));

import { POST } from './route';

describe('POST /api/ai/playground', () => {
  it('es solo de la dirección: pide el rol admin antes de todo', async () => {
    const r = (await POST(new Request('http://t', { method: 'POST', body: '{}' }))) as unknown as { status: number };
    expect(h.roles).toEqual(['admin']);
    expect(r.status).toBe(403);
  });
});
