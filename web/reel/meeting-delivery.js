import { internalEmail } from "./organization.js";

async function request({serviceURL, authorize, fetchImpl = fetch}, path, payload) {
  const token = await authorize();
  if (!token) throw new Error('Sign in as the meeting owner to deliver notes.');
  const response = await fetchImpl(serviceURL.replace(/\/$/, '') + path, {
    method: payload === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: {Authorization: 'Bearer ' + token, ...(payload === undefined ? {} : {'Content-Type':'application/json'})},
    ...(payload === undefined ? {} : {body: JSON.stringify(payload)}), signal: AbortSignal.timeout(180_000),
  });
  if (!await authorize()) throw new Error('The meeting owner changed; delivery was not confirmed.');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Delivery could not be confirmed. Retry to reconcile the existing page and recap.');
    if (response.status === 403 && data.code === 'calendar_selection_required') error.code = data.code;
    throw error;
  }
  return data;
}

export async function deliverMeeting(options) {
  const result = await request(options, '/delivery/complete', options.payload);
  let safeURL = false;
  try { const url = new URL(result.url); safeURL = url.protocol === 'https:' && ['www.notion.so','notion.so','app.notion.com'].includes(url.hostname); } catch {}
  if (result.verified !== true || result.email_status !== 'confirmed' || !safeURL || !result.page_id ||
      !Array.isArray(result.recipients) || result.recipients.some(email => !internalEmail(email, options.allowedEmailDomain))) {
    throw new Error('Meeting delivery did not return verified Notion and recap receipts.');
  }
  return result;
}

export async function listDeliveryCalendar(options) {
  const result = await request(options, '/delivery/calendar');
  if (!Array.isArray(result.events)) throw new Error('Calendar invitations could not be read.');
  return result.events;
}
