const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

// ================= 耀虎 API 配置 (酷狗源) =================
const YAOHUD_API_KEY = "Z2mDyU4rUTUEBbPYdbK";
const YAOHUD_SECRET_KEY = "75da5a53198ed28ece7d1d4e9cf381d1";

/**
 * HMAC-SHA256 加密签名算法 (严格匹配 PHP hash_hmac('sha256', $signString, $secretKey))
 */
async function generateSignature(apiKey: string, secretKey: string, timestamp: number): Promise<string> {
  const signString = `key=${apiKey}&timestamp=${timestamp}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const msgData = encoder.encode(signString);

  const cryptoKey = await crypto.subtle.importKey(
    "raw", 
    keyData, 
    { name: "HMAC", hash: "SHA-256" }, 
    false, 
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  
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
 * 如果耀虎 API 无数据或报错，自动返回 null 以触发默认源兜底
 */
async function handleKugouApiRequest(url: URL, request: Request): Promise<Response | null> {
  const types = url.searchParams.get("types");
  
  // 兼容各种前端传参规范 (name / keyword / s / id / query)
  const name = url.searchParams.get("name") || "";
  const keywordParam = url.searchParams.get("keyword") || "";
  const searchS = url.searchParams.get("s") || "";
  const id = url.searchParams.get("id") || "";
  const query = url.searchParams.get("query") || "";
  const keyword = name || keywordParam || searchS || id || query;

  const isDebug = url.searchParams.get("debug") === "true";

  if (!keyword) {
    return null;
  }

  const targetUrl = `https://api.yaohud.cn/api/music/kg?key=${YAOHUD_API_KEY}&msg=${encodeURIComponent(keyword)}&n=1&quality=320&type=json`;

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await generateSignature(YAOHUD_API_KEY, YAOHUD_SECRET_KEY, timestamp);

    const headersConfig: Record<string, string> = {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "X-Api-Key": YAOHUD_API_KEY,
      "X-Api-Timestamp": timestamp.toString(),
      "X-Api-Sign": signature,
      "Content-Type": "application/json"
    };

    const upstream = await fetch(targetUrl, { headers: headersConfig });
    const rawText = await upstream.text();
    let resData: any = null;

    try {
      resData = JSON.parse(rawText);
    } catch {
      console.warn("[Yaohud API non-JSON response]", rawText);
    }

    // 🎯 调试模式直接输出原始数据
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
        upstream_response: resData || rawText
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 判断耀虎 API 响应状态
    if (resData && (resData.code == 200 || resData.code == "200" || resData.code == 1 || resData.success === true)) {
      const rawInfo = resData.data || resData.info || resData;
      
      if (rawInfo) {
        const items = Array.isArray(rawInfo) ? rawInfo : [rawInfo];
        const validItems = items.filter(item => item && (item.name || item.title || item.songname || item.play_url || item.url || item.cover));

        if (validItems.length > 0) {
          if (types === "search") {
            const searchResults = validItems.map((item) => {
              const title = item.name || item.title || item.songname || keyword;
              const author = item.singer || item.artist || item.author || "未知歌手";
              const songId = `${title} - ${author}`;
              return {
                id: songId,
                name: title,
                artist: [author],
                album: item.album || title,
                pic_id: songId,
                url_id: songId,
                lyric_id: songId,
                source: "kugou"
              };
            });

            return new Response(JSON.stringify(searchResults), {
              status: 200,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=300"
              }
            });
          } else if (types === "url") {
            const playUrl = validItems[0].play_url || validItems[0].url || validItems[0].src || validItems[0].music_url;
            if (playUrl) {
              return new Response(JSON.stringify({ url: playUrl, br: 320 }), {
                status: 200,
                headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
              });
            }
          } else if (types === "pic") {
            const picUrl = validItems[0].cover || validItems[0].pic || validItems[0].img;
            if (picUrl) {
              return new Response(JSON.stringify({ url: picUrl }), {
                status: 200,
                headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
              });
            }
          } else if (types === "lyric") {
            const lyricStr = validItems[0].lyric || validItems[0].lrc || "";
            return new Response(JSON.stringify({ lyric: lyricStr, tlyric: "" }), {
              status: 200,
              headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("[Yaohud API Error]", err);
  }

  // 耀虎 API 未查到或报错时，返回 null 触发默认后端代理
  return null;
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

  // 兼容 source=kugou 或 site=kugou 两种前端传参
  const sourceParam = url.searchParams.get("source") || url.searchParams.get("site");
  if (sourceParam === "kugou") {
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
