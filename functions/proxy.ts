// 基本配置
const DEFAULT_API_BASE_URL = 'https://music-api.gdstudio.xyz/api.php';
const API_KEY = 'Z2mDyU4rUTUEBbPYdbK';
const SECRET_KEY = 'fbda8f0550be131b05d22dc0d0ad3e4b';

/**
 * 辅助函数：生成 HMAC-SHA256 签名（替代原 PHP 中的签名算法）
 */
async function generateSignature(apiKey: string, secretKey: string, timestamp: number): Promise<string> {
    const signString = `key=${apiKey}&timestamp=${timestamp}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secretKey);
    const msgData = encoder.encode(signString);

    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    
    // 转为 16 进制字符串
    const hashArray = Array.from(new Uint8Array(signatureBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context: any) {
    const { request } = context;
    const reqUrl = new URL(request.url);

    // 1. 代理酷我/第三方音频流（绕过跨域）
    const target = reqUrl.searchParams.get('target');
    if (target) {
        return fetch(target, {
            headers: {
                'User-Agent': request.headers.get('user-agent') || 'Mozilla/5.0',
                'Referer': 'https://www.kuwo.cn/',
            }
        });
    }

    const types = reqUrl.searchParams.get('types');
    const source = reqUrl.searchParams.get('source');
    const name = reqUrl.searchParams.get('name') || '';
    const id = reqUrl.searchParams.get('id') || '';

    // 2. 特殊处理：酷狗音乐源（使用带签名的 耀虎 API）
    if (source === 'kugou') {
        const keyword = name || id;
        const targetUrl = `https://api.yaohud.cn/api/music/kg?key=${API_KEY}&msg=${encodeURIComponent(keyword)}&n=1&quality=320&type=json`;

        try {
            // 生成时间戳和签名头
            const timestamp = Math.floor(Date.now() / 1000);
            const signature = await generateSignature(API_KEY, SECRET_KEY, timestamp);

            // 发起带签名请求头的 API 请求
            const resp = await fetch(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'X-Api-Key': API_KEY,
                    'X-Api-Timestamp': timestamp.toString(),
                    'X-Api-Sign': signature
                }
            });

            const resData = await resp.json() as any;

            if (resData.code === 200 && resData.data) {
                const info = resData.data;

                // ① 搜索请求
                if (types === 'search') {
                    const searchResult = [{
                        id: info.name + ' - ' + info.singer,
                        name: info.name,
                        artist: [info.singer],
                        album: info.name,
                        pic_id: info.name + ' - ' + info.singer,
                        url_id: info.name + ' - ' + info.singer,
                        lyric_id: info.name + ' - ' + info.singer,
                        source: 'kugou'
                    }];
                    return new Response(JSON.stringify(searchResult), {
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                // ② 获取播放链接
                if (types === 'url') {
                    return new Response(JSON.stringify({ url: info.play_url, br: 320 }), {
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                // ③ 获取歌曲封面
                if (types === 'pic') {
                    return new Response(JSON.stringify({ url: info.cover }), {
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                // ④ 获取歌词（若无歌词则返回空）
                if (types === 'lyric') {
                    return new Response(JSON.stringify({ lyric: '', tlyric: '' }), {
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }
            }
        } catch (e) {
            console.error('[Kugou Signed Request Error]', e);
        }
    }

    // 3. 默认逻辑：其他音乐源转发至原有 API
    const apiUrl = new URL(DEFAULT_API_BASE_URL);
    reqUrl.searchParams.forEach((v, k) => {
        if (k !== 'target' && k !== 's' && k !== 'nocache') {
            apiUrl.searchParams.set(k, v);
        }
    });

    const upstream = await fetch(apiUrl.toString(), {
        headers: {
            'User-Agent': request.headers.get('user-agent') || 'Mozilla/5.0',
            'Accept': 'application/json',
        }
    });

    const body = await upstream.text();
    return new Response(body, {
        status: upstream.status,
        headers: {
            'Content-Type': upstream.headers.get('content-type') || 'application/json',
            'Access-Control-Allow-Origin': '*',
        }
    });
}
