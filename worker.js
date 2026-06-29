/**
 * Cloudflare Worker: 采购词库自动同步到 GitHub
 * 
 * 部署步骤:
 * 1. 注册 Cloudflare: https://dash.cloudflare.com
 * 2. npm install -g wrangler
 * 3. wrangler login   (浏览器弹出授权)
 * 4. wrangler secret put GITHUB_TOKEN   → 填 GitHub Personal Access Token
 * 5. wrangler secret put SYNC_PASSWORD  → 填同步密码（如 mysecret123）
 * 6. 把 worker.js 和 wrangler.toml 放到一个文件夹
 * 7. wrangler deploy
 * 8. 把返回的 Worker URL（如 https://yunciku-sync.xxx.workers.dev）填到 admin.html 的 CF_WORKER_URL
 * 9. 把同样的密码填到 admin.html 的 CF_SYNC_TOKEN
 */

const OWNER = 'gkl888';
const REPO = 'yunciku';
const BRANCH = 'master';
const DATA_FILE = 'data.json';

// GitHub API 请求封装
async function githubFetch(path, options = {}) {
    const token = GITHUB_TOKEN; // 从环境变量读取
    const url = `https://api.github.com${path}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'QClaw-Cloudflare-Worker',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, ok: res.ok, data: json };
}

async function handleRequest(request) {
    // 只允许 POST
    if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method Not Allowed' }, 405);
    }

    // 验证密码
    const auth = request.headers.get('Authorization') || '';
    const password = auth.replace(/^Bearer\s+/i, '').trim();
    if (!SYNC_PASSWORD || password !== SYNC_PASSWORD) {
        return jsonResponse({ error: 'Unauthorized — 请检查同步密码是否正确' }, 401);
    }

    // 解析请求体
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { data, message } = body;
    if (!data) {
        return jsonResponse({ error: 'Missing data field' }, 400);
    }

    // 序列化数据为 base64
    let contentBase64;
    try {
        const jsonStr = JSON.stringify(data, null, 0);
        // 使用 TextEncoder 处理 Unicode 字符
        const encoder = new TextEncoder();
        const bytes = encoder.encode(jsonStr);
        // 转成 base64（浏览器/Node.js 兼容）
        const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
        contentBase64 = btoa(binary);
    } catch(e) {
        return jsonResponse({ error: 'Failed to encode data', detail: e.message }, 500);
    }

    // 获取当前 SHA
    const shaRes = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${DATA_FILE}?ref=${BRANCH}`);
    const currentSha = shaRes.ok && shaRes.data.sha ? shaRes.data.sha : null;

    // 推送到 GitHub
    const commitMsg = message || `sync: 关键词数据更新 ${new Date().toLocaleString('zh-CN')}`;
    const putRes = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${DATA_FILE}`, {
        method: 'PUT',
        body: JSON.stringify({
            message: commitMsg,
            content: contentBase64,
            branch: BRANCH,
            ...(currentSha ? { sha: currentSha } : {})
        })
    });

    if (putRes.ok && putRes.data.content) {
        return jsonResponse({
            success: true,
            sha: putRes.data.content.sha.substring(0, 7),
            commit: putRes.data.commit.sha.substring(0, 7),
            message: '已同步到 GitHub'
        }, 200);
    } else {
        return jsonResponse({
            error: 'GitHub push failed',
            detail: putRes.data,
            status: putRes.status
        }, 502);
    }
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});
