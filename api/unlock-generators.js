/* Vercel serverless function — replaces Gumroad/license-key verification
 * for generators with a single email-capture unlock, shared across every
 * generator on the site.
 *
 * POST { email } ->
 *   1. Add/update the email as a Mailchimp audience member (idempotent --
 *      PUT /members/{md5(email)} upserts, so an existing subscriber never
 *      errors, it's just updated).
 *   2. Send a welcome email via Resend from Kibbo <hello@getkibbo.com>.
 *
 * Both calls are independent and best-effort: per the product spec, a
 * single backend hiccup (Mailchimp down, Resend down, a missing env var)
 * must never block the user from unlocking. Every failure is logged
 * server-side (visible in Vercel's function logs) for debugging, but the
 * response is always { success: true } once the email itself is
 * well-formed -- the frontend sets its unlock flag unconditionally on any
 * 200 response (and even on a network failure to this endpoint, as a
 * final fallback -- see generator-engine.js).
 *
 * Requires MAILCHIMP_API_KEY, MAILCHIMP_AUDIENCE_ID, RESEND_API_KEY as
 * Vercel environment variables (already configured — never hardcode these).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const email = ((body && body.email) || '').toString().trim().toLowerCase();

  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'invalid_email', message: 'Please provide a valid email address.' });
    return;
  }

  const results = { mailchimp: 'skipped', resend: 'skipped' };

  // ---- 1. Mailchimp: add-or-update the contact ----
  const mcKey = process.env.MAILCHIMP_API_KEY;
  const mcAudienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (mcKey && mcAudienceId) {
    try {
      const dc = mcKey.split('-')[1];
      if (!dc) throw new Error('MAILCHIMP_API_KEY is missing its datacenter suffix (expected ...-usXX)');
      const hash = require('crypto').createHash('md5').update(email).digest('hex');
      const mcRes = await fetch(
        `https://${dc}.api.mailchimp.com/3.0/lists/${mcAudienceId}/members/${hash}`,
        {
          method: 'PUT', // upsert: creates if new, updates (never errors) if the email already exists in the audience
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from('anystring:' + mcKey).toString('base64'),
          },
          body: JSON.stringify({
            email_address: email,
            status_if_new: 'subscribed',
          }),
        }
      );
      if (mcRes.ok) {
        results.mailchimp = 'ok';
      } else {
        const detail = await mcRes.text().catch(() => '');
        console.error('[unlock-generators] Mailchimp error', mcRes.status, detail);
        results.mailchimp = 'error';
      }
    } catch (err) {
      console.error('[unlock-generators] Mailchimp exception', err && err.message);
      results.mailchimp = 'error';
    }
  } else {
    console.error('[unlock-generators] MAILCHIMP_API_KEY/MAILCHIMP_AUDIENCE_ID not configured');
  }

  // ---- 2. Resend: send the welcome email ----
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + resendKey,
        },
        body: JSON.stringify({
          from: 'Kibbo <hello@getkibbo.com>',
          to: [email],
          subject: "You're all set — full access to Kibbo's generators",
          html:
            '<p>Hi,</p>' +
            '<p>Thanks for signing up. You now have full access to every generator on Kibbo — no more previews, just complete letters and documents ready to use.</p>' +
            '<p>Head back here to keep going: <a href="https://getkibbo.com/generate.html">https://getkibbo.com/generate.html</a></p>' +
            '<p>If you have any questions, just reply to this email.</p>' +
            '<p>— The Kibbo team</p>',
        }),
      });
      if (resendRes.ok) {
        results.resend = 'ok';
      } else {
        const detail = await resendRes.text().catch(() => '');
        console.error('[unlock-generators] Resend error', resendRes.status, detail);
        results.resend = 'error';
      }
    } catch (err) {
      console.error('[unlock-generators] Resend exception', err && err.message);
      results.resend = 'error';
    }
  } else {
    console.error('[unlock-generators] RESEND_API_KEY not configured');
  }

  // Always unlock client-side once the email itself validated -- never
  // block access over a backend hiccup with either external service.
  res.status(200).json({ success: true, results: results });
};
