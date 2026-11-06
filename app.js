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
  return { owner, repo, tag: decodeURIComponent(rawTag) };
}

/**
 * ブラウザの再生能力を判定する
 * エラーメッセージを具体的にすることで、原因の切り分けを容易にする
 */
function checkPlaybackSupport() {
  const hasManagedMSE = typeof self.ManagedMediaSource === "function";
  const hasNativeMSE =
    typeof self.MediaSource === "function" &&
    mpegts.getFeatureList().mseLivePlayback;

  if (!hasManagedMSE && !hasNativeMSE) {
    throw new Error(
      "このブラウザは動画再生に必要な MediaSource API に対応していません。" +
        "iOS 17.1 以降の Safari、または最新のデスクトップブラウザでお試しください。"
    );
  }
  return { hasManagedMSE, hasNativeMSE };
}

async function play(owner, repo, tag) {
  $("status").textContent = `リリース情報を取得中... (${owner}/${repo} @ ${tag})`;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`
  );
  if (res.status === 404) {
    throw new Error(`リリースが見つかりません: ${owner}/${repo} @ ${tag}`);
  }
  if (!res.ok) throw new Error(`リリース取得失敗 (${res.status})`);

  const release = await res.json();
  const assets = release.assets.filter((a) => a.name.endsWith(".ts"));
  if (assets.length === 0) throw new Error(".ts アセットが見つかりません");

  const asset = assets[0];
  const { hasManagedMSE } = checkPlaybackSupport();

  const video = $("video");
  if (window.__player) {
    window.__player.destroy();
    window.__player = null;
  }
  video.muted = true;

  // CORS 対策: API アセットエンドポイント + Accept ヘッダー
  const apiUrl =
    `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`;

  try {
    await tryPlay(video, {
      url: apiUrl,
      headers: { Accept: "application/octet-stream" },
    });
    $("status").textContent =
      `再生中: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)` +
      (hasManagedMSE ? " [iOS ManagedMediaSource]" : "");
  } catch (e) {
    console.error("再生失敗:", e);
    // InvalidStateError は SourceBuffer の状態管理に起因する
    const hint =
      e.name === "InvalidStateError"
        ? "（MSE バッファの初期化に失敗しました。ページを再読み込みしてから再度お試しください）"
        : "（動画のコーデックが H.264/AAC であること、iOS 17.1 以降であることをご確認ください）";
    throw new Error(`再生に失敗しました: ${e.message} ${hint}`);
  }
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
        // enableWorkerForMSE は iOS Safari で ManagedMediaSource との
        // 組み合わせにおいて不安定なため、デフォルト（false）のままにする[reference:3]。
        // seekType: "range" も CORS プリフライトを誘発するため指定しない。
      }
    );

    const cleanup = () => {
      player.off(mpegts.Events.ERROR, onError);
      player.off(mpegts.Events.MEDIA_INFO, onLoaded);
    };

    const onError = (type, detail) => {
      cleanup();
      player.destroy();
      // detail が文字列でない場合（オブジェクトなど）も安全にメッセージ化する
      const message = typeof detail === "string" ? detail : (detail?.message ?? type);
      const err = new Error(message);
      // mpegts.js が投げるエラー種別を保持して呼び出し側で判定できるようにする
      err.name = type;
      reject(err);
    };

    const onLoaded = () => {
      cleanup();
      window.__player = player;
      video.play().catch((err) => console.warn("自動再生がブロックされました:", err));
      resolve();
    };

    player.on(mpegts.Events.ERROR, onError);
    player.on(mpegts.Events.MEDIA_INFO, onLoaded);

    player.attachMediaElement(video);
    player.load();
    player.play().catch((e) => console.warn("play() rejected:", e));
  });
}
