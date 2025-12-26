/**
 * Advanced IPTV Worker
 * Supports: Multi-resolution (ABR), Relative Paths, TS Segments
 */

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "123"; // পাসওয়ার্ড পরিবর্তন করুন
const APP_TITLE = "Pro IPTV Panel";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ১. এডমিন এবং API রুট (আগের মতোই)
    if (path === "/admin") return handleAdmin(request, env);
    if (path === "/api/save" && request.method === "POST") return handleSave(request, env);
    if (path === "/api/delete" && request.method === "POST") return handleDelete(request, env);
    if (path === "/playlist.m3u") return handlePlaylist(request, env, url.origin);

    // ২. স্মার্ট স্ট্রিমিং হ্যান্ডেলার
    // প্যাটার্ন: /play/<channel_id>/<optional_path_to_chunk>
    if (path.startsWith("/play/")) {
      return handleStream(request, env);
    }

    return new Response("Worker is Running...", { status: 200 });
  }
};

// --- ফাংশন: স্মার্ট স্ট্রিম হ্যান্ডেলার (Main Logic) ---
async function handleStream(request, env) {
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/"); // ["", "play", "channelID", "extra..."]
  
  // চ্যানেল আইডি বের করা
  let channelId = pathParts[2];
  if(!channelId) return new Response("Invalid Request", { status: 400 });

  // আইডি থেকে .m3u8 এক্সটেনশন থাকলে ফেলে দেওয়া (মেইন রিকোয়েস্টের জন্য)
  if (channelId.endsWith(".m3u8")) {
    channelId = channelId.replace(".m3u8", "");
  }

  // ডাটাবেস থেকে চ্যানেল খোঁজা
  const data = await env.IPTV_KV.get("channels", { type: "json" });
  const channels = data || [];
  const channel = channels.find(c => c.id === channelId);

  if (!channel) return new Response("Channel Not Found", { status: 404 });

  // ৩. টার্গেট URL নির্ধারণ করা
  // যদি পাথে অতিরিক্ত অংশ থাকে (যেমন: chunklist.m3u8 বা segment.ts), 
  // তবে সেটা মেইন লিঙ্কের সাপেক্ষে রিসলভ করতে হবে।
  
  let targetUrl = channel.url;
  
  // সাব-পাথ (Sub-path) হ্যান্ডেলিং
  // যদি ইউজার রিকোয়েস্ট করে: /play/123/tracks-v1a1/mono.m3u8
  // তবে আমরা অরিজিনাল URL এর ফোল্ডারের সাথে এটা যোগ করব
  const extraPath = pathParts.slice(3).join("/"); // "tracks-v1a1/mono.m3u8"
  
  if (extraPath) {
    // অরিজিনাল URL এর বেস (Base) বের করা
    // যেমন: http://server.com/live/stream.m3u8 -> Base: http://server.com/live/
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
    
    // নতুন টার্গেট তৈরি (Relative path fix)
    try {
        // নতুন URL কনস্ট্রাক্টর ব্যবহার করে সঠিক লিংক তৈরি
        targetUrl = new URL(extraPath, baseUrl).href;
    } catch (e) {
        // যদি রিলেটিভ পাথ জটিল হয়, সরাসরি অ্যাপেন্ড করার চেষ্টা
        targetUrl = baseUrl + extraPath;
    }
  }

  // ৪. অরিজিনাল সার্ভার থেকে ফেচ করা
  try {
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
        "Referer": new URL(channel.url).origin // অরিজিনাল ডোমেইনকে রেফারার হিসেবে পাঠানো
      }
    });

    if (!response.ok) return response; // এরর হলে সরাসরি রিটার্ন

    const contentType = response.headers.get("Content-Type") || "";

    // ৫. যদি ফাইলটি M3U8 হয়, তবে ভেতরের লিংকগুলো REWRITE করতে হবে
    if (contentType.includes("mpegurl") || targetUrl.endsWith(".m3u8") || extraPath.endsWith(".m3u8")) {
      const text = await response.text();
      const modifiedText = rewriteM3u8(text, url.origin, channelId, extraPath);
      
      return new Response(modifiedText, {
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // ৬. যদি TS ফাইল বা ভিডিও চাঙ্ক হয়, সরাসরি পাঠিয়ে দেওয়া (Direct Stream)
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": contentType, // video/mp2t
        "Access-Control-Allow-Origin": "*"
      }
    });

  } catch (err) {
    return new Response("Stream Error: " + err.message, { status: 500 });
  }
}

// --- হেল্পার ফাংশন: M3U8 ফাইলের লিংক পরিবর্তন করা ---
function rewriteM3u8(content, workerOrigin, channelId, currentPath) {
  // লাইন বাই লাইন চেক করা
  const lines = content.split("\n");
  const newLines = lines.map(line => {
    const trimmed = line.trim();
    // যদি লাইনটি কমেন্ট না হয় এবং খালি না হয়, তার মানে এটি একটি লিংক (URI)
    if (trimmed && !trimmed.startsWith("#")) {
        // আমরা পাথের শুরুতে স্ল্যাশ (/) থাকলে সাবধানে হ্যান্ডেল করব
        // সিম্পল লজিক: আমরা চাই প্লেয়ার আবার আমাদের ওয়ার্কারেই রিকোয়েস্ট করুক
        // ফরম্যাট: https://worker.dev/play/{id}/{sub-path}
        
        // বর্তমান ফোল্ডার স্ট্রাকচার বজায় রাখা
        let nextPath = trimmed;
        
        // যদি এটি রিলেটিভ পাথ হয়, তবে আগের পাথের সাথে মিল রেখে নতুন পাথ তৈরি
        // জটিলতা এড়াতে আমরা সরাসরি ফাইলের নামটা ওয়ার্কারের পাথে বসিয়ে দেব
        
        // তবে যদি সাব-ফোল্ডার থাকে (যেমন: v1/chunk.ts), সেটাকেও রাখতে হবে
        // এই লজিকটি একটু ট্রিকি, কিন্তু নিচে সবচেয়ে সেইফ উপায় দেওয়া হলো:
        
        // যদি currentPath (যেমন: master.m3u8) থাকে, তবে সেটা বাদ দিয়ে নতুন ফাইলের নাম
        const pathPrefix = currentPath.includes("/") ? currentPath.substring(0, currentPath.lastIndexOf("/") + 1) : "";
        
        // ফাইনাল প্রক্সি লিংক
        return `${workerOrigin}/play/${channelId}/${pathPrefix}${trimmed}`;
    }
    return line;
  });
  
  return newLines.join("\n");
}

// --- M3U জেনারেটর (মেইন লিংক) ---
async function handlePlaylist(request, env, origin) {
  const data = await env.IPTV_KV.get("channels", { type: "json" });
  const channels = data || [];
  let m3uContent = "#EXTM3U\n";

  channels.forEach(ch => {
    // মেইন প্লেলিস্টে আমরা ফাইলনেম index.m3u8 দিচ্ছি যেন প্লেয়ার খুশি থাকে
    const proxyLink = `${origin}/play/${ch.id}/index.m3u8`;
    m3uContent += `#EXTINF:-1 tvg-logo="${ch.logo}" group-title="${ch.group}", ${ch.name}\n${proxyLink}\n`;
  });

  return new Response(m3uContent, { headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" } });
}

// --- এডমিন প্যানেল এবং অন্যান্য API (আগের মতোই অপরিবর্তিত) ---
async function handleAdmin(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth || auth !== `Basic ${btoa(ADMIN_USERNAME + ":" + ADMIN_PASSWORD)}`) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Admin Panel"' } });
  }
  const data = await env.IPTV_KV.get("channels", { type: "json" });
  const channels = data || [];
  
  const html = `<!DOCTYPE html><html><head><title>${APP_TITLE}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head>
  <body style="padding:20px;background:#f4f4f4;">
    <div class="container">
      <h3>📡 Advanced Channel Manager</h3>
      <div class="card p-3 mb-3">
        <form id="addForm" class="row g-3">
            <div class="col-md-3"><input id="name" class="form-control" placeholder="Name" required></div>
            <div class="col-md-3"><input id="group" class="form-control" placeholder="Group"></div>
            <div class="col-md-3"><input id="logo" class="form-control" placeholder="Logo URL"></div>
            <div class="col-md-3"><input id="url" class="form-control" placeholder="Source URL" required></div>
            <div class="col-12"><button type="submit" class="btn btn-primary">Add Channel</button></div>
        </form>
      </div>
      <table class="table table-striped"><tbody>
        ${channels.map(c => `<tr><td><img src="${c.logo}" height="30"></td><td>${c.name}</td><td>/play/${c.id}/index.m3u8</td><td><button onclick="del('${c.id}')" class="btn btn-danger btn-sm">X</button></td></tr>`).join('')}
      </tbody></table>
      <a href="/playlist.m3u" target="_blank">Download Playlist</a>
    </div>
    <script>
      document.getElementById('addForm').onsubmit = async (e) => {
        e.preventDefault();
        const d = { name: document.getElementById('name').value, group: document.getElementById('group').value, logo: document.getElementById('logo').value, url: document.getElementById('url').value };
        await fetch('/api/save', { method: 'POST', body: JSON.stringify(d) }); location.reload();
      };
      async function del(id) { if(confirm('Del?')) { await fetch('/api/delete', { method: 'POST', body: JSON.stringify({id}) }); location.reload(); } }
    </script>
  </body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function handleSave(request, env) {
  const body = await request.json();
  const newCh = { id: crypto.randomUUID().split('-')[0], ...body };
  const data = await env.IPTV_KV.get("channels", { type: "json" });
  const channels = data || [];
  channels.push(newCh);
  await env.IPTV_KV.put("channels", JSON.stringify(channels));
  return new Response("OK", { status: 200 });
}

async function handleDelete(request, env) {
  const body = await request.json();
  const data = await env.IPTV_KV.get("channels", { type: "json" });
  const channels = (data || []).filter(c => c.id !== body.id);
  await env.IPTV_KV.put("channels", JSON.stringify(channels));
  return new Response("OK", { status: 200 });
                                        }
