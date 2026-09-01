/**
 * 厳格セキュリティ下モード：超高速動的QRコード光転送エンジン
 * 
 * ネットワーク通信（Wi-Fi, 4G, 外部サーバー, プロキシ）を1バイトも使わず、
 * 画面の動的QRコード ➔ カメラ連写スキャンによる光通信で
 * ファイルおよびテキストを安全・確実に転送します。
 * 
 * 【低画質PCカメラ・ボケ対応の最適化】
 * 1. 超低密度モード（1コマ120〜200文字）: ドットを巨大化し、480p固定焦点カメラでも一瞬で認識
 * 2. コマ送り速度（FPS: 3〜15fps）の可変調整
 * 3. スキャン画像前処理（コントラスト補正・二値化支援）による認識率向上
 * 4. Web標準 CompressionStream('gzip') によるリアルタイムデータ圧縮
 * 5. SHA-256 完全性自動検証
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
    this.fps = options.fps || 8; // デフォルトは認識しやすい8fps
    this.densityMode = options.densityMode || 'low'; // low(低画質カメラ用), medium(標準), high(高解像度用)

    // 受信データ状態
    this.receiveSession = null;
  }

  setFps(fps) {
    this.fps = Math.max(2, Math.min(20, fps));
  }

  setDensityMode(mode) {
    this.densityMode = mode;
  }

  /**
   * データをGzip圧縮します
   */
  async compress(rawBytes) {
    if (typeof CompressionStream !== 'undefined') {
      try {
        const stream = new Response(rawBytes).body.pipeThrough(new CompressionStream('gzip'));
        const compressedBuffer = await new Response(stream).arrayBuffer();
        return new Uint8Array(compressedBuffer);
      } catch (e) {
        console.warn('Gzip圧縮フォールバック:', e);
      }
    }
    return rawBytes;
  }

  /**
   * Gzip圧縮データを解凍します
   */
  async decompress(compressedBytes) {
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const stream = new Response(compressedBytes).body.pipeThrough(new DecompressionStream('gzip'));
        const decompressedBuffer = await new Response(stream).arrayBuffer();
        return new Uint8Array(decompressedBuffer);
      } catch (e) {
        console.warn('Gzip解凍フォールバック:', e);
      }
    }
    return compressedBytes;
  }

  /**
   * ファイルまたはテキストから動的QR送信パケット群を生成します
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

    // 4. 密度モードに応じたチャンクサイズ決定（低画質カメラ用は1コマ約160文字に極小化）
    let chunkSize = 160; // low: ドットが超巨大になり、低画質PCカメラでも確実に認識可能
    if (this.densityMode === 'medium') chunkSize = 350;
    if (this.densityMode === 'high') chunkSize = 650;

    const totalChunks = Math.ceil(base64Data.length / chunkSize) || 1;
    const sessionId = Math.random().toString(36).substring(2, 7);

    this.sendChunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunkSlice = base64Data.substring(i * chunkSize, (i + 1) * chunkSize);
      
      // パケットフォーマット: G|sessionId|total|index|shaPrefix|fileName|chunk
      const packetStr = `G|${sessionId}|${totalChunks}|${i}|${sha256.substring(0, 12)}|${encodeURIComponent(fileName)}|${chunkSlice}`;
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
   * Canvas / DOM要素上に動的QRコードのアニメーション描画を開始
   */
  startTransmission(containerEl, onProgress) {
    this.stopTransmission();
    if (this.sendChunks.length === 0) return;

    this.isTransmitting = true;
    const total = this.sendChunks.length;

    const renderNextFrame = () => {
      if (!this.isTransmitting) return;

      const packet = this.sendChunks[this.sendIndex];
      containerEl.innerHTML = '';

      if (typeof QRCode !== 'undefined') {
        new QRCode(containerEl, {
          text: packet,
          width: 300,
          height: 300,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.L // 最大セルサイズ
        });
      }

      if (onProgress) {
        onProgress({
          current: this.sendIndex + 1,
          total: total,
          percent: Math.round(((this.sendIndex + 1) / total) * 100)
        });
      }

      this.sendIndex = (this.sendIndex + 1) % total;
      const intervalMs = Math.round(1000 / this.fps);
      this.animationTimer = setTimeout(renderNextFrame, intervalMs);
    };

    renderNextFrame();
  }

  stopTransmission() {
    this.isTransmitting = false;
    if (this.animationTimer) {
      clearTimeout(this.animationTimer);
      this.animationTimer = null;
    }
  }

  /**
   * カメラを起動して動的QRコードの連続スキャンを開始（低画質カメラ用コントラスト補正付き）
   */
  async startReceiving(videoEl, onProgress, onComplete, onError) {
    this.stopReceiving();
    this.isReceiving = true;
    this.receiveSession = null;

    try {
      this.scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: 'environment',
          width: { ideal: 1280, min: 640 },
          height: { ideal: 720, min: 480 }
        }
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
            // 通常スキャン
            let code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'attemptBoth'
            });

            // 低画質・ボケカメラ用：コントラスト強化フォールバック
            if (!code) {
              const d = imageData.data;
              for (let i = 0; i < d.length; i += 4) {
                // グレースケール＆コントラスト増幅
                const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
                const thresh = v > 128 ? 255 : 0;
                d[i] = thresh;
                d[i + 1] = thresh;
                d[i + 2] = thresh;
              }
              code = jsQR(d, imageData.width, imageData.height, {
                inversionAttempts: 'attemptBoth'
              });
            }

            if (code && code.data && (code.data.startsWith('G|') || code.data.startsWith('GOV|'))) {
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
      if (onError) onError(new Error('カメラの起動に失敗しました（権限またはデバイス接続を確認してください）'));
      this.stopReceiving();
    }
  }

  /**
   * 受信パケット処理
   */
  async handleReceivedPacket(packetStr, onProgress, onComplete, onError) {
    try {
      const parts = packetStr.split('|');
      if (parts.length < 7) return;

      let sessionId, totalStr, indexStr, shaPrefix, encodedFileName, chunkData;
      if (parts[0] === 'G') {
        [, sessionId, totalStr, indexStr, shaPrefix, encodedFileName, chunkData] = parts;
      } else {
        [, sessionId, totalStr, indexStr, , shaPrefix, encodedFileName, chunkData] = parts;
      }

      const total = parseInt(totalStr, 10);
      const index = parseInt(indexStr, 10);
      const fileName = decodeURIComponent(encodedFileName);

      // 新規セッション開始
      if (!this.receiveSession || this.receiveSession.sessionId !== sessionId) {
        this.receiveSession = {
          sessionId,
          total,
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
            fileName: fileName
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
          let fullHash = '';
          let hashMatch = false;
          try {
            fullHash = await TransferCrypto.calculateSHA256(fileBlob);
            hashMatch = fullHash.startsWith(this.receiveSession.shaPrefix);
          } catch (e) {}

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

  stopReceiving() {
    this.isReceiving = false;
    if (this.scannerStream) {
      this.scannerStream.getTracks().forEach(track => track.stop());
      this.scannerStream = null;
    }
  }
}

window.DynamicQRTransfer = DynamicQRTransfer;
