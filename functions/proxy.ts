addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // 1. 处理 OPTIONS 预检请求（解决前端 CORS 跨域限制）
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  const url = new URL(request.url)
  
  // 目标节点：可选择 https://music.gdstudio.org 或 https://music.gdstudio.xyz
  const targetHost = 'https://music.gdstudio.org'
  const targetUrl = new URL(`${targetHost}/api.php${url.search}`)

  // 构造转发请求，注入 GD 站长校验需要的伪装 Header
  const modifiedHeaders = new Headers(request.headers)
  modifiedHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
  modifiedHeaders.set('Referer', `${targetHost}/`)
  modifiedHeaders.set('Origin', targetHost)
  modifiedHeaders.set('X-Requested-With', 'XMLHttpRequest')

  const init = {
    method: request.method,
    headers: modifiedHeaders,
  }

  if (request.method === 'POST') {
    init.body = await request.arrayBuffer()
  }

  try {
    const response = await fetch(targetUrl.toString(), init)
    const newHeaders = new Headers(response.headers)
    
    // 允许你的网页跨域调用 Worker
    newHeaders.set('Access-Control-Allow-Origin', '*')
    newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }
}
