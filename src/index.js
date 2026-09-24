/**
 * Barwaqo Forum — Cloudflare Worker (single-Worker architecture)
 * ---------------------------------------------------------------------
 * Static files (index.html, admin.html) are served automatically by
 * Cloudflare Workers Assets from the ./public directory — no HTML is
 * embedded in this script. This Worker only handles the dynamic API:
 *
 *   POST /api/contact  Save a contact-form submission to Supabase and
 *                       email it to info@barwaqoforum.org via Resend,
 *                       with Reply-To set to the visitor's address.
 *   GET  /api/health    Simple liveness check.
 *
 * Required secrets (already set on the live Worker):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
 * Required plain-text vars: CONTACT_TO_EMAIL, CONTACT_FROM_EMAIL, ALLOWED_ORIGIN
 * Required binding: RATE_LIMIT_KV (KV namespace)
 * ---------------------------------------------------------------------
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(env) },
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function checkRateLimit(env, ip, limit = 5, windowSeconds = 600) {
  if (!env.RATE_LIMIT_KV) return true;
  const key = `rl:${ip}`;
  const raw = await env.RATE_LIMIT_KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) return false;
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: windowSeconds });
  return true;
}

async function handleContact(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' }, 400, env);
  }

  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim();
  const subject = (body.subject || '').toString().trim() || 'Website Contact Form';
  const message = (body.message || '').toString().trim();
  const honeypot = (body.company || '').toString().trim();

  if (honeypot) {
    return jsonResponse({ ok: true }, 200, env);
  }

  if (!name || name.length > 200) {
    return jsonResponse({ ok: false, error: 'Please provide a valid name.' }, 400, env);
  }
  if (!email || !isValidEmail(email) || email.length > 320) {
    return jsonResponse({ ok: false, error: 'Please provide a valid email address.' }, 400, env);
  }
  if (!message || message.length < 5 || message.length > 5000) {
    return jsonResponse({ ok: false, error: 'Please provide a message (5-5000 characters).' }, 400, env);
  }
  if (subject.length > 300) {
    return jsonResponse({ ok: false, error: 'Subject is too long.' }, 400, env);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = await checkRateLimit(env, ip, 5, 600);
  if (!allowed) {
    return jsonResponse({ ok: false, error: 'Too many requests. Please try again later.' }, 429, env);
  }

  const ipHash = ip !== 'unknown' ? await sha256Hex(ip + (env.SUPABASE_SERVICE_ROLE_KEY || '')) : null;

  let savedRow;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/contact_messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify([{ name, email, subject, message, ip_hash: ipHash }]),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('Supabase insert failed:', res.status, errText);
      return jsonResponse(
        { ok: false, error: 'Could not save your message right now. Please try again shortly.' },
        502,
        env
      );
    }
    const rows = await res.json();
    savedRow = rows[0];
  } catch (err) {
    console.error('Supabase insert threw:', err);
    return jsonResponse(
      { ok: false, error: 'Could not save your message right now. Please try again shortly.' },
      502,
      env
    );
  }

  let emailSent = false;
  try {
    const submittedAt = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Mogadishu' });
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#0F231A;">New Contact Form Submission</h2>
        <table cellpadding="8" style="border-collapse: collapse; width: 100%;">
          <tr><td style="font-weight:bold; width:120px;">Name</td><td>${escapeHtml(name)}</td></tr>
          <tr><td style="font-weight:bold;">Email</td><td>${escapeHtml(email)}</td></tr>
          <tr><td style="font-weight:bold;">Subject</td><td>${escapeHtml(subject)}</td></tr>
          <tr><td style="font-weight:bold;">Date</td><td>${escapeHtml(submittedAt)}</td></tr>
        </table>
        <p style="font-weight:bold; margin-top:16px;">Message:</p>
        <p style="white-space: pre-wrap; border-left:3px solid #008751; padding-left:12px;">${escapeHtml(message)}</p>
        <p style="color:#888; font-size:12px; margin-top:24px;">Reply directly to this email to respond to ${escapeHtml(name)}.</p>
      </div>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.CONTACT_FROM_EMAIL || 'Barwaqo Forum <info@barwaqoforum.org>',
        to: [env.CONTACT_TO_EMAIL || 'info@barwaqoforum.org'],
        reply_to: email,
        subject: `[Website] ${subject}`,
        html,
      }),
    });

    emailSent = emailRes.ok;
    if (!emailRes.ok) {
      const errText = await emailRes.text().catch(() => '');
      console.error('Resend send failed:', emailRes.status, errText);
    }
  } catch (err) {
    console.error('Resend send threw:', err);
  }

  if (savedRow && savedRow.id) {
    try {
      await fetch(`${env.SUPABASE_URL}/rest/v1/contact_messages?id=eq.${savedRow.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ email_sent: emailSent }),
      });
    } catch (err) {
      console.error('Supabase status update threw:', err);
    }
  }

  return jsonResponse({ ok: true }, 200, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({ ok: true, service: 'barwaqo-worker' }, 200, env);
    }

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      return handleContact(request, env);
    }

    // Everything else (/, /admin.html, /images, etc.) is served
    // automatically by Cloudflare Workers Assets from ./public —
    // this fetch handler is only reached for unmatched API routes.
    return jsonResponse({ ok: false, error: 'Not found.' }, 404, env);
  },
};