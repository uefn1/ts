const $ = (id) => document.getElementById(id);

// URL パラメータで事前入力（?repo=owner/repo&tag=v1.0.0）
const params = new URLSearchParams(location.search);
if (params.get("repo")) $("repo").value = params.get("repo");
if (params.get("tag"))  $("tag").value  = params.get("tag");

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const [owner, repo] = $("repo").value.trim().split("/");
  const tag = $("tag").value.trim();
  try {
    await play(owner, repo, tag);
  } catch (err) {
    $("status").textContent = `エラー: ${err.message}`;
    console.error(err);
  }
});

async function play(owner, repo, tag) {
  $("status").textContent = "リリース情報を取得中...";

  // 1. リリース情報から .ts アセットを特定（API呼び出しはこの1回だけ）
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`
  );
  if (!res.ok) throw new Error(`リリース取得失敗 (${res.status})`);
  const release = await res.json();
  const asset = release.assets.find((a) => a.name.endsWith(".ts"));
  if (!asset) throw new Error(".ts アセットが見つかりません");

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
    // ① browser_download_url を直接使う（release-assets は CORS 対応）
    { url: asset.browser_download_url },
    // ② 失敗時: API エンドポイント + Accept ヘッダー
    {
      url: `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`,
      headers: { Accept: "application/octet-stream" },
    },
  ];

  let lastError = null;
  for (const c of candidates) {
    try {
      await tryPlay(video, c, asset);
      $("status").textContent =
        `再生中: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`;
      return;
    } catch (e) {
      console.warn("再生失敗:", c.url, e);
      lastError = e;
    }
  }
  throw new Error(`再生に失敗しました (${lastError?.message ?? "unknown"})`);
}

function tryPlay(video, candidate, asset) {
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
        seekType: "range", // Range リクエストでシーク
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
