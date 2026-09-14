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
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gateway-signature": sign(sharedSecret, rawBody)
    },
    body: rawBody
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Gateway 回應 HTTP ${response.status}`);
  }
  return payload;
}

async function handleWebhook(req, res) {
  const required = [
    "LINE_CHANNEL_SECRET",
    "LINE_CHANNEL_ACCESS_TOKEN",
    "GATEWAY_BASE_URL",
    "GATEWAY_SHARED_SECRET"
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    json(res, 500, { error: `缺少環境變數：${missing.join(", ")}` });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!verifyLineSignature(rawBody, process.env.LINE_CHANNEL_SECRET, req.headers["x-line-signature"])) {
    json(res, 401, { error: "LINE webhook 簽章驗證失敗" });
    return;
  }

  const payload = JSON.parse(rawBody || "{}");
  let gatewayResult;
  try {
    gatewayResult = await forwardToGateway(rawBody);
  } catch (error) {
    console.error(error);
    gatewayResult = { results: [`Gateway 轉送失敗：${error.message}`] };
  }

  const events = payload.events || [];
  await Promise.all(events.map((event, index) => {
    const result = gatewayResult.results?.[index] || "LINE 事件已接收";
    return replyLineMessage(event.replyToken, textMessage(result));
  }));

  json(res, 200, { ok: true, results: gatewayResult.results || [] });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      json(res, 200, { ok: true, service: "line-webhook-render-forwarder" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, service: "line-webhook-render-forwarder" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      await handleWebhook(req, res);
      return;
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(port, () => {
  console.log(`LINE webhook forwarder running on port ${port}`);
});
