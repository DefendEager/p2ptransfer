/**
 * 厳格セキュリティ下モード：超高速動的QRコード光転送エンジン
 * 
 * ネットワーク通信（Wi-Fi, 4G, 外部サーバー, プロキシ）を1バイトも使わず、
 * 画面の高速アニメーションQRコード ➔ カメラ連写スキャンによる光通信で
 * ファイルおよびテキストを安全・確実に転送します。
 * 
 * 【最適化技術】
 * 1. Web標準 CompressionStream('gzip') によるリアルタイムデータ圧縮
 * 2. 高密度チャンキング（1コマ 600〜800バイト）と可変フレームレート（10〜20fps）
 * 3. パケットヘッダーによるフレーム順不同・重複受信耐性
 * 4. SHA-256 完全性自動検証
 */

class DynamicQRTransfer {
  constructor(options = {}) {
    this.options = options;
    this.animationTimer = null;
    this.isTransmitting = false;
    this.isReceiving = false;
    this.scannerStream = null;

    // 送信データ状態
    this.sendChunks = [];
    this.sendIndex = 0;
    this.fps = options.fps || 12; // 1秒あたりのコマ数

    // 受信データ状態
    this.receiveSession = null;
  }

  /**
   * データをGzip圧縮します
   * @param {Uint8Array} rawBytes
   * @returns {Promise<Uint8Array>}
   */
  async compress(rawBytes) {
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Response(rawBytes).body.pipeThrough(new CompressionStream('gzip'));
      const compressedBuffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(compressedBuffer);
    }
    return rawBytes;
  }

  /**
   * Gzip圧縮データを解凍します
   * @param {Uint8Array} compressedBytes
   * @returns {Promise<Uint8Array>}
   */
  async decompress(compressedBytes) {
    if (typeof DecompressionStream !== 'undefined') {
      const stream = new Response(compressedBytes).body.pipeThrough(new DecompressionStream('gzip'));
      const decompressedBuffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(decompressedBuffer);
    }
    return compressedBytes;
  }

  /**
   * ファイルまたはテキストから動的QR送信パケット群を生成します
   * @param {File|string} input - 送信対象ファイルまたはテキスト
   * @param {Object} [meta] - ファイル名やタイプ
   */
  async prepareTransmission(input, meta = {}) {
    let rawBytes;
    let fileName = meta.name || 'text_message.txt';
    let fileType = meta.type || 'text/plain';
    let isText = typeof input === 'string';

    if (isText) {
      rawBytes = new TextEncoder().encode(input);
      fileName = 'shared_text.txt';
      fileType = 'text/plain';
    } else {
      rawBytes = new Uint8Array(await input.arrayBuffer());
      fileName = input.name;
      fileType = input.type || 'application/octet-stream';
    }

    // 1. SHA-256 ハッシュを計算
    const sha256 = await TransferCrypto.calculateSHA256(new Blob([rawBytes]));

    // 2. Gzipリアルタイム圧縮
    const compressedBytes = await this.compress(rawBytes);

    // 3. Base64化
    let binaryStr = '';
    const len = compressedBytes.byteLength;
    for (let i = 0; i < len; i++) {
      binaryStr += String.fromCharCode(compressedBytes[i]);
    }
    const base64Data = btoa(binaryStr);

    // 4. チャンク分割（1コマ約650文字）
    const CHUNK_CHAR_SIZE = 650;
    const totalChunks = Math.ceil(base64Data.length / CHUNK_CHAR_SIZE) || 1;
    const sessionId = Math.random().toString(36).substring(2, 8);

    this.sendChunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunkSlice = base64Data.substring(i * CHUNK_CHAR_SIZE, (i + 1) * CHUNK_CHAR_SIZE);
      
      // パケットフォーマット: GOV|sessionId|total|index|rawSize|sha256Prefix|fileName|chunk
      const packetStr = `GOV|${sessionId}|${totalChunks}|${i}|${rawBytes.byteLength}|${sha256.substring(0, 16)}|${encodeURIComponent(fileName)}|${chunkSlice}`;
      this.sendChunks.push(packetStr);
    }

    this.sendIndex = 0;
    return {
      totalChunks,
      rawSize: rawBytes.byteLength,
      compressedSize: compressedBytes.byteLength,
      fileName,
      sha256
    };
  }

  /**
   * Canvas / DOM要素上に高速動的QRコードのアニメーション描画を開始します
   * @param {HTMLElement} containerEl - QR描画コンテナ
   * @param {Function} [onProgress] - コマ進捗通知コールバック
   */
  startTransmission(containerEl, onProgress) {
    this.stopTransmission();
    if (this.sendChunks.length === 0) return;

    this.isTransmitting = true;
    const total = this.sendChunks.length;
    const intervalMs = Math.round(1000 / this.fps);

    // QRコードインスタンス生成用一時要素
    const renderNextFrame = () => {
      if (!this.isTransmitting) return;

      const packet = this.sendChunks[this.sendIndex];
      containerEl.innerHTML = '';

      if (typeof QRCode !== 'undefined') {
        new QRCode(containerEl, {
          text: packet,
          width: 260,
          height: 260,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.L // 最大データ容量を確保
        });
      }

      if (onProgress) {
        onProgress({
          current: this.sendIndex + 1,
          total: total,
          percent: Math.round(((this.sendIndex + 1) / total) * 100)
        });
      }

      // 次のフレームへ（ループ再生）
      this.sendIndex = (this.sendIndex + 1) % total;
      this.animationTimer = setTimeout(renderNextFrame, intervalMs);
    };

    renderNextFrame();
  }

  /**
   * 送信アニメーションを停止します
   */
  stopTransmission() {
    this.isTransmitting = false;
    if (this.animationTimer) {
      clearTimeout(this.animationTimer);
      this.animationTimer = null;
    }
  }

  /**
   * カメラを起動して動的QRコードの高速連続スキャン＆復元を開始します
   * @param {HTMLVideoElement} videoEl
   * @param {Function} onProgress - 受信進捗コールバック
   * @param {Function} onComplete - 復元完了コールバック
   * @param {Function} onError - エラーコールバック
   */
  async startReceiving(videoEl, onProgress, onComplete, onError) {
    this.stopReceiving();
    this.isReceiving = true;
    this.receiveSession = null;

    try {
      this.scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      videoEl.srcObject = this.scannerStream;
      await videoEl.play();

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const scanLoop = async () => {
        if (!this.isReceiving) return;

        if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
          canvas.width = videoEl.videoWidth;
          canvas.height = videoEl.videoHeight;
          ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (typeof jsQR !== 'undefined') {
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert'
            });

            if (code && code.data && code.data.startsWith('GOV|')) {
              await this.handleReceivedPacket(code.data, onProgress, onComplete, onError);
            }
          }
        }

        if (this.isReceiving) {
          requestAnimationFrame(scanLoop);
        }
      };

      requestAnimationFrame(scanLoop);
    } catch (err) {
      console.error('動的QRスキャンカメラ起動失敗:', err);
      if (onError) onError(new Error('カメラの起動に失敗しました'));
      this.stopReceiving();
    }
  }

  /**
   * 受信したパケットを処理し、全チャンクが集まったら復元します
   */
  async handleReceivedPacket(packetStr, onProgress, onComplete, onError) {
    try {
      const parts = packetStr.split('|');
      if (parts.length < 8) return;

      const [tag, sessionId, totalStr, indexStr, rawSizeStr, shaPrefix, encodedFileName, chunkData] = parts;
      const total = parseInt(totalStr, 10);
      const index = parseInt(indexStr, 10);
      const rawSize = parseInt(rawSizeStr, 10);
      const fileName = decodeURIComponent(encodedFileName);

      // 新規セッション開始
      if (!this.receiveSession || this.receiveSession.sessionId !== sessionId) {
        this.receiveSession = {
          sessionId,
          total,
          rawSize,
          shaPrefix,
          fileName,
          chunks: new Array(total).fill(null),
          receivedCount: 0,
          startTime: performance.now()
        };
      }

      // 未取得チャンクを保存
      if (this.receiveSession.chunks[index] === null) {
        this.receiveSession.chunks[index] = chunkData;
        this.receiveSession.receivedCount++;

        const percent = Math.round((this.receiveSession.receivedCount / total) * 100);
        if (onProgress) {
          onProgress({
            received: this.receiveSession.receivedCount,
            total: total,
            percent: percent,
            fileName: fileName,
            rawSize: rawSize
          });
        }

        // 全チャンク収集完了
        if (this.receiveSession.receivedCount === total) {
          console.log('[DynamicQR] 全チャンク収集完了。復元開始...');
          this.stopReceiving();

          // 1. Base64結合
          const fullBase64 = this.receiveSession.chunks.join('');
          const binaryStr = atob(fullBase64);
          const compressedBytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            compressedBytes[i] = binaryStr.charCodeAt(i);
          }

          // 2. Gzip解凍
          const decompressedBytes = await this.decompress(compressedBytes);

          // 3. Blob生成
          const fileBlob = new Blob([decompressedBytes]);

          // 4. SHA-256検証
          const fullHash = await TransferCrypto.calculateSHA256(fileBlob);
          const hashMatch = fullHash.startsWith(this.receiveSession.shaPrefix);

          if (onComplete) {
            onComplete({
              blob: fileBlob,
              fileName: this.receiveSession.fileName,
              size: decompressedBytes.byteLength,
              sha256: fullHash,
              hashMatch: hashMatch,
              durationSeconds: (performance.now() - this.receiveSession.startTime) / 1000
            });
          }
        }
      }
    } catch (e) {
      console.error('動的QRパケット処理エラー:', e);
    }
  }

  /**
   * 受信スキャンを停止します
   */
  stopReceiving() {
    this.isReceiving = false;
    if (this.scannerStream) {
      this.scannerStream.getTracks().forEach(track => track.stop());
      this.scannerStream = null;
    }
  }
}

window.DynamicQRTransfer = DynamicQRTransfer;
