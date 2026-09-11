#!/usr/bin/env node
/**
 * Local UI preview + screenshot harness.
 *
 * Renders the real admin HTML (built from src/ui/admin-html.ts) with stubbed API
 * responses, then captures PNGs with headless Chrome so a UI change can be
 * reviewed visually before it is deployed. No network, no credentials, no
 * production access.
 *
 * Usage:
 *   node scripts/preview-ui.mjs                      # 1440x900 + 390x844, list tab
 *   node scripts/preview-ui.mjs --tab llm            # switch tab before capture
 *   node scripts/preview-ui.mjs --size 1920x1080     # replace the size list
 *   node scripts/preview-ui.mjs --keep               # keep preview/ after capture
 *
 * Output: preview/<size>-<tab>.png (git-ignored)
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "preview");
const buildDir = join(outDir, ".build");

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const tab = flagValue("--tab", "list");
const sizes = (flagValue("--size", "") || "1440x900,390x844")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const keep = args.includes("--keep");
const probe = args.includes("--probe");

/** Stubbed API payloads. Kept close to the shapes the routes actually return. */
const FIXTURE = `
(function () {
  var providers = [
    { slug: 'main', name: '主力机场', latestVersion: { versionId: '20260911T142000Z-ab12cd34', sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef001122334455667788', updatedAt: '2026-09-11T14:20:00.000Z' }, nodeCount: 42, sourceHost: 'airport-a.example.com', sourceUrl: 'https://airport-a.example.com/api/v1/client/subscribe?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', userAgent: 'clash-verge/v2.4.5' },
    { slug: 'backup', name: '备用机场', latestVersion: { versionId: '20260910T090000Z-cd34ef56', sha256: 'b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef00112233445566778899aa', updatedAt: '2026-09-10T09:00:00.000Z' }, nodeCount: 28, sourceHost: 'backup-b.example.net', sourceUrl: 'https://backup-b.example.net/sub?token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', userAgent: 'clash.meta/1.19.20' },
    { slug: 'hk', name: '香港专线', latestVersion: { versionId: '20260908T180000Z-ef56ab78', sha256: 'c3d4e5f60718293a4b5c6d7e8f9012345678abcdef00112233445566778899aabb', updatedAt: '2026-09-08T18:00:00.000Z' }, nodeCount: 15, sourceHost: 'hk.example.org', sourceUrl: 'https://hk.example.org/link/cccccccccccccccc', userAgent: 'SlClash clash-verge Platform/android' },
    { slug: 'jp', name: '日本节点', latestVersion: { versionId: '20260905T110000Z-1234abcd', sha256: 'd4e5f60718293a4b5c6d7e8f9012345678abcdef00112233445566778899aabbcc', updatedAt: '2026-09-05T11:00:00.000Z' }, nodeCount: 22, sourceHost: 'jp.example.io', sourceUrl: 'https://jp.example.io/api?token=dddddddd', userAgent: 'clash-verge/v2.4.5' },
    { slug: 'lab', name: '实验机场', latestVersion: { versionId: '20260828T200000Z-5678efgh', sha256: 'e5f60718293a4b5c6d7e8f9012345678abcdef00112233445566778899aabbccdd', updatedAt: '2026-08-28T20:00:00.000Z' }, nodeCount: 9, sourceHost: 'lab.example.dev', sourceUrl: 'https://lab.example.dev/s/eeeeeeee', userAgent: 'clash.meta/1.19.20' }
  ];
  var keys = [
    { slug: 'deepseek', name: 'DeepSeek', provider: '', baseUrl: '', models: [], tags: [], hint: { last4: 'c4f1', length: 35 }, secretPresent: true, createdAt: '2026-09-11T15:00:00.000Z', updatedAt: '2026-09-11T15:20:00.000Z' },
    { slug: 'mimo', name: 'MIMO', provider: '', baseUrl: '', models: [], tags: [], hint: { last4: '9a02', length: 48 }, secretPresent: true, createdAt: '2026-09-11T15:05:00.000Z', updatedAt: '2026-09-11T15:05:00.000Z' }
  ];
  var history = [
    { versionId: '20260911T142000Z-ab12cd34', createdAt: '2026-09-11T14:20:00.000Z', nodeCount: 42, sha256Prefix: 'a1b2c3d4', contentLength: 18234, sourceHost: 'airport-a.example.com', isCurrent: true },
    { versionId: '20260910T090000Z-cd34ef56', createdAt: '2026-09-10T09:00:00.000Z', nodeCount: 41, sha256Prefix: 'b2c3d4e5', contentLength: 18102, sourceHost: 'airport-a.example.com', isCurrent: false },
    { versionId: '20260908T180000Z-ef56ab78', createdAt: '2026-09-08T18:00:00.000Z', nodeCount: 40, sha256Prefix: 'c3d4e5f6', contentLength: 17988, sourceHost: 'airport-a.example.com', isCurrent: false }
  ];
  function envelope(body) {
    return { ok: true, status: 200, json: function () { return Promise.resolve(body); } };
  }
  function ok(data) { return envelope({ ok: true, data: data }); }
  window.fetch = function (url) {
    var u = String(url);
    if (u.indexOf('/api/auth/session') >= 0) return envelope({ data: { authenticated: true } });
    if (u.indexOf('/history') >= 0) return ok(history);
    if (u.indexOf('/api/providers') >= 0) return ok(providers);
    if (u.indexOf('/api/llm/keys') >= 0) return ok({ keys: keys, storeAvailable: true });
    if (u.indexOf('/api/webdav/config') >= 0) return ok({ url: 'https://dav.jianguoyun.com/dav/', username: 'me@example.com', password: '', remotePath: '/clash-verge-rev-backup/worker-backup.zip' });
    return ok({});
  };
  var m = location.search.match(/tab=([a-z-]+)/);
  if (m) {
    setTimeout(function () {
      var el = document.querySelector('[data-tab="' + m[1] + '"]');
      if (el) el.click();
    }, 150);
  }

  // Layout probe (?probe=1): list every element wider than the viewport, so a
  // stray horizontal overflow can be identified without a devtools session.
  if (location.search.indexOf('probe=1') >= 0) {
    setTimeout(function () {
      var vw = document.documentElement.clientWidth;
      var out = ['viewport=' + vw, 'docScrollWidth=' + document.documentElement.scrollWidth, 'bodyScrollWidth=' + document.body.scrollWidth];
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var r = all[i].getBoundingClientRect();
        if (r.right > vw + 1 || r.width > vw + 1) {
          var id = all[i].id ? '#' + all[i].id : '';
          var cls = all[i].className && typeof all[i].className === 'string' ? '.' + all[i].className.split(' ')[0] : '';
          out.push(all[i].tagName + id + cls + ' w=' + Math.round(r.width) + ' right=' + Math.round(r.right));
        }
      }
      var pre = document.createElement('pre');
      pre.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff;color:#000;font:12px/1.5 monospace;margin:0;padding:4px;max-height:100%;overflow:auto;border:1px solid #000';
      var probes = ['.container', 'h1', '.subtitle', '.tabs', '.card', '#providers-list', '#llm-keys-list', '#providers-list tbody tr'];
      for (var p = 0; p < probes.length; p++) {
        var node = document.querySelector(probes[p]);
        if (!node) continue;
        var rr = node.getBoundingClientRect();
        out.push(probes[p] + ' left=' + Math.round(rr.left) + ' right=' + Math.round(rr.right) + ' w=' + Math.round(rr.width) + ' scrollW=' + node.scrollWidth);
      }
      pre.textContent = out.slice(0, 40).join(String.fromCharCode(10));
      document.body.appendChild(pre);
    }, 900);
  }
})();
`;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(
      process.env.LOCALAPPDATA || "",
      "Google/Chrome/Application/chrome.exe",
    ),
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chrome/Edge binary found. Set CHROME_PATH to one, e.g. CHROME_PATH='/path/to/chrome'.",
  );
}

async function buildHtml() {
  const source = readFileSync(join(root, "src/ui/admin-html.ts"), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  mkdirSync(buildDir, { recursive: true });
  const modulePath = join(buildDir, "admin-html.mjs");
  writeFileSync(modulePath, code, "utf8");
  const { getAdminHtml } = await import(pathToFileURL(modulePath).href);

  const html = getAdminHtml();
  const head = html.indexOf("<head>");
  if (head < 0) throw new Error("admin html has no <head>");
  const injected =
    html.slice(0, head + "<head>".length) +
    "\n<script>\n" +
    FIXTURE +
    "\n</script>\n" +
    html.slice(head + "<head>".length);

  mkdirSync(outDir, { recursive: true });
  const pagePath = join(outDir, "admin-preview.html");
  writeFileSync(pagePath, injected, "utf8");
  return pagePath;
}

function capture(chrome, pagePath, size, label) {
  const [width, height] = size.split("x").map((value) => Number(value.trim()));
  if (!width || !height) throw new Error("invalid --size entry: " + size);
  const out = join(outDir, label + ".png");
  if (existsSync(out)) rmSync(out);
  const inner =
    pathToFileURL(pagePath).href +
    "?tab=" +
    encodeURIComponent(tab) +
    (probe ? "&probe=1" : "");

  // Chrome clamps its window width to roughly 500px, so a --window-size=390
  // capture is really a 390px crop of a 500px layout — which reads as the page
  // overflowing. Phone widths are rendered inside an iframe of the exact size so
  // the layout viewport (and therefore the media queries) is genuinely narrow.
  let url = inner;
  let shotWidth = width;
  if (width < 500) {
    const frame = join(outDir, "frame-" + label + ".html");
    writeFileSync(
      frame,
      '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}iframe{border:0;display:block;width:' +
        width +
        "px;height:" +
        height +
        'px}</style><iframe src="' +
        inner +
        '"></iframe>',
      "utf8",
    );
    url = pathToFileURL(frame).href;
    shotWidth = 500;
  }

  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--window-size=" + shotWidth + "," + height,
      "--virtual-time-budget=4000",
      "--screenshot=" + out,
      url,
    ],
    { stdio: "ignore" },
  );
  if (!existsSync(out)) throw new Error("screenshot failed for " + label);
  return out;
}

const chrome = findChrome();
const pagePath = await buildHtml();
console.log("preview page:", pagePath);
console.log("chrome:", chrome);

// Fail loudly rather than silently capturing the login form: a syntax error in
// the injected fixture leaves window.fetch untouched, the session check fails,
// and every screenshot would be of the wrong screen.
const rendered = execFileSync(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--virtual-time-budget=4000",
    "--dump-dom",
    pathToFileURL(pagePath).href + "?tab=" + encodeURIComponent(tab),
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (!rendered.includes('data-provider-slug="main"')) {
  throw new Error(
    "preview did not render the dashboard — check the injected fixture for a syntax error",
  );
}

for (const size of sizes) {
  const label = size + "-" + tab;
  const out = capture(chrome, pagePath, size, label);
  console.log("captured:", out);
}
if (!keep) {
  rmSync(buildDir, { recursive: true, force: true });
}
