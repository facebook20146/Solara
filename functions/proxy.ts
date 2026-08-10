const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

// ================= 耀虎 API 配置 (酷狗源) =================
const YAOHUD_API_KEY = "Z2mDyU4rUTUEBbPYdbK";
const YAOHUD_SECRET_KEY = "75da5a53198ed28ece7d1d4e9cf381d1";

/**
 * 官方标准 HMAC-SHA256 签名算法
 * 严格对齐 PHP: hash_hmac('sha256', "key={$apiKey}&timestamp={$timestamp}", $secretKey)
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
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
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

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * 处理酷狗音乐请求（严格对齐官方 PHP Demo）
 */
async function handleKugouApiRequest(url: URL, request: Request): Promise<Response> {
  const types = url.searchParams.get("types");
  const name = url.searchParams.get("name") || "";
  const keywordParam = url.searchParams.get("keyword") || "";
  const searchS = url.searchParams.get("s") || "";
  const id = url.searchParams.get("id") || "";
  const query = url.searchParams.get("query") || "";
  const keyword = name || keywordParam || searchS || id || query;

  const isDebug = url.searchParams.get("debug") === "true";

  if (!keyword) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }

  const targetUrl = `https://api.yaohud.cn/api/music/kg?key=${YAOHUD_API_KEY}&msg=${encodeURIComponent(keyword)}&n=1&quality=320&type=json`;

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await generateSignature(YAOHUD_API_KEY, YAOHUD_SECRET_KEY, timestamp);

    // 严格匹配官方 PHP ApiClient 的 Header 注入逻辑
    const headersConfig: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "X-Api-Key": YAOHUD_API_KEY,
      "X-Api-Timestamp": timestamp.toString(),
      "X-Api-Sign": signature
    };

    const upstream = await fetch(targetUrl, { 
      method: "GET",
      headers: headersConfig 
    });

    const rawText = await upstream.text();

    if (isDebug || upstream.status !== 200) {
      return new Response(JSON.stringify({
        debug_info: {
          requested_keyword: keyword,
          targetUrl,
          timestamp,
          signature,
          sent_headers: headersConfig,
          upstream_http_status: upstream.status,
          upstream_status_text: upstream.statusText
        },
        upstream_raw_response: rawText
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    let resData: any = null;
    try {
      resData = JSON.parse(rawText);
    } catch {
      return new Response(JSON.stringify({
        error: "耀虎 API 未返回有效 JSON",
        upstream_http_status: upstream.status,
        upstream_raw_text: rawText
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (resData && (resData.code == 200 || resData.code == "200" || resData.code == 1) && resData.data) {
      const rawInfo = resData.data;
      const items = Array.isArray(rawInfo) ? rawInfo : [rawInfo];
      const validItems = items.filter(item => item && (item.name || item.title || item.songname || item.play_url || item.url));

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
              "Cache-Control": "no-store"
            }
          });
        } else if (types === "url") {
          const playUrl = validItems[0].play_url || validItems[0].url || validItems[0].src;
          return new Response(JSON.stringify({ url: playUrl || "", br: 320 }), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
          });
        } else if (types === "pic") {
          const picUrl = validItems[0].cover || validItems[0].pic || validItems[0].img;
          return new Response(JSON.stringify({ url: picUrl || "" }), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
          });
        } else if (types === "lyric") {
          const lyricStr = validItems[0].lyric || validItems[0].lrc || "";
          return new Response(JSON.stringify({ lyric: lyricStr, tlyric: "" }), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
          });
        }
      }
    }

    return new Response(JSON.stringify({
      error: "耀虎 API 未能返回有效歌曲",
      response: resData
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({
      error: "Worker 网络请求异常",
      details: err?.message || String(err)
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }
}

async function proxyApiRequest(url: URL, request: Request, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<Response> {
  const sourceParam = url.searchParams.get("source") || url.searchParams.get("site");
  if (sourceParam === "kugou") {
    return await handleKugouApiRequest(url, request);
  }

  const apiUrl = new URL(apiBaseUrl);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback" || key === "s" || key === "nocache" || key === "debug") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Accept": "application/json",
    },
  });

  const responseText = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export async function onRequest({ request, env }: { request: Request, env: any }): Promise<Response> {
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

  return proxyApiRequest(url, request, apiBaseUrl);
}
