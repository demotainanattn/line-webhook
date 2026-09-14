import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || 3000);
const lineReplyUrl = "https://api.line.me/v2/bot/message/reply";

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sign(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

function timingSafeEqual(a, b) {
  if (!a || !b || Buffer.byteLength(a) !== Buffer.byteLength(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function verifyLineSignature(rawBody, channelSecret, signature) {
  if (!channelSecret || !signature) return false;
  return timingSafeEqual(sign(channelSecret, rawBody), signature);
}

async function replyLineMessage(replyToken, messages) {
  if (!replyToken || !process.env.LINE_CHANNEL_ACCESS_TOKEN) return;
  const response = await fetch(lineReplyUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ replyToken, messages })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`LINE reply failed HTTP ${response.status}: ${detail}`);
  }
}

function textMessage(text) {
  return [{ type: "text", text: String(text || "LINE 事件已接收").slice(0, 5000) }];
}

async function forwardToGateway(rawBody) {
  const gatewayBaseUrl = String(process.env.GATEWAY_BASE_URL || "").replace(/\/$/, "");
  const sharedSecret = process.env.GATEWAY_SHARED_SECRET || "";
  if (!gatewayBaseUrl || !sharedSecret) {
    throw new Error("Render 環境變數缺少 GATEWAY_BASE_URL 或 GATEWAY_SHARED_SECRET");
  }

  const response = await fetch(`${gatewayBaseUrl}/api/worker/line/events`, {
