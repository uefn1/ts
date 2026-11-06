const $ = (id) => document.getElementById(id);

// ?url=... で事前入力
const params = new URLSearchParams(location.search);
if (params.get("url")) $("releaseUrl").value = params.get("url");

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const { owner, repo, tag } = parseReleaseUrl($("releaseUrl").value.trim());
    await play(owner, repo, tag);
  } catch (err) {
    $("status").textContent = `エラー: ${err.message}`;
    console.error(err);
  }
});

/**
 * GitHubリリースURLをパースする
 * 対応形式:
 *   https://github.com/{owner}/{repo}/releases/tag/{tag}
 *   https://github.com/{owner}/{repo}/releases/tag/{tag}/  (末尾スラッシュ)
 *   https://github.com/{owner}/{repo}/releases/tag/{tag}?foo=bar
 *   github.com/{owner}/{repo}/releases/tag/{tag}          (スキーム省略)
 */
function parseReleaseUrl(input) {
  let url;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new Error("URLの形式が正しくありません");
  }

  if (!/(^|\.)github\.com$/.test(url.hostname)) {
    throw new Error("github.com のURLを入力してください");
  }

  // /owner/repo/releases/tag/tag を抽出
  const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/tag\/(.+?)\/?$/);
  if (!m) {
    throw new Error(
      "リリースのURLを入力してください（例: https://github.com/owner/repo/releases/tag/v1.0.0）"
    );
  }

  const [, owner, repo, rawTag] = m;
  // タグにエンコードされた文字（%2Fなど）をデコード
  const tag = decodeURIComponent(rawTag);
  return { owner, repo, tag };
}

async function play(owner, repo, tag) {
  $("status").textContent = `リリース情報を取得中... (${owner}/${repo} @ ${tag})`;

  // 1. リリース情報から .ts アセットを特定
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`
  );
  if (res.status === 404) {
    throw new Error(`リリースが見つかりません: ${owner}/${repo} @ ${tag}`);
  }
  if (!res.ok) throw new Error(`リリース取得失敗 (${res.status})`);

  const release = await res.json();
  const assets = release.assets.filter((a) => a.name.endsWith(".ts"));

  if (assets.length === 0) {
    throw new Error(".ts アセットが見つかりません");
  }
  // 複数ある場合は最初の .ts を使用（必要なら選択UIを追加）
  const asset = assets[0];

  if (!mpegts.getFeatureList().mseLivePlayback) {
    throw new Error("このブラウザは MSE に対応していません");
  }

  const video = $("video");
  if (window.__player) {
    window.__player.destroy();
    window.__player = null;
  }

  // 2. 候補URLを順に試す
  const candidates = [
    { url: asset.browser_download_url },
    {
      url: `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`,
      headers: { Accept: "application/octet-stream" },
    },
  ];

  let lastError = null;
  for (const c of candidates) {
    try {
      await tryPlay(video, c);
      $("status").textContent =
        `再生中: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)` +
        (assets.length > 1 ? ` ※他${assets.length - 1}件の.tsあり` : "");
      return;
    } catch (e) {
      console.warn("再生失敗:", c.url, e);
      lastError = e;
    }
  }
  throw new Error(`再生に失敗しました (${lastError?.message ?? "unknown"})`);
}

function tryPlay(video, candidate) {
  return new Promise((resolve, reject) => {
    const player = mpegts.createPlayer(
      {
        type: "mse",
        isLive: false,
        url: candidate.url,
        cors: true,
        ...(candidate.headers ? { headers: candidate.headers } : {}),
      },
      {
        enableWorker: true,
        seekType: "range",
      }
    );

    const cleanup = () => {
      player.off(mpegts.Events.ERROR, onError);
      player.off(mpegts.Events.MEDIA_INFO, onLoaded);
    };
    const onError = (type, detail) => {
      cleanup();
      player.destroy();
      reject(new Error(`${type}: ${detail}`));
    };
    const onLoaded = () => {
      cleanup();
      window.__player = player;
      resolve();
    };

    player.on(mpegts.Events.ERROR, onError);
    player.on(mpegts.Events.MEDIA_INFO, onLoaded);

    player.attachMediaElement(video);
    player.load();
    player.play().catch((e) => console.warn("play() rejected:", e));
  });
}
