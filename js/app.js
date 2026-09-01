/**
 * アプリケーションメインエントリーポイント
 * 各モジュール（Crypto, WebRTC Engine, Signaling, DynamicQR, UI）を連携し、
 * イベントハンドリング、ファイルドラッグ＆ドロップ、複数送信キュー等を制御します。
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. UIマネージャー初期化
  const ui = new UIManager();

  // 2. 動的QR光転送エンジン初期化（厳格セキュリティ下モード用）
  const dynamicQr = new DynamicQRTransfer();

  // 3. WebRTC転送エンジン初期化
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

      // テキスト受信時に自動でテキストタブに切り替え
      const tabTextBtn = document.getElementById('tabTextBtn');
      if (tabTextBtn) {
        tabTextBtn.click();
      }
    },
    onError: (err) => {
      console.error('[App] エラー:', err);
      ui.showToast(err.message || '通信エラーが発生しました', 'error');
    },
    onStatsUpdate: (stats) => {
      updateLiveStats(stats);
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

  // 送信待機中ファイルキュー
  let stagedFiles = [];
  let isTransferring = false;
  let selectedStrictFile = null;

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
  const cancelConnectBtn = document.getElementById('cancelConnectBtn');
  const openScannerBtn = document.getElementById('openScannerBtn');
  const stopScannerBtn = document.getElementById('stopScannerBtn');
  const closeScannerModalBtn = document.getElementById('closeScannerModalBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const networkStatsBtn = document.getElementById('networkStatsBtn');

  // 接続モードタブ (オンライン / オフライン / 厳格セキュリティ下)
  const tabOnlineBtn = document.getElementById('tabOnlineBtn');
  const tabOfflineBtn = document.getElementById('tabOfflineBtn');
  const tabStrictQrBtn = document.getElementById('tabStrictQrBtn');
  const onlineConnectView = document.getElementById('onlineConnectView');
  const offlineConnectView = document.getElementById('offlineConnectView');
  const strictQrConnectView = document.getElementById('strictQrConnectView');

  // オフライン接続関連
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

  // 厳格セキュリティ下 (動的QR) 関連要素
  const tabQrSendBtn = document.getElementById('tabQrSendBtn');
  const tabQrReceiveBtn = document.getElementById('tabQrReceiveBtn');
  const qrSendPanel = document.getElementById('qrSendPanel');
  const qrReceivePanel = document.getElementById('qrReceivePanel');
  const selectQrFileBtn = document.getElementById('selectQrFileBtn');
  const strictQrFileInput = document.getElementById('strictQrFileInput');
  const startQrSendBtn = document.getElementById('startQrSendBtn');
  const stopQrSendBtn = document.getElementById('stopQrSendBtn');
  const strictQrFileInfo = document.getElementById('strictQrFileInfo');
  const strictQrFileName = document.getElementById('strictQrFileName');
  const strictQrFileSize = document.getElementById('strictQrFileSize');
  const dynamicQrDisplayArea = document.getElementById('dynamicQrDisplayArea');
  const dynamicQrContainer = document.getElementById('dynamicQrContainer');
  const qrFrameCurrent = document.getElementById('qrFrameCurrent');
  const qrFrameTotal = document.getElementById('qrFrameTotal');
  const qrFramePercent = document.getElementById('qrFramePercent');

  const startQrReceiveBtn = document.getElementById('startQrReceiveBtn');
  const stopQrReceiveBtn = document.getElementById('stopQrReceiveBtn');
  const qrScannerContainer = document.getElementById('qrScannerContainer');
  const strictQrVideo = document.getElementById('strictQrVideo');
  const strictReceiveCount = document.getElementById('strictReceiveCount');
  const strictReceiveTotal = document.getElementById('strictReceiveTotal');
  const strictReceivePercent = document.getElementById('strictReceivePercent');
  const strictReceiveProgressFill = document.getElementById('strictReceiveProgressFill');
  const strictReceiveFileName = document.getElementById('strictReceiveFileName');
  const strictReceiveResult = document.getElementById('strictReceiveResult');

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
  // イベントリスナーの即時登録（非同期処理の成否に依存させない最優先登録）
  // ========================================================================

  // 1. 接続タブ切替 (オンライン / オフライン / 厳格セキュリティ下)
  if (tabOnlineBtn) {
    tabOnlineBtn.addEventListener('click', () => {
      tabOnlineBtn.classList.add('active');
      tabOfflineBtn.classList.remove('active');
      tabStrictQrBtn.classList.remove('active');
      onlineConnectView.classList.remove('hidden');
      offlineConnectView.classList.add('hidden');
      strictQrConnectView.classList.add('hidden');
    });
  }

  if (tabOfflineBtn) {
    tabOfflineBtn.addEventListener('click', () => {
      tabOfflineBtn.classList.add('active');
      tabOnlineBtn.classList.remove('active');
      tabStrictQrBtn.classList.remove('active');
      offlineConnectView.classList.remove('hidden');
      onlineConnectView.classList.add('hidden');
      strictQrConnectView.classList.add('hidden');
    });
  }

  if (tabStrictQrBtn) {
    tabStrictQrBtn.addEventListener('click', () => {
      tabStrictQrBtn.classList.add('active');
      tabOnlineBtn.classList.remove('active');
      tabOfflineBtn.classList.remove('active');
      strictQrConnectView.classList.remove('hidden');
      onlineConnectView.classList.add('hidden');
      offlineConnectView.classList.add('hidden');
    });
  }

  // 2. 厳格セキュリティ下（動的QR）サブタブ切替
  if (tabQrSendBtn) {
    tabQrSendBtn.addEventListener('click', () => {
      tabQrSendBtn.classList.add('active');
      tabQrReceiveBtn.classList.remove('active');
      qrSendPanel.classList.remove('hidden');
      qrReceivePanel.classList.add('hidden');
      dynamicQr.stopReceiving();
    });
  }

  if (tabQrReceiveBtn) {
    tabQrReceiveBtn.addEventListener('click', () => {
      tabQrReceiveBtn.classList.add('active');
      tabQrSendBtn.classList.remove('active');
      qrReceivePanel.classList.remove('hidden');
      qrSendPanel.classList.add('hidden');
      dynamicQr.stopTransmission();
    });
  }

  // 3. 動的QRファイル選択・送信
  if (selectQrFileBtn && strictQrFileInput) {
    selectQrFileBtn.addEventListener('click', () => strictQrFileInput.click());

    strictQrFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        selectedStrictFile = e.target.files[0];
        strictQrFileName.textContent = selectedStrictFile.name;
        strictQrFileSize.textContent = ui.formatBytes(selectedStrictFile.size);
        strictQrFileInfo.classList.remove('hidden');
        startQrSendBtn.disabled = false;
      }
    });
  }

  if (startQrSendBtn) {
    startQrSendBtn.addEventListener('click', async () => {
      if (!selectedStrictFile) return;

      const densitySelect = document.getElementById('qrDensitySelect');
      const fpsSelect = document.getElementById('qrFpsSelect');
      if (densitySelect) dynamicQr.setDensityMode(densitySelect.value);
      if (fpsSelect) dynamicQr.setFps(parseInt(fpsSelect.value, 10));

      startQrSendBtn.classList.add('hidden');
      stopQrSendBtn.classList.remove('hidden');
      dynamicQrDisplayArea.classList.remove('hidden');

      try {
        ui.showToast('ファイルをGzip圧縮して動的QRパケットを構築中...', 'info');
        const prep = await dynamicQr.prepareTransmission(selectedStrictFile);
        qrFrameTotal.textContent = prep.totalChunks;

        dynamicQr.startTransmission(dynamicQrContainer, (progress) => {
          qrFrameCurrent.textContent = progress.current;
          qrFramePercent.textContent = `${progress.percent}%`;
        });
        ui.showToast(`動的QR送信を開始しました (全${prep.totalChunks}コマ)`, 'info');
      } catch (err) {
        console.error(err);
        ui.showToast(`動的QR送信エラー: ${err.message}`, 'error');
        startQrSendBtn.classList.remove('hidden');
        stopQrSendBtn.classList.add('hidden');
      }
    });
  }

  if (stopQrSendBtn) {
    stopQrSendBtn.addEventListener('click', () => {
      dynamicQr.stopTransmission();
      startQrSendBtn.classList.remove('hidden');
      stopQrSendBtn.classList.add('hidden');
      dynamicQrDisplayArea.classList.add('hidden');
      ui.showToast('動的QR送信を停止しました', 'info');
    });
  }

  // 4. 動的QRカメラ受信
  if (startQrReceiveBtn) {
    startQrReceiveBtn.addEventListener('click', async () => {
      startQrReceiveBtn.classList.add('hidden');
      stopQrReceiveBtn.classList.remove('hidden');
      qrScannerContainer.classList.remove('hidden');
      strictReceiveResult.classList.add('hidden');

      await dynamicQr.startReceiving(
        strictQrVideo,
        (progress) => {
          strictReceiveCount.textContent = progress.received;
          strictReceiveTotal.textContent = progress.total;
          strictReceivePercent.textContent = `${progress.percent}%`;
          strictReceiveProgressFill.style.width = `${progress.percent}%`;
          strictReceiveFileName.textContent = `受信中: ${progress.fileName} (${ui.formatBytes(progress.rawSize)})`;
        },
        (completeData) => {
          ui.showToast(`「${completeData.fileName}」の復元が完了しました`, 'info');
          startQrReceiveBtn.classList.remove('hidden');
          stopQrReceiveBtn.classList.add('hidden');

          const downloadUrl = URL.createObjectURL(completeData.blob);
          strictReceiveResult.classList.remove('hidden');
          strictReceiveResult.innerHTML = `
            <div style="background: var(--bg-card); border: 1px solid var(--accent-blue); padding: 1rem; border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center;">
              <div>
                <div style="font-weight: 600; color: var(--text-primary); font-size: 0.88rem;">${ui.escapeHtml(completeData.fileName)}</div>
                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.2rem; font-family: var(--font-mono);">
                  ${ui.formatBytes(completeData.size)} | SHA-256検証済 (${completeData.durationSeconds.toFixed(1)}秒)
                </div>
              </div>
              <a href="${downloadUrl}" download="${ui.escapeHtml(completeData.fileName)}" class="btn-primary" style="text-decoration: none; padding: 0.45rem 1rem;">
                保存
              </a>
            </div>
          `;
        },
        (err) => {
          ui.showToast(err.message, 'error');
          startQrReceiveBtn.classList.remove('hidden');
          stopQrReceiveBtn.classList.add('hidden');
        }
      );
    });
  }

  if (stopQrReceiveBtn) {
    stopQrReceiveBtn.addEventListener('click', () => {
      dynamicQr.stopReceiving();
      startQrReceiveBtn.classList.remove('hidden');
      stopQrReceiveBtn.classList.add('hidden');
      ui.showToast('スキャンを停止しました', 'info');
    });
  }

  // 5. 接続ボタン ＆ キャンセル制御
  async function executeConnect(pin) {
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
      executeConnect(pin);
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

  // 6. QRコードスキャナーモーダル
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
        executeConnect(pinToUse);
      });
    });
  }

  if (stopScannerBtn) stopScannerBtn.addEventListener('click', () => ui.stopQRScanner());
  if (closeScannerModalBtn) closeScannerModalBtn.addEventListener('click', () => ui.stopQRScanner());

  // 7. PINコピー・再生成
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

  // 8. 切断ボタン
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

  // 9. オフライン手動SDP
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

  // 10. メイン作業エリアタブ (ファイル / テキスト)
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

  // 11. ファイルドラッグ＆ドロップ
  if (dropzone && fileInput) {
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

  if (clearStagedBtn) {
    clearStagedBtn.addEventListener('click', () => {
      stagedFiles = [];
      renderStagedFiles();
    });
  }

  // 12. ファイル送信実行
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
  }

  if (clearHistoryBtn) {
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
  }

  // 13. テキスト送信
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

  if (sendTextBtn) sendTextBtn.addEventListener('click', handleSendTextMessage);

  if (textMessageInput) {
    textMessageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendTextMessage();
      }
    });
  }

  // 14. モーダル
  if (securityInfoBtn) securityInfoBtn.addEventListener('click', () => securityModal.classList.add('open'));
  if (networkStatsBtn) networkStatsBtn.addEventListener('click', () => securityModal.classList.add('open'));
  if (closeSecurityModalBtn) closeSecurityModalBtn.addEventListener('click', () => securityModal.classList.remove('open'));

  // ========================================================================
  // 接続状態ハンドラ関数
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
  // 初期化＆ホストセッション（全イベント登録後に安全に非同期実行）
  // ========================================================================
  async function initHostSession() {
    try {
      const { pin } = await signaling.hostSession();
      myPinCodeEl.textContent = pin;
      
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('pin', pin);
      ui.renderQRCode(qrcodeContainer, currentUrl.toString());
      console.log(`[App] ホストセッション開始 PIN: ${pin}`);
    } catch (err) {
      console.error('ホストセッション初期化失敗:', err);
      myPinCodeEl.textContent = 'エラー';
      ui.showToast('シグナリング待機中（厳格セキュリティ下モード利用可能）', 'info');
    }
  }

  async function checkUrlParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const pin = params.get('pin');
      if (pin && pin.length === 6) {
        targetPinInput.value = pin;
        ui.showToast(`PIN [${pin}] を読み込みました。接続中...`, 'info');
        executeConnect(pin);
      } else {
        await initHostSession();
      }
    } catch (e) {
      console.error('URLチェックエラー:', e);
    }
  }

  // 非同期起動（UIの即時操作性を阻害しない）
  setTimeout(() => {
    checkUrlParams();
  }, 10);

});
