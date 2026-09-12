/* Vercel serverless function — footer/newsletter email signup.
 *
 * Fixes a real bug: the footer form previously POSTed directly to
 * Mailchimp's own hosted embedded-form endpoint. That correctly adds the
 * contact to the audience (confirmed: ~15 real signups already exist as
 * Mailchimp contacts) but only sends a welcome email via Mailchimp's own
 * "Automation" feature -- a paid-plan-only feature that was never active,
 * so no welcome email was ever actually sent. Same root cause already
 * fixed for the generator unlock flow (see /api/unlock-generators.js).
 *
 * POST { email } ->
 *   1. Add/update the email as a Mailchimp audience member (idempotent --
 *      PUT /members/{md5(email)} upserts, so an existing subscriber never
 *      errors, it's just updated -- same approach /api/unlock-generators.js
 *      already uses for the same audience).
 *   2. Send a welcome email via Resend from Kibbo <hello@getkibbo.com> --
 *      general newsletter-signup copy, distinct from the generator unlock
 *      flow's own welcome email.
 *
 * This file is a DELIBERATELY SEPARATE, independent implementation from
 * /api/unlock-generators.js -- not a shared import from it, and not a
 * refactor of it into a shared module either. The generator unlock flow is
 * live, already correct, and explicitly out of scope to touch for this
 * fix; keeping this fully self-contained means nothing here can affect
 * that flow even indirectly through shared code, which matters more here
 * than avoiding the small amount of duplication between the two files.
 *
 * Both calls are independent and best-effort, same philosophy as
 * unlock-generators.js: a Mailchimp or Resend hiccup must never surface as
 * an error to someone just trying to sign up. Every failure is logged
 * server-side (visible in Vercel's function logs); the response is always
 * { success: true } once the email itself is well-formed.
 *
 * Requires MAILCHIMP_API_KEY, MAILCHIMP_AUDIENCE_ID, RESEND_API_KEY -- the
 * SAME Vercel environment variables /api/unlock-generators.js already uses
 * (same Mailchimp audience, same Resend account), already configured.
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
        console.error('[newsletter-signup] Mailchimp error', mcRes.status, detail);
        results.mailchimp = 'error';
      }
    } catch (err) {
      console.error('[newsletter-signup] Mailchimp exception', err && err.message);
      results.mailchimp = 'error';
    }
  } else {
    console.error('[newsletter-signup] MAILCHIMP_API_KEY/MAILCHIMP_AUDIENCE_ID not configured');
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
          subject: 'Welcome to Kibbo',
          html:
            '<p>Hi,</p>' +
            "<p>Thanks for signing up. You'll hear from us with new guides, tools, and consumer rights updates as they go live.</p>" +
            '<p>In the meantime, take a look around: <a href="https://getkibbo.com">https://getkibbo.com</a></p>' +
            '<p>— The Kibbo team</p>',
        }),
      });
      if (resendRes.ok) {
        results.resend = 'ok';
      } else {
        const detail = await resendRes.text().catch(() => '');
        console.error('[newsletter-signup] Resend error', resendRes.status, detail);
        results.resend = 'error';
      }
    } catch (err) {
      console.error('[newsletter-signup] Resend exception', err && err.message);
      results.resend = 'error';
    }
  } else {
    console.error('[newsletter-signup] RESEND_API_KEY not configured');
  }

  // Always report success once the email itself validated -- never surface
  // a backend hiccup with either external service as an error to the user.
  res.status(200).json({ success: true, results: results });
};
