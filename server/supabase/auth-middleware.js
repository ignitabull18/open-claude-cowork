import { getAdminClient } from './client.js';

const ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS === 'true';

/**
 * Express middleware that validates a Supabase JWT from the Authorization header.
 * Sets req.user = { id, email, role } on success.
 * Falls back to anonymous identity when ALLOW_ANONYMOUS=true and no token is provided.
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token) {
    try {
      const admin = getAdminClient();
      const { data: { user }, error } = await admin.auth.getUser(token);
      if (error || !user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      req.user = { id: user.id, email: user.email, role: user.role };
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Auth verification failed' });
    }
  }

  // No token provided
  if (ALLOW_ANONYMOUS) {
    req.user = { id: 'anonymous', email: null, role: 'anon' };
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
}
