import { getAdminClient } from './client.js';
import crypto from 'crypto';


/** Parse ADMIN_EMAILS env var into a Set of lowercased email addresses. */
function getAdminEmails() {
  const raw = process.env.ADMIN_EMAILS;
  if (!raw) return new Set();
  return new Set(raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
}

function getAnonymousSessionId(req) {
  const explicit = req?.get?.('x-anon-session-id');
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  const ip = req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown-ip';
  const ua = req?.get?.('user-agent') || 'unknown-ua';
  return crypto.createHash('sha256')
    .update(`${ip}|${ua}`)
    .digest('hex')
    .slice(0, 16);
}

function getActorUserId(req) {
  if (req?.user?.id !== 'anonymous') return req?.user?.id;
  return `anonymous:${getAnonymousSessionId(req)}`;
}

/**
 * Express middleware that validates a Supabase JWT from the Authorization header.
 * Sets req.user = { id, email, role } on success.
 * No anonymous fallback is allowed here.
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
