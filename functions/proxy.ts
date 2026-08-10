const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

// ================= 耀虎 API 配置 (酷狗源) =================
const YAOHUD_API_KEY = "Z2mDyU4rUTUEBbPYdbK";
// 🎯 已根据你提供的 PHP 示例更新 Secret Key
const YAOHUD_SECRET_KEY = "75da5a53198ed28ece7d1d4e9cf381d1";

/**
 * 辅助函数：生成 HMAC-SHA256 加密签名（严格对应 PHP 的 hash_hmac('sha256', $signString, $secretKey)）
 */
async function generateSignature(apiKey: string, secretKey: string, timestamp: number): Promise<string> {
  // PHP 规则：$signString = "key={$apiKey}&timestamp={$timestamp}";
  const signString = `key=${apiKey}&timestamp=${timestamp}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const msgData = encoder.encode(signString);

  // 使用 Web Crypto API 计算 HMAC-SHA256
  const cryptoKey = await crypto.subtle.importKey(
    "raw", 
    keyData, 
    { name: "HMAC", hash: "SHA-256" }, 
    false, 
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  
  // 转为 16 进制小写字符串
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * 处理酷狗音乐请求：向耀虎 API 发送带签名的加密 Headers 请求
 */
async function handleKugouApiRequest(url: URL, request: Request): Promise<Response | null> {
  const types = url.searchParams.get("types");
  
  // 兼容前端传参（name / keyword / s / id）
  const name = url.searchParams.get("name") || "";
  const keywordParam = url.searchParams.get("keyword") || "";
  const searchS = url.searchParams.get("s") || "";
  const id = url.searchParams.get("id") || "";
  const keyword = name || keywordParam || searchS || id;

  const isDebug = url.searchParams.get("debug") === "true";

  if (!keyword) {
    if (types === "search") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }
    return null;
  }

  const targetUrl = `https://api.yaohud.cn/api/music/kg?key=${YAOHUD_API_KEY}&msg=${encodeURIComponent(keyword)}&n=1&quality=320&type=json`;

  try {
    // 1. 获取当前秒级 UNIX 时间戳
    const timestamp = Math.floor(Date.now() / 1000);
    // 2. 生成 HMAC-SHA256 签名
    const signature = await generateSignature(YAOHUD_API_KEY, YAOHUD_SECRET_KEY, timestamp);

    // 3. 构建完全匹配 PHP 示例的请求头
    const headersConfig: Record<string, string> = {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "X-Api-Key": YAOHUD_API_KEY,
      "X-Api-Timestamp": timestamp.toString(),
      "X-Api-Sign": signature,
      "Content-Type": "application/json"
    };

    const upstream = await fetch(targetUrl, { headers: headersConfig });

    // 先读取文本内容，防止上游返回非 JSON（如网页拦截页）时导致程序崩溃
    const rawText = await upstream.text();
    let resData: any = null;

    try {
      resData = JSON.parse(rawText);
    } catch {
      console.error("[Kugou Upstream Raw Text Response]", rawText);
      return new Response(JSON.stringify({
        error: "耀虎 API 响应异常",
        details: rawText.trim()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 🎯 调试模式输出
    if (isDebug) {
      return new Response(JSON.stringify({
        debug_info: {
          requested_keyword: keyword,
          targetUrl,
          timestamp,
          signature,
          sent_headers: headersConfig,
          upstream_http_status: upstream.status
        },
        upstream_response: resData
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 判断响应状态 code (兼容数字 200 和字符串 "200")
    if (resData && (resData.code == 200 || resData.code == "200") && resData.data) {
      const info = resData.data;
      let resultData: any = null;

      if (types === "search") {
        resultData = [{
          id: `${info.name} - ${info.singer}`,
          name: info.name,
          artist: [info.singer],
          album: info.name,
          pic_id: `${info.name} - ${info.singer}`,
          url_id: `${info.name} - ${info.singer}`,
          lyric_id: `${info.name} - ${info.singer}`,
          source: "kugou"
        }];
      } else if (types === "url") {
        resultData = { url: info.play_url, br: 320 };
      } else if (types === "pic") {
        resultData = { url: info.cover };
      } else if (types === "lyric") {
        resultData = { lyric: info.lyric || "", tlyric: "" };
      }

      if (resultData !== null) {
        return new Response(JSON.stringify(resultData), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300"
          }
        });
      }
    }

    // 上游无数据时返回空数组
    if (types === "search") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response(JSON.stringify({ error: "未找到相关音乐资源", upstream_data: resData }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });

  } catch (err: any) {
    console.error("[Kugou Request Error]", err);
    if (types === "search") {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }
    return new Response(JSON.stringify({ error: "Worker 运行异常", message: err?.message || String(err) }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }
}

async function proxyApiRequest(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<Response> {
  const cache = caches.default;
  
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");
  cacheUrl.searchParams.delete("debug");
  
  const cacheKey = new Request(cacheUrl.toString(), {
    method: request.method,
    headers: request.headers
  });

  const bypassCache = url.searchParams.get("nocache") === "true" || url.searchParams.get("debug") === "true";
  if (request.method === "GET" && !bypassCache) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        console.log(`[Cache HIT] ${url.toString()}`);
        const response = new Response(cachedResponse.body, cachedResponse);
        response.headers.set("X-Cache-Status", "HIT");
        response.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return response;
      }
    } catch (err) {
      console.warn(`[Cache ERROR] ${url.toString()}`, err);
    }
  }

  if (url.searchParams.get("source") === "kugou") {
    const kugouResponse = await handleKugouApiRequest(url, request);
    if (kugouResponse) {
      if (waitUntil && request.method === "GET" && !bypassCache && kugouResponse.status === 200) {
        waitUntil(cache.put(cacheKey, kugouResponse.clone()));
      }
      return kugouResponse;
    }
  }

  console.log(`[Cache MISS] Fetching from upstream: ${url.toString()}`);

  const apiUrl = new URL(apiBaseUrl);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback" || key === "s" || key === "nocache" || key === "debug") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  const responseText = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  const isSearch = url.searchParams.get("types") === "search";
  const isEmptyResult = responseText.trim() === "[]";
  const isError = responseText.includes('"error"') || responseText.includes('"status":0');
  
  let shouldCache = upstream.status === 200 && request.method === "GET" && !isError && !bypassCache;
  
  if (isSearch && isEmptyResult) {
    shouldCache = false;
  }

  if (shouldCache) {
    headers.set("Cache-Control", "public, s-maxage=300, max-age=300");
  } else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  }

  const response = new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  if (shouldCache && waitUntil) {
    waitUntil(cache.put(cacheKey, response.clone()));
    console.log(`[Cache PUT] Saved to cache: ${url.toString()}`);
  }

  return response;
}

export async function onRequest({ request, waitUntil, env }: { request: Request, waitUntil: (promise: Promise<any>) => void, env: any }): Promise<Response> {
  const apiBaseUrl = (typeof env?.API_BASE_URL === "string" && env.API_BASE_URL) ? env.API_BASE_URL : DEFAULT_API_BASE_URL;
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyKuwoAudio(target, request);
  }

  return proxyApiRequest(url, request, waitUntil, apiBaseUrl);
}
