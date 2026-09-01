/**
 * アプリケーションメインエントリーポイント
 * 各モジュール（Crypto, WebRTC Engine, Signaling, UI）を連携し、
 * イベントハンドリング、ファイルドラッグ＆ドロップ、複数送信キュー等を制御します。
 */

document.addEventListener('DOMContentLoaded', async () => {
  // 1. UIマネージャー初期化
  const ui = new UIManager();

  // 2. WebRTC転送エンジン初期化
  const engine = new P2PTransferEngine({
    onStatusChange: (state, info) => {
      console.log(`[App] 接続ステータス変更: ${state}`);
      if (state === 'open' || state === 'connected' || state === 'completed') {
        onConnectedState(info);
      } else if (state === 'closed' || state === 'failed' || state === 'disconnected') {
        onDisconnectedState();
      }
    },
    onFileProgress: (progressData) => {
      ui.updateTransferMonitor(progressData);
    },
    onFileReceived: (fileData) => {
      console.log('[App] ファイル受信完了:', fileData.name);
      ui.updateTransferMonitor({
        ...fileData,
        progress: 100,
        transferredBytes: fileData.size,
        speed: 0,
        direction: 'receive',
        status: 'completed'
      });

      ui.addHistoryItem({
        ...fileData,
        direction: 'receive'
      });

      ui.showToast(`ファイル「${fileData.name}」を受信しました`, 'info');
      setTimeout(() => ui.hideTransferMonitor(), 3000);
    },
    onTextReceived: (msgData) => {
      ui.addTextMessage(msgData, false);
      ui.showToast(`${msgData.sender}: ${msgData.text.substring(0, 20)}...`, 'info');
    },
    onError: (err) => {
      console.error('[App] エラー:', err);
      ui.showToast(err.message || '通信エラーが発生しました', 'error');
    },
    onStatsUpdate: (stats) => {
      updateLiveStats(stats);
    }
  });

  // 3. シグナリングマネージャー初期化
  const signaling = new SignalingManager({
    engine: engine,
    onConnected: (info) => {
      ui.showToast('端末とのP2P直接接続が確立しました', 'info');
      onConnectedState(info);
    },
    onDisconnected: () => {
      ui.showToast('ピア接続が切断されました', 'error');
      onDisconnectedState();
    },
    onError: (err) => {
      ui.showToast(err.message || 'シグナリングエラー', 'error');
    }
  });

  // 送信待機中ファイルキュー
  let stagedFiles = [];
  let isTransferring = false;

  // ========================================================================
  // DOM要素参照
  // ========================================================================
  const securityInfoBtn = document.getElementById('securityInfoBtn');
  const closeSecurityModalBtn = document.getElementById('closeSecurityModalBtn');
  const securityModal = document.getElementById('securityModal');

  // 接続関連要素
  const connectionCard = document.getElementById('connectionCard');
  const connectedBanner = document.getElementById('connectedBanner');
  const mainWorkspace = document.getElementById('mainWorkspace');
  const myPinCodeEl = document.getElementById('myPinCode');
  const qrcodeContainer = document.getElementById('qrcodeContainer');
  const copyPinBtn = document.getElementById('copyPinBtn');
  const refreshPinBtn = document.getElementById('refreshPinBtn');
  const targetPinInput = document.getElementById('targetPinInput');
  const connectPinBtn = document.getElementById('connectPinBtn');
  const openScannerBtn = document.getElementById('openScannerBtn');
  const stopScannerBtn = document.getElementById('stopScannerBtn');
  const closeScannerModalBtn = document.getElementById('closeScannerModalBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const networkStatsBtn = document.getElementById('networkStatsBtn');

  // オフライン接続関連
  const tabOnlineBtn = document.getElementById('tabOnlineBtn');
  const tabOfflineBtn = document.getElementById('tabOfflineBtn');
  const onlineConnectView = document.getElementById('onlineConnectView');
  const offlineConnectView = document.getElementById('offlineConnectView');
  const generateOfferBtn = document.getElementById('generateOfferBtn');
  const offerOutputGroup = document.getElementById('offerOutputGroup');
  const offerTextarea = document.getElementById('offerTextarea');
  const copyOfferBtn = document.getElementById('copyOfferBtn');
  const inputOfferTextarea = document.getElementById('inputOfferTextarea');
  const generateAnswerBtn = document.getElementById('generateAnswerBtn');
  const answerOutputGroup = document.getElementById('answerOutputGroup');
  const answerTextarea = document.getElementById('answerTextarea');
  const copyAnswerBtn = document.getElementById('copyAnswerBtn');
  const applyAnswerInput = document.getElementById('applyAnswerInput');
  const applyAnswerBtn = document.getElementById('applyAnswerBtn');

  // 作業エリア関連
  const tabFilesBtn = document.getElementById('tabFilesBtn');
  const tabTextBtn = document.getElementById('tabTextBtn');
  const filesView = document.getElementById('filesView');
  const textView = document.getElementById('textView');

  // ファイル操作関連
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const stagedFilesContainer = document.getElementById('stagedFilesContainer');
  const stagedList = document.getElementById('stagedList');
  const stagedFileCount = document.getElementById('stagedFileCount');
  const stagedTotalSize = document.getElementById('stagedTotalSize');
  const clearStagedBtn = document.getElementById('clearStagedBtn');
  const startSendFilesBtn = document.getElementById('startSendFilesBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');

  // テキスト共有関連
  const textMessageInput = document.getElementById('textMessageInput');
  const sendTextBtn = document.getElementById('sendTextBtn');

  // ========================================================================
  // 初期化＆ホストセッション開始
  // ========================================================================
  async function initHostSession() {
    try {
      const { pin } = await signaling.hostSession();
      myPinCodeEl.textContent = pin;
      
      // QRコードの生成（URLクエリパラメータ付き）
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('pin', pin);
      ui.renderQRCode(qrcodeContainer, currentUrl.toString());
      console.log(`[App] ホストセッション開始 PIN: ${pin}, URL: ${currentUrl.toString()}`);
    } catch (err) {
      console.error('ホストセッション初期化失敗:', err);
      myPinCodeEl.textContent = 'エラー';
      ui.showToast('シグナリング待機中（オフラインモード利用可能）', 'info');
    }
  }

  // URLクエリパラメータからPINをチェックして自動接続
  async function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const pin = params.get('pin');
    if (pin && pin.length === 6) {
      targetPinInput.value = pin;
      ui.showToast(`PIN [${pin}] を読み込みました。接続中...`, 'info');
      try {
        await signaling.joinSession(pin);
      } catch (e) {
        ui.showToast(e.message, 'error');
      }
    } else {
      await initHostSession();
    }
  }

  await checkUrlParams();

  // ========================================================================
  // 接続状態ハンドラ
  // ========================================================================
  function onConnectedState(info) {
    connectionCard.classList.add('hidden');
    connectedBanner.classList.remove('hidden');
    mainWorkspace.classList.remove('hidden');

    const secTag = document.getElementById('headerSecurityTag');
    const secText = document.getElementById('securityText');
    if (secTag && secText) {
      secText.textContent = 'E2EE AES-256 接続中';
    }

    const peerTitle = document.getElementById('connectedPeerTitle');
    const peerDesc = document.getElementById('connectedPeerDesc');
    const pinStr = signaling.currentPin ? `PIN: ${signaling.currentPin}` : 'P2P Direct';
    if (peerTitle) peerTitle.textContent = `接続中 (${pinStr})`;
    
    if (info && peerDesc) {
      peerDesc.textContent = `経路: ${info.connectionType || 'P2P Direct'} | 遅延: ${info.rtt || '< 1 ms'}`;
    }
  }

  function onDisconnectedState() {
    connectionCard.classList.remove('hidden');
    connectedBanner.classList.add('hidden');
    mainWorkspace.classList.add('hidden');

    const secTag = document.getElementById('headerSecurityTag');
    const secText = document.getElementById('securityText');
    if (secTag && secText) {
      secText.textContent = 'E2EE 256bit 待機中';
    }
  }

  function updateLiveStats(stats) {
    const statsEl = document.getElementById('statsContent');
    if (!statsEl) return;
    statsEl.innerHTML = `
      状態: ${stats.dataChannelState === 'open' ? '通信可能' : stats.dataChannelState}<br>
      経路: ${stats.connectionType}<br>
      遅延: ${stats.rtt}<br>
      暗号化: Web Crypto AES-256-GCM + DTLS
    `;
  }

  // ========================================================================
  // イベントリスナー
  // ========================================================================

  // セキュリティ仕様モーダル
  if (securityInfoBtn) securityInfoBtn.addEventListener('click', () => securityModal.classList.add('open'));
  if (networkStatsBtn) networkStatsBtn.addEventListener('click', () => securityModal.classList.add('open'));
  if (closeSecurityModalBtn) closeSecurityModalBtn.addEventListener('click', () => securityModal.classList.remove('open'));

  // PINコピー・再生成
  copyPinBtn.addEventListener('click', async () => {
    const pin = myPinCodeEl.textContent;
    if (pin && pin !== '------' && pin !== 'エラー') {
      await navigator.clipboard.writeText(pin);
      ui.showToast(`PINコード (${pin}) をコピーしました`, 'info');
    }
  });

  refreshPinBtn.addEventListener('click', async () => {
    await initHostSession();
    ui.showToast('新しいPINコードを生成しました', 'info');
  });

  // PIN接続ボタン
  connectPinBtn.addEventListener('click', async () => {
    const pin = targetPinInput.value.trim();
    if (!pin || pin.length < 4) {
      ui.showToast('PINコードを正しく入力してください', 'error');
      return;
    }
    connectPinBtn.disabled = true;
    connectPinBtn.textContent = '接続中...';
    try {
      await signaling.joinSession(pin);
    } catch (e) {
      ui.showToast(e.message, 'error');
    } finally {
      connectPinBtn.disabled = false;
      connectPinBtn.textContent = '接続';
    }
  });

  // QRコードスキャナー起動
  openScannerBtn.addEventListener('click', () => {
    ui.startQRScanner(async (data) => {
      let pinToUse = data;
      try {
        const url = new URL(data);
        const pinFromUrl = url.searchParams.get('pin');
        if (pinFromUrl) pinToUse = pinFromUrl;
      } catch (e) {}

      targetPinInput.value = pinToUse;
      ui.showToast(`PIN [${pinToUse}] を読み取りました。接続中...`, 'info');
      try {
        await signaling.joinSession(pinToUse);
      } catch (e) {
        ui.showToast(e.message, 'error');
      }
    });
  });

  stopScannerBtn.addEventListener('click', () => ui.stopQRScanner());
  closeScannerModalBtn.addEventListener('click', () => ui.stopQRScanner());

  // 切断ボタン
  disconnectBtn.addEventListener('click', () => {
    if (confirm('接続を切断しますか？')) {
      engine.close();
      signaling.destroy();
      onDisconnectedState();
      initHostSession();
      ui.showToast('接続を切断しました', 'info');
    }
  });

  // 接続タブ切替 (オンライン / オフライン)
  tabOnlineBtn.addEventListener('click', () => {
    tabOnlineBtn.classList.add('active');
    tabOfflineBtn.classList.remove('active');
    onlineConnectView.classList.remove('hidden');
    offlineConnectView.classList.add('hidden');
  });

  tabOfflineBtn.addEventListener('click', () => {
    tabOfflineBtn.classList.add('active');
    tabOnlineBtn.classList.remove('active');
    offlineConnectView.classList.remove('hidden');
    onlineConnectView.classList.add('hidden');
  });

  // オフラインシグナリング: オファー生成
  generateOfferBtn.addEventListener('click', async () => {
    generateOfferBtn.disabled = true;
    generateOfferBtn.textContent = '生成中...';
    try {
      const offerBase64 = await signaling.createOfflineOffer();
      offerTextarea.value = offerBase64;
      offerOutputGroup.classList.remove('hidden');
      ui.showToast('オファーSDPを生成しました', 'info');
    } catch (e) {
      ui.showToast(`オファー生成失敗: ${e.message}`, 'error');
    } finally {
      generateOfferBtn.disabled = false;
      generateOfferBtn.textContent = 'オファーSDPを生成';
    }
  });

  copyOfferBtn.addEventListener('click', async () => {
    if (offerTextarea.value) {
      await navigator.clipboard.writeText(offerTextarea.value);
      ui.showToast('オファーSDPをコピーしました', 'info');
    }
  });

  // オフラインシグナリング: アンサー生成
  generateAnswerBtn.addEventListener('click', async () => {
    const offerStr = inputOfferTextarea.value.trim();
    if (!offerStr) {
      ui.showToast('オファーSDPを入力してください', 'error');
      return;
    }
    generateAnswerBtn.disabled = true;
    generateAnswerBtn.textContent = '生成中...';
    try {
      const answerBase64 = await signaling.createOfflineAnswer(offerStr);
      answerTextarea.value = answerBase64;
      answerOutputGroup.classList.remove('hidden');
      ui.showToast('アンサーSDPを生成しました', 'info');
    } catch (e) {
      ui.showToast(`アンサー生成失敗: ${e.message}`, 'error');
    } finally {
      generateAnswerBtn.disabled = false;
      generateAnswerBtn.textContent = 'アンサーSDPを生成';
    }
  });

  copyAnswerBtn.addEventListener('click', async () => {
    if (answerTextarea.value) {
      await navigator.clipboard.writeText(answerTextarea.value);
      ui.showToast('アンサーSDPをコピーしました', 'info');
    }
  });

  // オフラインシグナリング: アンサー適用
  applyAnswerBtn.addEventListener('click', async () => {
    const answerStr = applyAnswerInput.value.trim();
    if (!answerStr) {
      ui.showToast('アンサーSDPを入力してください', 'error');
      return;
    }
    try {
      await signaling.applyOfflineAnswer(answerStr);
      ui.showToast('アンサーを適用しました。接続待機中...', 'info');
    } catch (e) {
      ui.showToast(`アンサー適用失敗: ${e.message}`, 'error');
    }
  });

  // 作業タブ切替 (ファイル共有 / テキスト共有)
  tabFilesBtn.addEventListener('click', () => {
    tabFilesBtn.classList.add('active');
    tabTextBtn.classList.remove('active');
    filesView.classList.remove('hidden');
    textView.classList.add('hidden');
  });

  tabTextBtn.addEventListener('click', () => {
    tabTextBtn.classList.add('active');
    tabFilesBtn.classList.remove('active');
    textView.classList.remove('hidden');
    filesView.classList.add('hidden');
  });

  // ========================================================================
  // ファイルドラッグ＆ドロップ ＆ 複数ファイル選択
  // ========================================================================
  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToStage(Array.from(e.dataTransfer.files));
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToStage(Array.from(e.target.files));
      fileInput.value = '';
    }
  });

  function addFilesToStage(files) {
    stagedFiles.push(...files);
    renderStagedFiles();
  }

  function renderStagedFiles() {
    stagedList.innerHTML = '';
    if (stagedFiles.length === 0) {
      stagedFilesContainer.classList.add('hidden');
      return;
    }

    stagedFilesContainer.classList.remove('hidden');
    stagedFileCount.textContent = stagedFiles.length;

    let totalBytes = 0;
    stagedFiles.forEach((file, index) => {
      totalBytes += file.size;
      const itemEl = document.createElement('div');
      itemEl.className = 'staged-file-item';
      itemEl.innerHTML = `
        <div class="file-info-group">
          <div class="file-meta-text">
            <span class="file-name">${ui.escapeHtml(file.name)}</span>
            <span class="file-size">${ui.formatBytes(file.size)}</span>
          </div>
        </div>
        <button class="remove-staged-btn" data-index="${index}" title="削除">削除</button>
      `;
      stagedList.appendChild(itemEl);
    });

    stagedTotalSize.textContent = ui.formatBytes(totalBytes);

    stagedList.querySelectorAll('.remove-staged-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        stagedFiles.splice(idx, 1);
        renderStagedFiles();
      });
    });
  }

  clearStagedBtn.addEventListener('click', () => {
    stagedFiles = [];
    renderStagedFiles();
  });

  // ========================================================================
  // 高速ファイル送信キュー制御
  // ========================================================================
  startSendFilesBtn.addEventListener('click', async () => {
    if (isTransferring || stagedFiles.length === 0) return;

    isTransferring = true;
    startSendFilesBtn.disabled = true;
    const filesToSend = [...stagedFiles];

    for (let i = 0; i < filesToSend.length; i++) {
      const file = filesToSend[i];
      try {
        ui.showToast(`[${i+1}/${filesToSend.length}] 「${file.name}」の送信を開始`, 'info');
        const result = await engine.sendFile(file);

        ui.addHistoryItem({
          name: file.name,
          size: file.size,
          type: file.type,
          sha256: result.sha256,
          hashMatch: true,
          durationSeconds: result.durationSeconds,
          direction: 'send'
        });

        ui.showToast(`「${file.name}」の送信が完了しました`, 'info');
      } catch (err) {
        console.error('ファイル送信エラー:', err);
        ui.showToast(`「${file.name}」の送信に失敗しました: ${err.message}`, 'error');
        break;
      }
    }

    stagedFiles = [];
    renderStagedFiles();
    isTransferring = false;
    startSendFilesBtn.disabled = false;
    setTimeout(() => ui.hideTransferMonitor(), 3000);
  });

  // 履歴クリア
  clearHistoryBtn.addEventListener('click', () => {
    const list = document.getElementById('historyList');
    if (list) {
      list.innerHTML = `
        <p id="emptyHistoryNotice" style="color: var(--text-muted); font-size: 0.82rem; text-align: center; padding: 1.5rem 0;">
          転送履歴はありません
        </p>
      `;
      ui.showToast('履歴を消去しました', 'info');
    }
  });

  // ========================================================================
  // テキストメッセージ送信
  // ========================================================================
  async function handleSendTextMessage() {
    const text = textMessageInput.value.trim();
    if (!text) return;

    try {
      await engine.sendTextMessage(text, '送信');
      ui.addTextMessage({
        sender: '送信',
        text: text,
        timestamp: Date.now()
      }, true);

      textMessageInput.value = '';
    } catch (e) {
      ui.showToast(`メッセージ送信失敗: ${e.message}`, 'error');
    }
  }

  sendTextBtn.addEventListener('click', handleSendTextMessage);

  textMessageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendTextMessage();
    }
  });

});
