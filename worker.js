//only for demo purpose
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function handleOptions(request) {
  if (request.headers.get("Origin") !== null && request.headers.get("Access-Control-Request-Method") !== null && request.headers.get("Access-Control-Request-Headers") !== null) {
    return new Response(null, { headers: corsHeaders });
  } else {
    return new Response(null, { headers: { Allow: "GET, POST, OPTIONS" } });
  }
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") { return handleOptions(request); }

        const url = new URL(request.url);
        let path = url.pathname;

        if (path.endsWith("/qr") && path.length > 4) {
            const shortCode = path.substring(1, path.length - 3);
            return handleQrCode(request, shortCode);
        }

        if (path.startsWith("/api/shorten")) { return handleShorten(request, env, ctx); }
        if (path.startsWith("/api/stats")) { return handleStats(request, env); }
        if (path.startsWith("/api/update")) { return handleUpdate(request, env); }
        if (path.startsWith("/admin/")) { return handleAdminPage(request, env); }

        if (path !== "/") { return handleRedirect(request, env, ctx); }
return Response.redirect("https://urlshortenerz.pages.dev/", 301);
    },
};

async function handleShorten(request, env, ctx) {
    const body = await request.json();
    const { longUrl, alias, password, geo, expiresAt, maxClicks, deviceUrls, customHtml, abTestUrl, utmParams, pixelId } = body;

    if (!longUrl) { return new Response(JSON.stringify({ error: "Missing 'longUrl'" }), { status: 400, headers: corsHeaders }); }

    if (customHtml && new TextEncoder().encode(customHtml).length > 5120) {
        return new Response(JSON.stringify({ error: "Custom HTML must be under 5KB." }), { status: 413, headers: corsHeaders });
    }

    let shortCode = '';
    if (alias) {
        const reserved = ['api', 'admin'];
        if (reserved.some(r => alias.toLowerCase().startsWith(r)) || !/^[a-zA-Z0-9_-]+$/.test(alias)) {
            return new Response(JSON.stringify({ error: "Invalid or reserved alias." }), { status: 400, headers: corsHeaders });
        }
        const existing = await env.URL_STORE.get(`pub:${alias}`);
        if (existing) {
            return new Response(JSON.stringify({ error: "This custom alias is already taken." }), { status: 409, headers: corsHeaders });
        }
        shortCode = alias;
    } else {
        shortCode = generateCode(6);
    }

    const adminCode = generateCode(12);
    const data = {
        longUrl, adminCode, shortCode,
        password: password || null,
        geo: geo ? geo.split(',').map(c => c.trim().toUpperCase()).filter(Boolean) : null,
        expiresAt: expiresAt || null,
        maxClicks: maxClicks ? parseInt(maxClicks) : null,
        deviceUrls: deviceUrls || null,
        customHtml: customHtml || null,
        abTestUrl: abTestUrl || null,
        utmParams: utmParams || null,
        pixelId: pixelId || null,
        visitCount: 0,
        visits: []
    };

    ctx.waitUntil((async () => {
        const currentStats = await env.URL_STORE.get("_internal:stats");
        await env.URL_STORE.put("_internal:stats", (parseInt(currentStats) || 0) + 1);
    })());

    await env.URL_STORE.put(`pub:${shortCode}`, JSON.stringify(data));
    await env.URL_STORE.put(`adm:${adminCode}`, shortCode);

    const host = request.headers.get("host");
    const publicUrl = `https://${host}/${shortCode}`;
    const adminUrl = `https://${host}/admin/${adminCode}`;

    return new Response(JSON.stringify({ publicUrl, adminUrl }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

async function handleRedirect(request, env, ctx) {
    const shortCode = new URL(request.url).pathname.substring(1);
    const dataStr = await env.URL_STORE.get(`pub:${shortCode}`);
    if (!dataStr) { return new Response(`Link not found.`, { status: 404 }); }
    let data = JSON.parse(dataStr);

    if (data.expiresAt && new Date() > new Date(data.expiresAt)) { return new Response(generateInfoPage("Link Expired", "This link has expired and is no longer active."), { status: 410 }); }
    if (data.maxClicks && data.visitCount >= data.maxClicks) { return new Response(generateInfoPage("Link Expired", "This link has reached its maximum number of clicks."), { status: 410 }); }
    if (data.geo && data.geo.length > 0) {
        const visitorCountry = request.cf.country;
        if (!data.geo.includes(visitorCountry)) {
            return new Response(generateInfoPage("Access Denied", "This link is not available in your region."), { status: 403 });
        }
    }
    if (data.password) {
        if (request.method !== 'POST') {
             return new Response(generatePasswordPage(shortCode), { headers: { 'Content-Type': 'text/html' }});
        }
        const formData = await request.formData();
        if (formData.get('password') !== data.password) {
            return new Response(generatePasswordPage(shortCode, "Incorrect password!"), { status: 401, headers: { 'Content-Type': 'text/html' }});
        }
    }

    let targetUrl = (data.abTestUrl && Math.random() < 0.5) ? data.abTestUrl : data.longUrl;
    const userAgent = request.headers.get('User-Agent') || '';
    if (data.deviceUrls) {
        if (data.deviceUrls.ios && (userAgent.includes('iPhone') || userAgent.includes('iPad'))) { targetUrl = data.deviceUrls.ios; }
        else if (data.deviceUrls.android && userAgent.includes('Android')) { targetUrl = data.deviceUrls.android; }
    }
    if (data.utmParams) { targetUrl = appendUtmParams(targetUrl, data.utmParams); }

    ctx.waitUntil(recordAnalytics(request, env, shortCode, data));

    if (data.customHtml || data.pixelId) {
        return generateSplashPage(data, targetUrl);
    }

    return Response.redirect(targetUrl, 301);
}

async function handleAdminPage(request, env) {
  const url = new URL(request.url);
  const adminCode = url.pathname.split('/')[2];
  const shortCode = await env.URL_STORE.get(`adm:${adminCode}`);
  if (!shortCode) { return new Response("Invalid Admin Code.", { status: 404 }); }

  const dataStr = await env.URL_STORE.get(`pub:${shortCode}`);
  const data = JSON.parse(dataStr);

  const workerHost = url.host;
  const updateApiUrl = `https://${workerHost}/api/update`;

  let visitsHtml = '<p>No visits yet.</p>';
  if (data.visits && data.visits.length > 0) {
      visitsHtml = `<table class="analytics-table"><thead><tr><th>#</th><th>Timestamp (UTC)</th><th>IP Address</th><th>Country</th></tr></thead><tbody>${data.visits.slice().reverse().slice(0, 100).map((v, i) => `<tr><td>${data.visits.length - i}</td><td>${new Date(v.timestamp).toLocaleString('en-GB', { timeZone: 'UTC' })}</td><td>${v.ip}</td><td>${v.country}</td></tr>`).join('')}</tbody></table><p class="table-footer">Showing last 100 visits.</p>`;
  }

  const adminHtml = `
  <!DOCTYPE html>
  <html lang="en" data-theme="light">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Admin: /${shortCode}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.2.0/css/all.min.css" integrity="sha512-xh6O/CkQoPOWDdYTDqeRdPCVd1SpvCA9XXcUnZS2FmJNp1coAFzvtCN9BmamE+4aHK8yyUHUSCcJHgXloTyT2A==" crossorigin="anonymous" referrerpolicy="no-referrer" />
      <style>
          :root { --bg-color: #f4f7f9; --container-bg: #ffffff; --text-color: #1a202c; --sub-text-color: #5a6474; --border-color: #e2e8f0; --input-bg: #fdfdff; --primary-color: #4f46e5; --primary-hover: #4338ca; --shadow-color: rgba(79, 70, 229, 0.15); --switch-bg: #cbd5e1; --switch-fg: #ffffff; --icon-color: #9ca3af; --table-header-bg: #f8fafc; }
          [data-theme="dark"] { --bg-color: #111827; --container-bg: #1f2937; --text-color: #f9fafb; --sub-text-color: #9ca3af; --border-color: #374151; --input-bg: #111827; --primary-color: #6366f1; --primary-hover: #818cf8; --shadow-color: rgba(99, 102, 241, 0.2); --switch-bg: #374151; --switch-fg: #111827; --icon-color: #6b7280; --table-header-bg: #374151; }
          * { box-sizing: border-box; }
          body { font-family: 'Inter', sans-serif; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; background-color: var(--bg-color); color: var(--text-color); margin: 0; padding: 2rem 1rem; transition: background-color 0.3s ease; }
          .container { background: var(--container-bg); padding: 2rem 2.5rem; border-radius: 24px; box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.1); border: 1px solid var(--border-color); width: 100%; max-width: 800px; text-align: left; }
          .header { position: relative; text-align: center; margin-bottom: 2rem; }
          .theme-switch-wrapper { position: absolute; top: -15px; right: -15px; } .theme-switch { display: inline-block; height: 30px; position: relative; width: 60px; } .theme-switch input { display: none; } .slider { background-color: var(--switch-bg); position: absolute; inset: 0; cursor: pointer; transition: .4s; border-radius: 34px; } .slider:before { background-color: var(--switch-fg); content: ""; height: 22px; width: 22px; position: absolute; bottom: 4px; left: 4px; transition: .4s; border-radius: 50%; } input:checked + .slider { background-color: var(--primary-color); } input:checked + .slider:before { transform: translateX(30px); } .slider i { position: absolute; top: 50%; transform: translateY(-50%); font-size: 14px; color: var(--icon-color); transition: all 0.4s ease; } .slider .fa-sun { left: 8px; opacity: 1; } .slider .fa-moon { right: 8px; opacity: 0; } input:checked + .slider .fa-sun { opacity: 0; } input:checked + .slider .fa-moon { opacity: 1; }
          h1 { font-size: 2rem; font-weight: 700; margin: 0; display: flex; align-items: center; gap: 1rem; }
          h2 { font-size: 1.5rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; margin: 2rem 0 1rem; display: flex; align-items: center; gap: 0.75rem; }
          label { font-weight: 600; display: block; margin-top: 1.5rem; font-size: 0.9rem; }
          input[type=url], input[type=text] { width: 100%; padding: 14px; margin-top: 0.5rem; border: 1px solid var(--border-color); background-color: var(--input-bg); color: var(--text-color); border-radius: 10px; font-size: 1rem; }
          input:focus { outline: none; border-color: var(--primary-color); box-shadow: 0 0 0 3px var(--shadow-color); }
          button { padding: 14px 20px; border: none; border-radius: 10px; background-color: var(--primary-color); color: white; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 1.5rem; display: inline-flex; align-items: center; gap: 0.5rem; }
          button:hover { background-color: var(--primary-hover); }
          small { color: var(--sub-text-color); font-size: 0.8rem; }
          #message { margin-top: 1rem; font-weight: bold; padding: 1rem; border-radius: 8px; }
          #message.success { background-color: #dcfce7; color: #166534; border: 1px solid #4ade80; }
          #message.error { background-color: #fef2f2; color: #b91c1c; border: 1px solid #fca5a5; }
          .analytics-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
          .analytics-table th, .analytics-table td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid var(--border-color); }
          .analytics-table thead { background-color: var(--table-header-bg); }
          .table-footer { font-size: 0.8rem; color: var(--sub-text-color); text-align: center; margin-top: 1rem; }
      </style>
  </head>
  <body>
      <div class="container">
          <div class="header">
              <div class="theme-switch-wrapper">
                  <label class="theme-switch" for="theme-toggle"><input type="checkbox" id="theme-toggle" /><span class="slider"><i class="fas fa-sun"></i><i class="fas fa-moon"></i></span></label>
              </div>
              <h1><i class="fas fa-sliders-h" style="color: var(--primary-color);"></i>Admin Panel</h1>
              <p style="color: var(--sub-text-color);">Manage your short link: <strong>/${shortCode}</strong></p>
          </div>

          <form id="updateForm">
              <label for="newLongUrl">Destination URL</label>
              <input type="url" id="newLongUrl" value="${data.longUrl}" required>

              <label for="newPassword">Password</label>
              <input type="text" id="newPassword" placeholder="Leave blank to keep current">
              <small>To remove the password, submit with this field empty.</small>

              <button type="submit"><i class="fas fa-save"></i> Save Changes</button>
          </form>
          <p id="message"></p>

          <div class="section">
              <h2><i class="fas fa-chart-line"></i>Analytics</h2>
              <p><strong>Total Visits:</strong> ${data.visitCount || 0}</p>
              <h3>Recent Visits:</h3>
              ${visitsHtml}
          </div>
      </div>
      <script>
          const themeToggle = document.getElementById('theme-toggle');
          const currentTheme = localStorage.getItem('theme');
          if (currentTheme) {
              document.documentElement.setAttribute('data-theme', currentTheme);
              if (currentTheme === 'dark') themeToggle.checked = true;
          }
          themeToggle.addEventListener('change', (e) => {
              const theme = e.target.checked ? 'dark' : 'light';
              document.documentElement.setAttribute('data-theme', theme);
              localStorage.setItem('theme', theme);
          });

          const form = document.getElementById("updateForm"), messageEl = document.getElementById("message"), adminCode = "${adminCode}";
          form.addEventListener("submit", async e => {
              e.preventDefault();
              const newLongUrl = document.getElementById("newLongUrl").value;
              const newPassword = document.getElementById("newPassword").value;
              messageEl.textContent = "Updating...";
              messageEl.className = '';

              const response = await fetch("${updateApiUrl}", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ adminCode, newLongUrl, newPassword }) });

              if (response.ok) {
                  messageEl.textContent = "Successfully updated! The page will reload in 2 seconds.";
                  messageEl.className = 'success';
                  setTimeout(() => location.reload(), 2000);
              } else {
                  const error = await response.json();
                  messageEl.textContent = "Error: " + (error.error || "Could not update.");
                  messageEl.className = 'error';
              }
          });
      </script>
  </body>
  </html>`;
  return new Response(adminHtml, { headers: { 'Content-Type': 'text/html' } });
}
async function handleUpdate(request, env) {
    const body = await request.json();
    const { adminCode, newLongUrl, newPassword } = body;
    if (!adminCode) { return new Response(JSON.stringify({ error: "Missing adminCode" }), { status: 400, headers: corsHeaders }); }

    const shortCode = await env.URL_STORE.get(`adm:${adminCode}`);
    if (!shortCode) { return new Response(JSON.stringify({ error: "Invalid Admin Code" }), { status: 404, headers: corsHeaders }); }

    const oldDataStr = await env.URL_STORE.get(`pub:${shortCode}`);
    let oldData = JSON.parse(oldDataStr);

    if (newLongUrl) oldData.longUrl = newLongUrl;
    if ('newPassword' in body) oldData.password = newPassword || null;

    await env.URL_STORE.put(`pub:${shortCode}`, JSON.stringify(oldData));
    return new Response(JSON.stringify({ success: true, message: "Link updated." }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

async function handleStats(request, env) {
    const totalLinks = await env.URL_STORE.get("_internal:stats");
    return new Response(JSON.stringify({ totalLinks: totalLinks || 0 }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}

function handleQrCode(request, shortCode) {
    const host = request.headers.get("host");
    const fullUrl = `https://${host}/${shortCode}`;
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(fullUrl)}`;
    return Response.redirect(qrApiUrl, 302);
}

function generateSplashPage(data, targetUrl) {
    const pixelScript = data.pixelId ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${data.pixelId}');fbq('track','PageView');</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${data.pixelId}&ev=PageView&noscript=1"/></noscript>` : '';
    const html = `<!DOCTYPE html><html><head><title>Redirecting...</title><meta http-equiv="refresh" content="3;url=${targetUrl.replace(/"/g, '&quot;')}">${pixelScript}</head><body style="font-family:sans-serif; margin:0;">${data.customHtml || '<p style="text-align:center; margin-top: 2rem;">You will be redirected shortly...</p>'}</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

function appendUtmParams(url, params) {
    try {
        const urlObj = new URL(url);
        Object.keys(params).forEach(key => {
            if (params[key]) urlObj.searchParams.set(key, params[key]);
        });
        return urlObj.toString();
    } catch (e) {
        return url;
    }
}

async function recordAnalytics(request, env, shortCode, data) {
    data.visitCount = (data.visitCount || 0) + 1;
    if (!data.visits) data.visits = [];
    data.visits.push({
        timestamp: new Date().toISOString(),
        ip: request.headers.get('CF-Connecting-IP') || 'N/A',
        country: request.cf.country || 'N/A',
    });
    data.visits = data.visits.slice(-100);
    await env.URL_STORE.put(`pub:${shortCode}`, JSON.stringify(data));
}

function generateInfoPage(title, message) {
    return `<!DOCTYPE html><html><head><title>${title}</title><style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#f4f6f8;} .box{background:white;padding:2rem;border-radius:8px;text-align:center;box-shadow:0 4px 8px rgba(0,0,0,.1);}</style></head><body><div class="box"><h2>${title}</h2><p>${message}</p></div></body></html>`;
}

function generatePasswordPage(shortCode, error = null) {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Password Required</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.2.0/css/all.min.css" integrity="sha512-xh6O/CkQoPOWDdYTDqeRdPCVd1SpvCA9XXcUnZS2FmJNp1coAFzvtCN9BmamE+4aHK8yyUHUSCcJHgXloTyT2A==" crossorigin="anonymous" referrerpolicy="no-referrer" />
      <style>
          :root { --bg-color: #f4f7f9; --container-bg: #ffffff; --text-color: #1a202c; --sub-text-color: #5a6474; --border-color: #e2e8f0; --input-bg: #fdfdff; --primary-color: #4f46e5; --primary-hover: #4338ca; --shadow-color: rgba(79, 70, 229, 0.15); }
          @media (prefers-color-scheme: dark) {
              :root { --bg-color: #111827; --container-bg: #1f2937; --text-color: #f9fafb; --sub-text-color: #9ca3af; --border-color: #374151; --input-bg: #111827; --primary-color: #6366f1; --primary-hover: #818cf8; --shadow-color: rgba(99, 102, 241, 0.2); }
          }
          body { font-family: 'Inter', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background-color: var(--bg-color); color: var(--text-color); margin: 0; padding: 1rem; }
          .box { background: var(--container-bg); padding: 2.5rem; border-radius: 24px; text-align: center; box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.1); border: 1px solid var(--border-color); width: 100%; max-width: 400px; }
          h2 { font-size: 1.5rem; margin: 0 0 0.5rem; }
          p { color: var(--sub-text-color); margin: 0 0 1.5rem; }
          form { display: flex; gap: 0.5rem; }
          input { flex-grow: 1; padding: 14px; border: 1px solid var(--border-color); background-color: var(--input-bg); color: var(--text-color); border-radius: 10px; font-size: 1rem; }
          input:focus { outline: none; border-color: var(--primary-color); box-shadow: 0 0 0 3px var(--shadow-color); }
          button { padding: 14px 20px; border: none; border-radius: 10px; background-color: var(--primary-color); color: white; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 0.5rem; }
          .error { color: #ef4444; margin-top: 1rem; font-weight: 500; }
      </style>
  </head>
  <body>
      <div class="box">
          <h2><i class="fas fa-shield-halved" style="color: var(--primary-color);"></i> Password Required</h2>
          <p>This link is protected. Please enter the password to continue.</p>
          <form method="POST" action="/${shortCode}">
              <input type="password" name="password" placeholder="Enter password" required autofocus>
              <button type="submit"><i class="fas fa-arrow-right"></i></button>
          </form>
          ${error ? `<p class="error">${error}</p>` : ''}
      </div>
  </body>
  </html>`;
}
function generateCode(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}