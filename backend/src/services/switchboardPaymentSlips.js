const { createHash } = require('node:crypto');
const config = require('../config');
const slips = require('./xeroPaymentSlips');

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const types = ['image/png','image/jpeg','application/pdf'];
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };

function connection(org) {
  const key = process.env.TANECHAT_SLIP_API_KEY?.trim();
  const assigned = process.env.TANECHAT_SLIP_ORG_ID?.trim();
  if (!key || assigned !== String(org)) fail('Direct Switchboard slips are not configured for this organisation.',503);
  const base = new URL(config.chat.taneChat.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    fail('The Switchboard slip connection needs a valid HTTPS address.',503);
  }
  base.pathname = base.pathname.replace(/\/+$/,'') + '/payment-slips';
  return { base,key };
}

async function request(org, suffix, params, limit, fetchImpl) {
  const { base,key } = connection(org);
  base.pathname += suffix;
  for (const [name,value] of Object.entries(params)) base.searchParams.set(name,value);
  let response;
  try {
    response = await fetchImpl(base,{ headers:{ 'X-API-Key':key,Accept:'application/json' },
      redirect:'error', signal:AbortSignal.timeout(10000) });
  } catch { fail('Could not reach the Switchboard slip integration.',502); }
  if (response.status===404 && suffix) fail('Switchboard no longer has that attachment available.',404);
  if (response.status===429) fail('Switchboard is busy. Try again shortly.',429);
  if (!response.ok || !response.body) fail('Switchboard slip access is unavailable. Check the integration setup.',502);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) fail('Switchboard returned an oversized attachment response.',502);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (error) {
    if (error.status) throw error;
    fail('Switchboard returned an invalid attachment response.',502);
  } finally { await reader.cancel().catch(()=>{}); }
}

function metadata(row) {
  if (!row || !UUID.test(row.message_id||'') || !UUID.test(row.attachment_id||'') ||
      !['email','whatsapp'].includes(row.channel) || !types.includes(row.type) ||
      !Number.isSafeInteger(row.size) || row.size < 1 || row.size > slips.MAX_BYTES ||
      !Number.isFinite(Date.parse(row.received_at))) return null;
  const { message_id,attachment_id,channel,type,size,received_at } = row;
  const conversationId = UUID.test(row.conversation_id || '') ? row.conversation_id : null;
  const senderName = typeof row.sender_name === 'string' ? row.sender_name.trim().slice(0, 180) : '';
  return { message_id,attachment_id,channel,type,size,received_at,
    ...(conversationId ? { conversation_id:conversationId } : {}),
    ...(senderName ? { sender_name:senderName } : {}),
    name:String(row.name||'payment-slip').slice(0,180) };
}

async function list(org,{ messageId, conversationId, date },fetchImpl=fetch) {
  for (const id of [messageId,conversationId]) {
    if (id != null && (typeof id !== 'string' || !UUID.test(id))) fail('Enter a Switchboard message or conversation ID.');
  }
  if (messageId && conversationId) fail('Choose a message or a conversation.');
  const day = date ? new Date(date+'T00:00:00Z') : null;
  if (!messageId && !conversationId && (!day || !Number.isFinite(day.getTime()))) fail('A bank date is required.');
  const offset = delta => new Date(day.getTime()+delta*86400000).toISOString().slice(0,10);
  const params = messageId ? { message_id:messageId } : conversationId ? { conversation_id:conversationId } : { from:offset(-7),to:offset(8) };
  const raw = await request(org,'',params,65536,fetchImpl);
  if (!Array.isArray(raw?.items)) fail('Switchboard did not return an attachment list.',502);
  return { items:raw.items.slice(0,20).map(metadata).filter(Boolean),truncated:raw.truncated===true };
}

async function download(org,messageId,attachmentId,fetchImpl=fetch) {
  if (typeof messageId!=='string' || typeof attachmentId!=='string' ||
      !UUID.test(messageId) || !UUID.test(attachmentId)) fail('Invalid Switchboard attachment.');
  const file = await request(org,`/${messageId}/${attachmentId}`,{},7*1024*1024,fetchImpl);
  const info = metadata(file);
  if (!info || info.message_id !== messageId || info.attachment_id !== attachmentId ||
      typeof file.base64!=='string' || !/^[0-9a-f]{64}$/.test(file.sha256||'')) {
    fail('Switchboard did not return the requested original.',502);
  }
  const bytes = Buffer.from(file.base64,'base64');
  if (bytes.length !== info.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    fail('Switchboard original could not be verified.',502);
  }
  return { info,file:{ buffer:bytes,mimetype:info.type,originalname:info.name } };
}

module.exports = { list, download };
