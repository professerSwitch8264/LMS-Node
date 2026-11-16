const nodemailer = require('nodemailer');

let transporter = null;

function getMailConfig() {
  return {
    host: String(process.env.SMTP_HOST || '').trim(),
    port: Number(process.env.SMTP_PORT) || 587,
    user: String(process.env.SMTP_USER || '').trim(),
    pass: String(process.env.SMTP_PASS || ''),
    from: String(process.env.MAIL_FROM || '').trim(),
  };
}

function isMailConfigured() {
  const c = getMailConfig();
  return Boolean(c.host && c.user && c.pass && c.from);
}

function getTransporter() {
  if (transporter) return transporter;
  const c = getMailConfig();
  transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465,
    requireTLS: c.port !== 465,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  return transporter;
}

async function sendMail({ to, subject, html, text, attachments }) {
  if (!isMailConfigured()) {
    const err = new Error('SMTP is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS / MAIL_FROM)');
    err.code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  return getTransporter().sendMail({ from: getMailConfig().from, to, subject, html, text, attachments });
}

module.exports = { sendMail, isMailConfigured };
