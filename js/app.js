/**
 * アプリケーションメインエントリーポイント
 * 各モジュール（Crypto, Relay Transfer, WebRTC Engine, Signaling, UI）を連携
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. UIマネージャー初期化
  const ui = new UIManager();

  // 2. E2EEゼロ知識HTTPSリレーエンジン初期化（推奨メインモード）
  const relayTransfer = new E2EERelayTransfer();

  // 3. WebRTC転送エンジン初期化
  const engine = new P2PTransferEngine({
    onStatusChange: (state, info) => {
      console.log(`[App] WebRTCステータス: ${state}`);
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
      ui.updateTransferMonitor({
        ...fileData,
        progress: 100,
        transferredBytes: fileData.size,
        speed: 0,
        direction: 'receive',
        status: 'completed'
      });
      ui.addHistoryItem({ ...fileData, direction: 'receive' });
      ui.showToast(`ファイル「${fileData.name}」を受信しました`, 'info');
      setTimeout(() => ui.hideTransferMonitor(), 3000);
    },
    onTextReceived: (msgData) => {
      ui.addTextMessage(msgData, false);
      ui.showToast(`${msgData.sender}: ${msgData.text.substring(0, 20)}...`, 'info');
      const tabTextBtn = document.getElementById('tabTextBtn');
      if (tabTextBtn) tabTextBtn.click();
    },
    onError: (err) => {
      console.error('[App] WebRTCエラー:', err);
      ui.showToast(err.message || '通信エラー', 'error');
    }
  });

  // 4. シグナリングマネージャー初期化
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

  // 状態変数
  let selectedRelayFile = null;
  let stagedFiles = [];
  let isTransferring = false;

  // ========================================================================
  // DOM要素参照
  // ========================================================================
  const securityInfoBtn = document.getElementById('securityInfoBtn');
  const closeSecurityModalBtn = document.getElementById('closeSecurityModalBtn');
  const securityModal = document.getElementById('securityModal');

  // タブ切替
  const tabRelayBtn = document.getElementById('tabRelayBtn');
  const tabOnlineBtn = document.getElementById('tabOnlineBtn');
  const tabOfflineBtn = document.getElementById('tabOfflineBtn');
  const relayConnectView = document.getElementById('relayConnectView');
  const onlineConnectView = document.getElementById('onlineConnectView');
  const offlineConnectView = document.getElementById('offlineConnectView');

  // 高速E2EEリレー要素
  const relayDropzone = document.getElementById('relayDropzone');
  const relayFileInput = document.getElementById('relayFileInput');
  const relaySelectedFileName = document.getElementById('relaySelectedFileName');
  const relaySendPin = document.getElementById('relaySendPin');
  const genRelayPinBtn = document.getElementById('genRelayPinBtn');
  const startRelaySendBtn = document.getElementById('startRelaySendBtn');
  const relaySendResult = document.getElementById('relaySendResult');
  const relayResultQrcode = document.getElementById('relayResultQrcode');
  const relayResultPinText = document.getElementById('relayResultPinText');

  const relayReceiveUrlInput = document.getElementById('relayReceiveUrlInput');
  const openRelayScannerBtn = document.getElementById('openRelayScannerBtn');
  const relayReceivePin = document.getElementById('relayReceivePin');
  const startRelayReceiveBtn = document.getElementById('startRelayReceiveBtn');
  const relayReceiveResult = document.getElementById('relayReceiveResult');

  // 直接P2P要素
  const myPinCodeEl = document.getElementById('myPinCode');
  const qrcodeContainer = document.getElementById('qrcodeContainer');
  const copyPinBtn = document.getElementById('copyPinBtn');
  const refreshPinBtn = document.getElementById('refreshPinBtn');
  const targetPinInput = document.getElementById('targetPinInput');
  const connectPinBtn = document.getElementById('connectPinBtn');
  const cancelConnectBtn = document.getElementById('cancelConnectBtn');
  const openScannerBtn = document.getElementById('openScannerBtn');
  const stopScannerBtn = document.getElementById('stopScannerBtn');
  const closeScannerModalBtn = document.getElementById('closeScannerModalBtn');

  const connectionCard = document.getElementById('connectionCard');
  const connectedBanner = document.getElementById('connectedBanner');
  const mainWorkspace = document.getElementById('mainWorkspace');
  const disconnectBtn = document.getElementById('disconnectBtn');

  // オフライン手動SDP要素
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

  // P2Pワークスペース要素
  const tabFilesBtn = document.getElementById('tabFilesBtn');
  const tabTextBtn = document.getElementById('tabTextBtn');
  const filesView = document.getElementById('filesView');
  const textView = document.getElementById('textView');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const stagedFilesContainer = document.getElementById('stagedFilesContainer');
  const stagedList = document.getElementById('stagedList');
  const stagedFileCount = document.getElementById('stagedFileCount');
  const stagedTotalSize = document.getElementById('stagedTotalSize');
  const clearStagedBtn = document.getElementById('clearStagedBtn');
  const startSendFilesBtn = document.getElementById('startSendFilesBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const textMessageInput = document.getElementById('textMessageInput');
  const sendTextBtn = document.getElementById('sendTextBtn');

  // ========================================================================
  // 初期PIN生成（リレー用）
  // ========================================================================
  function generateRandomPin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
  if (relaySendPin) relaySendPin.value = generateRandomPin();

  // ========================================================================
  // イベントリスナーの即時・同期登録
  // ========================================================================

  // 1. メインタブ切替
  if (tabRelayBtn) {
    tabRelayBtn.addEventListener('click', () => {
      tabRelayBtn.classList.add('active');
      tabOnlineBtn.classList.remove('active');
      tabOfflineBtn.classList.remove('active');
      relayConnectView.classList.remove('hidden');
      onlineConnectView.classList.add('hidden');
      offlineConnectView.classList.add('hidden');
    });
  }

  if (tabOnlineBtn) {
    tabOnlineBtn.addEventListener('click', () => {
      tabOnlineBtn.classList.add('active');
      tabRelayBtn.classList.remove('active');
      tabOfflineBtn.classList.remove('active');
      onlineConnectView.classList.remove('hidden');
      relayConnectView.classList.add('hidden');
      offlineConnectView.classList.add('hidden');
    });
  }

  if (tabOfflineBtn) {
    tabOfflineBtn.addEventListener('click', () => {
      tabOfflineBtn.classList.add('active');
      tabRelayBtn.classList.remove('active');
      tabOnlineBtn.classList.remove('active');
      offlineConnectView.classList.remove('hidden');
      relayConnectView.classList.add('hidden');
      onlineConnectView.classList.add('hidden');
    });
  }

  // 2. 高速E2EEリレー送信
  if (relayDropzone && relayFileInput) {
    relayDropzone.addEventListener('click', () => relayFileInput.click());
    relayFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        selectedRelayFile = e.target.files[0];
        relaySelectedFileName.textContent = `${selectedRelayFile.name} (${ui.formatBytes(selectedRelayFile.size)})`;
        startRelaySendBtn.disabled = false;
      }
    });
  }

  if (genRelayPinBtn && relaySendPin) {
    genRelayPinBtn.addEventListener('click', () => {
      relaySendPin.value = generateRandomPin();
      ui.showToast('新しい暗号化PINを生成しました', 'info');
    });
  }

  if (startRelaySendBtn) {
    startRelaySendBtn.addEventListener('click', async () => {
      if (!selectedRelayFile) return;
      const pin = relaySendPin.value.trim();
      if (!pin || pin.length < 4) {
        ui.showToast('4桁以上のPINコードを入力してください', 'error');
        return;
      }

      startRelaySendBtn.disabled = true;
      startRelaySendBtn.textContent = '暗号化＆送信中...';

      try {
        ui.showToast('ブラウザ内でAES-256-GCM暗号化して送信中...', 'info');
        const result = await relayTransfer.sendFile(selectedRelayFile, pin, (progress) => {
          startRelaySendBtn.textContent = `${progress.status} (${progress.percent}%)`;
        });

        ui.showToast(`「${result.fileName}」の暗号化送信が完了しました！`, 'info');

        // 結果エリアとQRコード表示
        relaySendResult.classList.remove('hidden');
        relayResultPinText.textContent = pin;

        // スマホで一発受信できるURLをQR化
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('relay_token', result.token);
        currentUrl.searchParams.set('pin', pin);
        ui.renderQRCode(relayResultQrcode, currentUrl.toString(), 200);

      } catch (err) {
        console.error(err);
        ui.showToast(`送信エラー: ${err.message}`, 'error');
      } finally {
        startRelaySendBtn.disabled = false;
        startRelaySendBtn.textContent = '暗号化して高速送信';
      }
    });
  }

  // 3. 高速E2EEリレー受信
  if (startRelayReceiveBtn) {
    startRelayReceiveBtn.addEventListener('click', async () => {
      const urlOrToken = relayReceiveUrlInput.value.trim();
      const pin = relayReceivePin.value.trim();

      if (!urlOrToken) {
        ui.showToast('ダウンロードURLまたはコードを入力してください', 'error');
        return;
      }
      if (!pin || pin.length < 4) {
        ui.showToast('復号PINコードを入力してください', 'error');
        return;
      }

      startRelayReceiveBtn.disabled = true;
      startRelayReceiveBtn.textContent = '受信＆復号中...';
      relayReceiveResult.classList.add('hidden');

      try {
        ui.showToast('暗号化バイナリを受信してAES-256復号中...', 'info');
        const result = await relayTransfer.receiveFile(urlOrToken, pin, (progress) => {
          startRelayReceiveBtn.textContent = `${progress.status} (${progress.percent}%)`;
        });

        ui.showToast(`「${result.fileName}」の復号と完全性検証が完了しました！`, 'info');

        const downloadUrl = URL.createObjectURL(result.blob);
        relayReceiveResult.classList.remove('hidden');
        relayReceiveResult.innerHTML = `
          <div style="background: var(--bg-card); border: 1px solid var(--accent-blue); padding: 1.25rem; border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-weight: 600; color: var(--text-primary); font-size: 0.92rem;">${ui.escapeHtml(result.fileName)}</div>
              <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.35rem; font-family: var(--font-mono);">
                ${ui.formatBytes(result.size)} | SHA-256検証済 (${result.durationSeconds.toFixed(1)}秒)
              </div>
            </div>
            <a href="${downloadUrl}" download="${ui.escapeHtml(result.fileName)}" class="btn-primary" style="text-decoration: none; padding: 0.55rem 1.2rem;">
              保存
            </a>
          </div>
        `;

      } catch (err) {
        console.error(err);
        ui.showToast(`受信・復号失敗: ${err.message}`, 'error');
      } finally {
        startRelayReceiveBtn.disabled = false;
        startRelayReceiveBtn.textContent = '受信・復号して保存';
      }
    });
  }

  // リレー受信用QRスキャナー
  if (openRelayScannerBtn) {
    openRelayScannerBtn.addEventListener('click', () => {
      ui.startQRScanner(async (data) => {
        try {
          const url = new URL(data);
          const relayToken = url.searchParams.get('relay_token');
          const pin = url.searchParams.get('pin');
          if (relayToken) relayReceiveUrlInput.value = relayToken;
          if (pin) relayReceivePin.value = pin;
          ui.showToast('QRコードから受信情報を読み取りました', 'info');
        } catch (e) {
          relayReceiveUrlInput.value = data;
        }
      });
    });
  }

  // 4. 直接P2P接続制御
  async function executeP2PConnect(pin) {
    connectPinBtn.classList.add('hidden');
    cancelConnectBtn.classList.remove('hidden');
    targetPinInput.disabled = true;
    try {
      await signaling.joinSession(pin);
    } catch (e) {
      ui.showToast(e.message, 'error');
    } finally {
      connectPinBtn.classList.remove('hidden');
      cancelConnectBtn.classList.add('hidden');
      targetPinInput.disabled = false;
    }
  }

  if (connectPinBtn) {
    connectPinBtn.addEventListener('click', () => {
      const pin = targetPinInput.value.trim();
      if (!pin || pin.length < 4) {
        ui.showToast('PINコードを正しく入力してください', 'error');
        return;
      }
      executeP2PConnect(pin);
    });
  }

  if (cancelConnectBtn) {
    cancelConnectBtn.addEventListener('click', () => {
      signaling.cancelSession();
      ui.showToast('接続試行を中止しました', 'info');
      connectPinBtn.classList.remove('hidden');
      cancelConnectBtn.classList.add('hidden');
      targetPinInput.disabled = false;
    });
  }

  if (openScannerBtn) {
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
        executeP2PConnect(pinToUse);
      });
    });
  }

  if (stopScannerBtn) stopScannerBtn.addEventListener('click', () => ui.stopQRScanner());
  if (closeScannerModalBtn) closeScannerModalBtn.addEventListener('click', () => ui.stopQRScanner());

  if (copyPinBtn) {
    copyPinBtn.addEventListener('click', async () => {
      const pin = myPinCodeEl.textContent;
      if (pin && pin !== '------' && pin !== 'エラー') {
        await navigator.clipboard.writeText(pin);
        ui.showToast(`PINコード (${pin}) をコピーしました`, 'info');
      }
    });
  }

  if (refreshPinBtn) {
    refreshPinBtn.addEventListener('click', async () => {
      await initHostSession();
      ui.showToast('新しいPINコードを生成しました', 'info');
    });
  }

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => {
      if (confirm('接続を切断しますか？')) {
        engine.close();
        signaling.destroy();
        onDisconnectedState();
        initHostSession();
        ui.showToast('接続を切断しました', 'info');
      }
    });
  }

  // 5. オフライン手動SDP
  if (generateOfferBtn) {
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
  }

  if (copyOfferBtn) {
    copyOfferBtn.addEventListener('click', async () => {
      if (offerTextarea.value) {
        await navigator.clipboard.writeText(offerTextarea.value);
        ui.showToast('オファーSDPをコピーしました', 'info');
      }
    });
  }

  if (generateAnswerBtn) {
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
  }

  if (copyAnswerBtn) {
    copyAnswerBtn.addEventListener('click', async () => {
      if (answerTextarea.value) {
        await navigator.clipboard.writeText(answerTextarea.value);
        ui.showToast('アンサーSDPをコピーしました', 'info');
      }
    });
  }

  if (applyAnswerBtn) {
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
  }

  // 6. P2Pワークスペース操作
  if (tabFilesBtn) {
    tabFilesBtn.addEventListener('click', () => {
      tabFilesBtn.classList.add('active');
      tabTextBtn.classList.remove('active');
      filesView.classList.remove('hidden');
      textView.classList.add('hidden');
    });
  }

  if (tabTextBtn) {
    tabTextBtn.addEventListener('click', () => {
      tabTextBtn.classList.add('active');
      tabFilesBtn.classList.remove('active');
      textView.classList.remove('hidden');
      filesView.classList.add('hidden');
    });
  }

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
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
  }

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
        <button class="remove-staged-btn" data-index="${index}">削除</button>
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

  if (clearStagedBtn) {
    clearStagedBtn.addEventListener('click', () => {
      stagedFiles = [];
      renderStagedFiles();
    });
  }

  if (startSendFilesBtn) {
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
          console.error(err);
          ui.showToast(`送信失敗: ${err.message}`, 'error');
          break;
        }
      }
      stagedFiles = [];
      renderStagedFiles();
      isTransferring = false;
      startSendFilesBtn.disabled = false;
      setTimeout(() => ui.hideTransferMonitor(), 3000);
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      const list = document.getElementById('historyList');
      if (list) {
        list.innerHTML = `<p id="emptyHistoryNotice" style="color: var(--text-muted); font-size: 0.82rem; text-align: center; padding: 1.5rem 0;">転送履歴はありません</p>`;
        ui.showToast('履歴を消去しました', 'info');
      }
    });
  }

  async function handleSendTextMessage() {
    const text = textMessageInput.value.trim();
    if (!text) return;
    try {
      await engine.sendTextMessage(text, '送信');
      ui.addTextMessage({ sender: '送信', text: text, timestamp: Date.now() }, true);
      textMessageInput.value = '';
    } catch (e) {
      ui.showToast(`メッセージ送信失敗: ${e.message}`, 'error');
    }
  }

  if (sendTextBtn) sendTextBtn.addEventListener('click', handleSendTextMessage);
  if (textMessageInput) {
    textMessageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendTextMessage();
      }
    });
  }

  // モーダル
  if (securityInfoBtn) securityInfoBtn.addEventListener('click', () => securityModal.classList.add('open'));
  if (closeSecurityModalBtn) closeSecurityModalBtn.addEventListener('click', () => securityModal.classList.remove('open'));

  // ========================================================================
  // 接続状態ハンドラ関数
  // ========================================================================
  function onConnectedState(info) {
    connectionCard.classList.add('hidden');
    connectedBanner.classList.remove('hidden');
    mainWorkspace.classList.remove('hidden');

    const peerTitle = document.getElementById('connectedPeerTitle');
    const peerDesc = document.getElementById('connectedPeerDesc');
    const pinStr = signaling.currentPin ? `PIN: ${signaling.currentPin}` : 'P2P Direct';
    if (peerTitle) peerTitle.textContent = `P2P接続中 (${pinStr})`;
    if (info && peerDesc) {
      peerDesc.textContent = `経路: ${info.connectionType || 'P2P Direct'} | 遅延: ${info.rtt || '< 1 ms'}`;
    }
  }

  function onDisconnectedState() {
    connectionCard.classList.remove('hidden');
    connectedBanner.classList.add('hidden');
    mainWorkspace.classList.add('hidden');
  }

  // ========================================================================
  // 初期化＆URLパラメータ自動チェック
  // ========================================================================
  async function initHostSession() {
    try {
      const { pin } = await signaling.hostSession();
      myPinCodeEl.textContent = pin;
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('p2p_pin', pin);
      ui.renderQRCode(qrcodeContainer, currentUrl.toString(), 160);
    } catch (err) {
      console.warn('P2Pホスト初期化失敗 (リレーモード利用可能):', err);
      if (myPinCodeEl) myPinCodeEl.textContent = '---';
    }
  }

  async function checkUrlParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const relayToken = params.get('relay_token');
      const pin = params.get('pin');
      const p2pPin = params.get('p2p_pin');

      // 1. リレー受信パラメータがある場合
      if (relayToken && pin) {
        tabRelayBtn.click();
        relayReceiveUrlInput.value = relayToken;
        relayReceivePin.value = pin;
        ui.showToast(`PIN [${pin}] を読み込みました。「受信・復号して保存」を押してください`, 'info');
      }
      // 2. P2P接続パラメータがある場合
      else if (p2pPin && p2pPin.length === 6) {
        tabOnlineBtn.click();
        targetPinInput.value = p2pPin;
        ui.showToast(`P2P PIN [${p2pPin}] を読み込みました。接続中...`, 'info');
        executeP2PConnect(p2pPin);
      } 
      // 3. 通常起動時
      else {
        initHostSession();
      }
    } catch (e) {
      console.error('URLパラメータチェックエラー:', e);
    }
  }

  // 初期化実行
  setTimeout(() => {
    checkUrlParams();
  }, 10);

});
