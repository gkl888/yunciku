/**
 * Cloudflare Pages Function: 采购词库同步到 GitHub
 * GET  /api/sync            → 获取最新 data.json（绕过CF缓存，实时从GitHub拉取）
 * GET  /api/sync?type=users → 获取用户列表
 * POST /api/sync (无Bearer)  → 用户注册
 * POST /api/sync (Bearer token) → 同步关键词数据
 */

const OWNER = 'gkl888';
const REPO = 'yunciku';
const BRANCH = 'main';
const DATA_FILE = 'data.json';

async function githubFetch(path, options = {}, env) {
    const token = env.GITHUB_TOKEN;
    const url = `https://api.github.com${path}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'QClaw-Cloudflare-Pages-Function',
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

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

// GET: 获取最新 data.json（实时从GitHub拉取，绕开CF静态缓存）
async function handleGetData(context) {
    const { env } = context;
    try {
        const res = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${DATA_FILE}?ref=${BRANCH}`, {}, env);
        if (!res.ok) {
            return jsonResponse({ error: 'Failed to fetch data from GitHub', detail: res.data }, 502);
        }
        // 解码 base64
        const binary = atob(res.data.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const jsonStr = new TextDecoder().decode(bytes);
        
        return new Response(jsonStr, {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-Source': 'github-api',
                'X-SHA': res.data.sha.substring(0, 7)
            }
        });
    } catch(e) {
        return jsonResponse({ error: 'Failed to fetch data', detail: e.message }, 500);
    }
}

// GET: 获取用户列表
async function handleGetUsers(context) {
    const { env } = context;
    const USERS_FILE = 'users.json';

    const auth = context.request.headers.get('Authorization') || '';
    const password = auth.replace(/^Bearer\s+/i, '').trim();
    if (!password || password !== env.SYNC_PASSWORD) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const res = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${USERS_FILE}?ref=${BRANCH}`, {}, env);
    if (!res.ok) {
        return jsonResponse({ users: {}, version: Date.now() }, 200);
    }

    try {
        const binary = atob(res.data.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const jsonStr = new TextDecoder().decode(bytes);
        const users = JSON.parse(jsonStr);
        return jsonResponse({ users, sha: res.data.sha }, 200);
    } catch(e) {
        return jsonResponse({ error: 'Failed to parse users', detail: e.message }, 500);
    }
}

// POST: 用户注册
async function handleRegister(context) {
    const { env } = context;
    const USERS_FILE = 'users.json';

    let body;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { username, realname, password } = body;
    if (!username || !password) {
        return jsonResponse({ error: 'Missing username or password' }, 400);
    }
    if (username.length < 3 || password.length < 6) {
        return jsonResponse({ error: 'Username needs 3+ chars, password 6+ chars' }, 400);
    }

    const shaRes = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${USERS_FILE}?ref=${BRANCH}`, {}, env);
    let users = {};
    let currentSha = null;
    if (shaRes.ok && shaRes.data.sha) {
        currentSha = shaRes.data.sha;
        try {
            const binary = atob(shaRes.data.content);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            users = JSON.parse(new TextDecoder().decode(bytes));
        } catch {}
    }

    if (users[username]) {
        return jsonResponse({ error: '用户名已被注册' }, 409);
    }

    users[username] = {
        username,
        realname: realname || username,
        password: hashPassword(password),
        createdAt: Date.now(),
        isAdmin: false,
        status: 'pending'
    };

    const encoder = new TextEncoder();
    const bytes = encoder.encode(JSON.stringify(users));
    const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
    const contentBase64 = btoa(binary);

    const putRes = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${USERS_FILE}`, {
        method: 'PUT',
        body: JSON.stringify({
            message: `register: ${username} registered`,
            content: contentBase64,
            branch: BRANCH,
            ...(currentSha ? { sha: currentSha } : {})
        })
    }, env);

    if (putRes.ok) {
        return jsonResponse({ success: true, message: '注册成功，请等待管理员审核' }, 200);
    } else {
        return jsonResponse({ error: '注册失败，请重试' }, 502);
    }
}

// POST: 同步关键词
async function handleKeywordSync(context) {
    const { request, env } = context;

    const auth = request.headers.get('Authorization') || '';
    const password = auth.replace(/^Bearer\s+/i, '').trim();
    if (!password || password !== env.SYNC_PASSWORD) {
        return jsonResponse({ error: 'Unauthorized — 请检查同步密码' }, 401);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { data, message, usersData } = body;

    if (usersData) {
        const USERS_FILE = 'users.json';
        const encoder = new TextEncoder();
        const bytes = encoder.encode(JSON.stringify(usersData));
        const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
        const contentBase64 = btoa(binary);
        const shaRes = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${USERS_FILE}?ref=${BRANCH}`, {}, env);
        const currentSha = shaRes.ok && shaRes.data.sha ? shaRes.data.sha : null;
        const putRes = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${USERS_FILE}`, {
            method: 'PUT',
            body: JSON.stringify({
                message: `user_update: admin updated users ${new Date().toLocaleString('zh-CN')}`,
                content: contentBase64,
                branch: BRANCH,
                ...(currentSha ? { sha: currentSha } : {})
            })
        }, env);
        if (putRes.ok) {
            return jsonResponse({ success: true, message: '用户数据已同步到云端' }, 200);
        } else {
            return jsonResponse({ error: '用户数据同步失败' }, 502);
        }
    }

    if (!data) {
        return jsonResponse({ error: 'Missing data field' }, 400);
    }

    let contentBase64;
    try {
        const jsonStr = JSON.stringify(data, null, 0);
        const encoder = new TextEncoder();
        const bytes = encoder.encode(jsonStr);
        const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
        contentBase64 = btoa(binary);
    } catch(e) {
        return jsonResponse({ error: 'Failed to encode data' }, 500);
    }

    const shaRes = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${DATA_FILE}?ref=${BRANCH}`, {}, env);
    const currentSha = shaRes.ok && shaRes.data.sha ? shaRes.data.sha : null;

    const commitMsg = message || `sync: 关键词数据更新 ${new Date().toLocaleString('zh-CN')}`;
    const putRes = await githubFetch(`/repos/${OWNER}/${REPO}/contents/${DATA_FILE}`, {
        method: 'PUT',
        body: JSON.stringify({
            message: commitMsg,
            content: contentBase64,
            branch: BRANCH,
            ...(currentSha ? { sha: currentSha } : {})
        })
    }, env);

    if (putRes.ok && putRes.data.content) {
        return jsonResponse({
            success: true,
            sha: putRes.data.content.sha.substring(0, 7),
            message: '已同步到 GitHub'
        }, 200);
    } else {
        return jsonResponse({ error: 'GitHub push failed', detail: putRes.data }, 502);
    }
}

function hashPassword(password) {
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
        const char = password.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return 'hash_' + Math.abs(hash).toString(16);
}

// Cloudflare Pages Function 入口
export async function onRequest(context) {
    const url = new URL(context.request.url);
    const type = url.searchParams.get('type');
    
    if (context.request.method === 'GET') {
        if (type === 'users') {
            return handleGetUsers(context);
        }
        // 默认返回最新 data.json（绕开CF静态缓存）
        return handleGetData(context);
    }
    
    if (context.request.method === 'POST') {
        const auth = context.request.headers.get('Authorization') || '';
        const password = auth.replace(/^Bearer\s+/i, '').trim();
        if (auth.startsWith('Bearer ') && password === context.env.SYNC_PASSWORD) {
            return handleKeywordSync(context);
        }
        return handleRegister(context);
    }
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
}
