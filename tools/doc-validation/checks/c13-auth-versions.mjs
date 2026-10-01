// Finding 8: role change invalidates admin sessions only; block / global logout invalidates both audiences.
import { pool, val, eq } from '../lib/db.mjs';

export default {
  id: 'C13', title: 'Auth versions: role change keeps storefront session, kills admin session; block kills both',
  async run({ cfg }) {
    const db = pool(cfg);
    try {
      const u = await val(db, `INSERT INTO users (email, role, status, updated_at) VALUES ('staff@artq.in','STAFF','ACTIVE',now()) RETURNING id`);
      const mk = (aud) => val(db, `INSERT INTO sessions (user_id, audience, auth_version, idle_expires_at, absolute_expires_at)
        SELECT id, $2::"SessionAudience", CASE WHEN $2 = 'ADMIN' THEN admin_auth_version ELSE storefront_auth_version END,
               now() + interval '1 day', now() + interval '7 days' FROM users WHERE id = $1 RETURNING id`, [u, aud]);
      const sf = await mk('STOREFRONT'), ad = await mk('ADMIN');
      const valid = async () => [await val(db, `SELECT aq_session_valid($1)`, [sf]), await val(db, `SELECT aq_session_valid($1)`, [ad])];
      eq(await valid(), [true, true], 'initial');
      await db.query(`SELECT aq_change_role($1,'ADMIN')`, [u]);
      eq(await valid(), [true, false], 'after role change');
      const ad2 = await mk('ADMIN');
      eq(await val(db, `SELECT aq_session_valid($1)`, [ad2]), true, 'new admin session after re-login');
      await db.query(`SELECT aq_change_role($1,'CUSTOMER')`, [u]);
      eq(await val(db, `SELECT aq_session_valid($1)`, [ad2]), false, 'demoted to customer');
      const ad3 = await mk('ADMIN');
      eq(await val(db, `SELECT aq_session_valid($1)`, [ad3]), false, 'customer role cannot hold admin session');
      await db.query(`SELECT aq_revoke_all_sessions($1,'BLOCKED',true)`, [u]);
      eq(await valid(), [false, false], 'after block');
      return 'role change: storefront valid, admin invalid; re-login works; CUSTOMER role cannot hold admin session; block: both invalid';
    } finally { await db.end(); }
  },
};
