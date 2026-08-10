// ================= 1. 基础配置 =================
const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = [
  "content-type", 
  "cache-control", 
  "accept-ranges", 
  "content-length", 
  "content-range", 
  "etag", 
  "last-modified", 
  "expires"
];

// ================= 2. 新 API 已为你填好的配置 =================
const NEW_API_BASE = "https://jkapi.com/api/music"; 
const NEW_API_KEY = "017109b3debeda73f9b8b977758300ba"; 

// ================= 3. 跨域与辅助函数 =================
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
    if (!isAllowedKuwoHost(parsed.hostname)) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) return new Response("Invalid target", { status: 400 });

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
 * 处理新 API 请求（适配 QQ 音乐 / 网易云解析）
 */
async function handleNewApiRequest(url: URL, request: Request): Promise<Response> {
  const types = url.searchParams.get("types");
  const name = url.searchParams.get("name") || "";
  const keywordParam = url.searchParams.get("keyword") || "";
  const searchS = url.searchParams.get("s") || "";
  const id = url.searchParams.get("id") || "";
  const query = url.searchParams.get("query") || "";
  const keyword = name || keywordParam || searchS || id || query;

  const platform = url.searchParams.get("source") || url.searchParams.get("site") || "qq";
  const isDebug = url.searchParams.get("debug") === "true";

  if (!keyword) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }

  // 构建准确符合对方接口格式的 URL：plat=平台 & type=json & apiKey=密钥 & name=歌名
  const targetType = (platform === "qq" || platform === "tencent") ? "qq" : "wy";
  const targetUrl = `${NEW_API_BASE}?plat=${targetType}&type=json&apiKey=${NEW_API_KEY}&name=${encodeURIComponent(keyword)}`;

  try {
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    const rawText = await upstream.text();

    // 调试模式（在请求末尾加 &debug=true 时可以看到原样返回）
    if (isDebug) {
      return new Response(JSON.stringify({
        debug_info: {
          requested_keyword: keyword,
          targetPlatform: targetType,
          targetUrl,
          upstream_http_status: upstream.status
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
      // JSON 解析失败
    }

    // 解析 API 返回的数据结构
    if (resData && (resData.code === 1 || resData.code === 200) && (resData.music_url || resData.url)) {
      const songTitle = resData.name || keyword;
      const songArtist = resData.artist || "未知歌手";
      const songAlbum = resData.album || songTitle;
      const playUrl = resData.music_url || resData.url;
      const picUrl = resData.pic || resData.cover || "";
      const lyricStr = resData.lyric || resData.lrc || "";

      const songId = `${songTitle} - ${songArtist}`;

      if (types === "search" || !types) {
        const searchResults = [{
          id: songId,
          name: songTitle,
          artist: [songArtist],
          album: songAlbum,
          pic_id: songId,
          url_id: songId,
          lyric_id: songId,
          source: platform
        }];

        return new Response(JSON.stringify(searchResults), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      } else if (types === "url") {
        return new Response(JSON.stringify({ url: playUrl, br: 320 }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      } else if (types === "pic") {
        return new Response(JSON.stringify({ url: picUrl }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      } else if (types === "lyric") {
        return new Response(JSON.stringify({ lyric: lyricStr, tlyric: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 搜索失败或查无结果时，防崩保护返回空数组 []
    if (types === "search" || !types) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response(JSON.stringify({ error: "解析失败", raw: rawText }), { status: 200 });

  } catch (err: any) {
    if (types === "search" || !types) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }
    return new Response(JSON.stringify({ error: err.message }), { status: 200 });
  }
}

async function proxyApiRequest(url: URL, request: Request, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<Response> {
  const sourceParam = url.searchParams.get("source") || url.searchParams.get("site");
  
  // 识别到 QQ 音乐时切去新 API，其他源依然走旧接口
  if (sourceParam === "qq" || sourceParam === "tencent") {
    return await handleNewApiRequest(url, request);
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

// ================= 4. 入口处理函数 =================
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
