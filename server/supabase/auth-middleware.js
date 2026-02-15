import { getAdminClient } from './client.js';

const ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS === 'true';

/** Parse ADMIN_EMAILS env var into a Set of lowercased email addresses. */
function getAdminEmails() {
  const raw = process.env.ADMIN_EMAILS;
  if (!raw) return new Set();
  return new Set(raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
}

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

/**
 * Express middleware that checks whether the authenticated user is an admin.
 * Must be chained after requireAuth (reads req.user.email).
 * Returns 403 if the user's email is not in the ADMIN_EMAILS env var.
 */
export function requireAdmin(req, res, next) {
  const adminEmails = getAdminEmails();
  if (adminEmails.size === 0) {
    return res.status(403).json({ error: 'No admin emails configured' });
  }
  const email = req.user?.email;
  if (!email || !adminEmails.has(email.toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

/**
 * Check if the current user is an admin (non-middleware helper).
 */
export function isAdmin(email) {
  if (!email) return false;
  const adminEmails = getAdminEmails();
  return adminEmails.has(email.toLowerCase());
}
