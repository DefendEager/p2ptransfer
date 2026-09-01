/**
 * UI管理・インタラクション・描画・QRコード制御モジュール
 */

class UIManager {
  constructor() {
    // テーマ設定
    this.currentTheme = localStorage.getItem('govp2p-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', this.currentTheme);

    // QRスキャナー制御用
    this.scannerStream = null;
    this.isScanning = false;
    this.scanCallback = null;

    // 指数移動平均（EMA）による滑らかな速度計算用
    this.speedEma = 0;
    this.EMA_ALPHA = 0.3; // スムージング係数
  }

  /**
   * テーマの切り替え（ダーク/ライト）
   */
  toggleTheme() {
    this.currentTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', this.currentTheme);
    localStorage.setItem('govp2p-theme', this.currentTheme);
    this.showToast(`テーマを${this.currentTheme === 'dark' ? 'ダーク' : 'ライト'}に変更しました`, 'info');
  }

  /**
   * トースト通知を表示
   * @param {string} message - メッセージ
   * @param {'success'|'error'|'info'} type - 種類
   * @param {number} [duration=3500] - 表示時間(ms)
   */
  showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';

    toast.innerHTML = `<span>${icon}</span><span>${this.escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(30px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  /**
   * QRコードを描画します。
   * @param {HTMLElement} element - 描画先DOM要素
   * @param {string} text - QRに埋め込むテキスト（URLまたはPIN）
   * @param {number} [size=160] - サイズ(px)
   */
  renderQRCode(element, text, size = 160) {
    if (!element) return;
    element.innerHTML = ''; // 既存をクリア

    if (typeof QRCode !== 'undefined') {
      new QRCode(element, {
        text: text,
        width: size,
        height: size,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      element.innerHTML = '<span style="color: red; font-size: 0.75rem;">QRCodeライブラリが読み込まれていません</span>';
    }
  }

  /**
   * カメラを起動してQRコードをスキャンします（jsQR使用）
   * @param {Function} onResult - QRコード検出時のコールバック
   */
  async startQRScanner(onResult) {
    const video = document.getElementById('scannerVideo');
    const modal = document.getElementById('scannerModal');
    if (!video || !modal) return;

    this.scanCallback = onResult;
    modal.classList.add('open');

    try {
      this.scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' } // 背面カメラ優先
      });
      video.srcObject = this.scannerStream;
      await video.play();

      this.isScanning = true;
      this.scanQRFrame();
    } catch (err) {
      console.error('カメラ起動エラー:', err);
      this.showToast('カメラへのアクセスが拒否されたか、利用できません', 'error');
      this.stopQRScanner();
    }
  }

  /**
   * QRコードフレーム読み取りループ
   */
  scanQRFrame() {
    if (!this.isScanning) return;

    const video = document.getElementById('scannerVideo');
    if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) {
      requestAnimationFrame(() => this.scanQRFrame());
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (typeof jsQR !== 'undefined') {
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert'
      });

      if (code && code.data) {
        console.log('[QR Scanner] QRコード検出:', code.data);
        this.stopQRScanner();
        if (this.scanCallback) {
          this.scanCallback(code.data);
        }
        return;
      }
    }

    requestAnimationFrame(() => this.scanQRFrame());
  }

  /**
   * QRスキャナーを停止しモーダルを閉じます
   */
  stopQRScanner() {
    this.isScanning = false;
    if (this.scannerStream) {
      this.scannerStream.getTracks().forEach(track => track.stop());
      this.scannerStream = null;
    }
    const modal = document.getElementById('scannerModal');
    if (modal) modal.classList.remove('open');
  }

  /**
   * 転送モニターの表示更新
   */
  updateTransferMonitor(data) {
    const monitor = document.getElementById('transferMonitor');
    if (!monitor) return;

    monitor.classList.remove('hidden');

    const fileNameEl = document.getElementById('monitorFileName');
    const badgeEl = document.getElementById('monitorStatusBadge');
    const dirIconEl = document.getElementById('monitorDirectionIcon');
    const speedEl = document.getElementById('monitorSpeed');
    const etaEl = document.getElementById('monitorEta');
    const percentEl = document.getElementById('monitorProgressPercent');
    const fillEl = document.getElementById('monitorProgressFill');
    const sizeEl = document.getElementById('monitorTransferredSize');
    const shaEl = document.getElementById('monitorSha256');

    if (fileNameEl) fileNameEl.textContent = data.name;
    if (dirIconEl) dirIconEl.textContent = data.direction === 'send' ? '📤 送信:' : '📥 受信:';
    
    // ステータスバッジ
    if (badgeEl) {
      if (data.status === 'hashing') {
        badgeEl.textContent = 'SHA-256計算中';
      } else if (data.status === 'verifying') {
        badgeEl.textContent = '完全性検証中';
      } else if (data.status === 'completed') {
        badgeEl.textContent = '完了';
      } else {
        badgeEl.textContent = data.direction === 'send' ? '高速送信中' : '受信中';
      }
    }

    // スムーズな速度計算 (EMA)
    if (data.speed > 0) {
      this.speedEma = this.speedEma === 0 ? data.speed : (this.EMA_ALPHA * data.speed + (1 - this.EMA_ALPHA) * this.speedEma);
    }
    if (speedEl) speedEl.textContent = this.formatSpeed(this.speedEma);

    // 残り時間（ETA）
    if (etaEl) {
      if (this.speedEma > 0 && data.size > data.transferredBytes) {
        const remainingBytes = data.size - data.transferredBytes;
        const remainingSeconds = Math.ceil(remainingBytes / this.speedEma);
        etaEl.textContent = `残り約 ${this.formatTime(remainingSeconds)}`;
      } else if (data.progress >= 100) {
        etaEl.textContent = '完了';
      } else {
        etaEl.textContent = '残り --秒';
      }
    }

    // 進捗バー
    const progress = Math.min(100, Math.max(0, data.progress));
    if (percentEl) percentEl.textContent = `${progress.toFixed(1)}%`;
    if (fillEl) fillEl.style.width = `${progress}%`;
    if (sizeEl) sizeEl.textContent = `${this.formatBytes(data.transferredBytes)} / ${this.formatBytes(data.size)}`;

    if (shaEl && data.sha256) {
      shaEl.textContent = `SHA-256: ${data.sha256.substring(0, 16)}...`;
      shaEl.title = `SHA-256完全ハッシュ: ${data.sha256}`;
    }
  }

  /**
   * 転送モニターを隠す
   */
  hideTransferMonitor() {
    const monitor = document.getElementById('transferMonitor');
    if (monitor) monitor.classList.add('hidden');
    this.speedEma = 0;
  }

  /**
   * 受信済みファイル / 送信履歴リストにアイテムを追加
   */
  addHistoryItem(item) {
    const list = document.getElementById('historyList');
    const emptyNotice = document.getElementById('emptyHistoryNotice');
    if (!list) return;
    if (emptyNotice) emptyNotice.remove();

    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';

    const isReceive = item.direction === 'receive';
    const icon = isReceive ? '📥' : '📤';
    const actionLabel = isReceive ? '受信' : '送信';

    let downloadButtonHtml = '';
    if (isReceive && item.blob) {
      const downloadUrl = URL.createObjectURL(item.blob);
      downloadButtonHtml = `
        <a href="${downloadUrl}" download="${this.escapeHtml(item.name)}" class="btn-primary" style="padding: 0.35rem 0.85rem; font-size: 0.78rem; text-decoration: none;">
          💾 保存する
        </a>
      `;
    }

    const verifyBadgeHtml = item.hashMatch !== undefined ? `
      <span class="sha256-badge ${item.hashMatch ? 'verified' : ''}">
        ${item.hashMatch ? '✓ SHA-256検証済(改ざん無)' : '⚠️ ハッシュ不一致'}
      </span>
    ` : '';

    historyItem.innerHTML = `
      <div class="file-info-group">
        <span style="font-size: 1.3rem;">${icon}</span>
        <div class="file-meta-text">
          <span class="file-name">${this.escapeHtml(item.name)}</span>
          <div style="display: flex; gap: 0.6rem; align-items: center; margin-top: 0.2rem;">
            <span class="file-size">${this.formatBytes(item.size)}</span>
            <span style="font-size: 0.72rem; color: var(--text-muted);">(${actionLabel} / ${item.durationSeconds ? item.durationSeconds.toFixed(1) + 's' : ''})</span>
            ${verifyBadgeHtml}
          </div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        ${downloadButtonHtml}
      </div>
    `;

    list.prepend(historyItem);
  }

  /**
   * テキストチャットメッセージを描画
   */
  addTextMessage(msg, isSelf = false) {
    const box = document.getElementById('textHistoryBox');
    if (!box) return;

    // 初期案内メッセージを削除
    const guide = box.querySelector('div[style*="text-align: center"]');
    if (guide) guide.remove();

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isSelf ? 'sent' : 'received'}`;

    const timeStr = new Date(msg.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

    bubble.innerHTML = `
      <div class="chat-meta">
        <strong>${this.escapeHtml(msg.sender)}</strong>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <span>${timeStr}</span>
          <button class="copy-text-btn" style="background: none; border: none; cursor: pointer; font-size: 0.8rem;" title="クリップボードにコピー">📋</button>
        </div>
      </div>
      <div class="chat-content">${this.escapeHtml(msg.text)}</div>
    `;

    // コピーボタン動作
    const copyBtn = bubble.querySelector('.copy-text-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(msg.text);
          this.showToast('クリップボードにコピーしました', 'success');
        } catch (e) {
          this.showToast('コピーに失敗しました', 'error');
        }
      });
    }

    box.appendChild(bubble);
    box.scrollTop = box.scrollHeight; // 最下部にスクロール
  }

  /**
   * バイト数を可読形式（KB, MB, GB）に変換
   */
  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 転送速度（Bytes/s）を可読形式（KB/s, MB/s）に変換
   */
  formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec === 0) return '0.0 MB/s';
    if (bytesPerSec < 1024 * 1024) {
      return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    }
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  }

  /**
   * 秒数を MM:SS または 秒形式に変換
   */
  formatTime(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}分${s}秒`;
  }

  /**
   * XSS防止用 HTML エスケープ
   */
  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

window.UIManager = UIManager;
