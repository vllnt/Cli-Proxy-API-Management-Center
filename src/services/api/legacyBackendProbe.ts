import { normalizeApiBase } from '@/utils/connection';
import { isRecord } from '@/utils/helpers';
import { httpRequest } from './http';

/** Diagnostic only: never use v0 responses as application data or a login fallback. */
export class LegacyBackendError extends Error {
  constructor() {
    super('The backend supports v0 management but not v8 management');
    this.name = 'LegacyBackendError';
  }
}

export async function probeLegacyBackend(apiBase: string, managementKey: string): Promise<boolean> {
  const base = normalizeApiBase(apiBase);
  if (!base || !managementKey) return false;

  try {
    // Plain transport, not apiClient: this must not affect the v8 client's auth or version events.
    const response = await httpRequest('GET', `${base}/v0/management/config`, {
      headers: { Authorization: `Bearer ${managementKey}` },
      timeout: 3000,
    });
    return isRecord(response.data);
  } catch {
    // Includes 401, 403, network errors and missing v0 routes: none proves an old backend.
    return false;
  }
}
