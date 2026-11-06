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

  const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/tag\/(.+?)\/?$/);
  if (!m) {
    throw new Error(
      "リリースのURLを入力してください（例: https://github.com/owner/repo/releases/tag/v1.0.0）"
    );
  }

  const [, owner, repo, rawTag] = m;
  const tag = decodeURIComponent(rawTag);
  return { owner, repo, tag };
}

/**
 * iOS Safari の MSE / ManagedMediaSource 対応状況を判定する
 */
function checkVideoPlaybackSupport() {
  // iOS 17.1+ では ManagedMediaSource が利用可能
  const hasManagedMSE = "ManagedMediaSource" in window;
  // デスクトップや iPadOS など従来の MSE
  const hasNativeMSE = mpegts.getFeatureList().mseLivePlayback;

  if (!hasManagedMSE && !hasNativeMSE) {
    throw new Error(
      "このブラウザは動画再生に必要なAPIに対応していません。" +
        "iOS 17.1 以降の Safari、または最新のデスクトップブラウザでお試しください。"
    );
  }
  return { hasManagedMSE, hasNativeMSE };
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
  const asset = assets[0];

  // 2. ブラウザの再生能力をチェック（iOS Safari では特に重要）
  const { hasManagedMSE } = checkVideoPlaybackSupport();

  const video = $("video");
  if (window.__player) {
    window.__player.destroy();
    window.__player = null;
  }

  // iOS Safari ではユーザー操作なしの play() が拒否されることがあるため、
  // muted 状態を明示的に維持する
  video.muted = true;

  /*
   * CORS 対策:
   * browser_download_url は release-assets.githubusercontent.com にリダイレクトされ、
   * CORS ヘッダーが付与されないため使用しない。
   * GitHub API のアセットエンドポイントは Accept: application/octet-stream を付けると
   * リダイレクト先も含めて CORS ヘッダーが返る。
   */
  const apiUrl =
    `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`;

  const candidate = {
    url: apiUrl,
    headers: { Accept: "application/octet-stream" },
  };

  try {
    await tryPlay(video, candidate, hasManagedMSE);
    $("status").textContent =
      `再生中: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)` +
      (hasManagedMSE ? " [iOS ManagedMediaSource]" : "");
  } catch (e) {
    console.error("再生失敗:", e);
    throw new Error(
      `再生に失敗しました (${e.message})。` +
        "動画のコーデックが H.264/AAC であること、iOS 17.1 以降であることをご確認ください。"
    );
  }
}

function tryPlay(video, candidate, hasManagedMSE) {
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
        // iOS Safari (ManagedMediaSource) では Worker 経由の MSE を有効化
        enableWorker: true,
        enableWorkerForMSE: hasManagedMSE,
        // Range リクエストは CORS プリフライトを誘発するため使用しない
        // seekType: "range" は指定しない
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
      // iOS Safari では自動再生がブロックされる場合があるため、
      // ユーザーが再度再生ボタンを押せるようにする
      video.play().catch((err) => {
        console.warn("自動再生がブロックされました:", err);
      });
      resolve();
    };

    player.on(mpegts.Events.ERROR, onError);
    player.on(mpegts.Events.MEDIA_INFO, onLoaded);

    player.attachMediaElement(video);
    player.load();

    // 読み込み直後に play() を試みる（muted なので iOS でも許可されやすい）
    player.play().catch((e) => console.warn("play() rejected:", e));
  });
}
