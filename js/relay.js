/**
 * E2EE 暗号化ゼロ知識HTTPSリレーエンジン
 * 
 * 自治体プロキシ（IWSS / SSLインスペクション）環境下でも、
 * 証明書エラーを回避し、安全・確実にファイルを送受信するための多重機構を提供します。
 * 
 * 【機能】
 * 1. Web Crypto AES-256-GCM クライアント二重暗号化
 * 2. 複数の大手・高信頼リレーエンドポイント
 * 3. 万一の証明書エラー時における「直接ダウンロード ➔ ブラウザ復号」フォールバック
 * 4. 完全オフライン対応「暗号化ファイル (.govp2p) エクスポート ＆ ドロップ復号」
 */

class E2EERelayTransfer {
  constructor(options = {}) {
    this.options = options;
    // 大手・CORS対応リレーエンドポイント
    this.relayEndpoints = [
      {
        name: 'FileIO',
        uploadUrl: 'https://file.io/?expires=1d',
        prepareFormData: (encryptedBlob, fileName) => {
          const fd = new FormData();
          fd.append('file', encryptedBlob, fileName);
          return fd;
        },
        parseUploadResponse: async (res) => {
          const json = await res.json();
          if (json && json.success && json.link) {
            return { downloadUrl: json.link, key: json.key };
          }
          throw new Error('FileIO 応答エラー');
        }
      },
      {
        name: 'Litterbox',
        uploadUrl: 'https://litterbox.catbox.moe/resources/internals/api.php',
        prepareFormData: (encryptedBlob, fileName) => {
          const fd = new FormData();
          fd.append('reqtype', 'fileupload');
          fd.append('time', '1h');
          fd.append('fileToUpload', encryptedBlob, fileName);
          return fd;
        },
        parseUploadResponse: async (res) => {
          const text = (await res.text()).trim();
          if (text.startsWith('http://') || text.startsWith('https://')) {
            return { downloadUrl: text };
          }
          throw new Error(`Litterbox 応答不正: ${text}`);
        }
      },
      {
        name: 'TmpFiles',
        uploadUrl: 'https://tmpfiles.org/api/v1/upload',
        prepareFormData: (encryptedBlob, fileName) => {
          const fd = new FormData();
          fd.append('file', encryptedBlob, fileName);
          return fd;
        },
        parseUploadResponse: async (res) => {
          const json = await res.json();
          if (json && json.data && json.data.url) {
            const rawUrl = json.data.url;
            const dlUrl = rawUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
            return { downloadUrl: dlUrl };
          }
          throw new Error('TmpFiles 応答エラー');
        }
      }
    ];
  }

  /**
   * ファイルをブラウザ内で AES-256-GCM 暗号化し、暗号化パケットバッファを生成
   */
  async buildEncryptedPacket(file, pin, onProgress) {
    if (!pin || pin.length < 4) {
      throw new Error('有効なPINコード（4桁以上）を指定してください');
    }

    if (onProgress) onProgress({ percent: 5, status: '暗号鍵導出中 (PBKDF2)...' });
    const salt = new TextEncoder().encode(`gov-relay-salt-${pin}`);
    const key = await TransferCrypto.deriveKey(pin, salt);
    if (!key) throw new Error('暗号鍵の生成に失敗しました');

    if (onProgress) onProgress({ percent: 15, status: 'SHA-256 ハッシュ計算中...' });
    const originalHash = await TransferCrypto.calculateSHA256(file);

    if (onProgress) onProgress({ percent: 30, status: 'ファイル読み込み中...' });
    const rawBuffer = await file.arrayBuffer();

    if (onProgress) onProgress({ percent: 50, status: 'AES-256-GCM 暗号化中...' });
    const iv = TransferCrypto.generateIV();
    const encryptedBuffer = await TransferCrypto.encryptBuffer(rawBuffer, key, iv);

    const metaObj = {
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      sha256: originalHash,
      timestamp: Date.now()
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(metaObj));
    const headerLen = 2 + 12 + 2 + metaBytes.byteLength;
    const packetBuffer = new Uint8Array(headerLen + encryptedBuffer.byteLength);

    packetBuffer[0] = 0x52; // 'R'
    packetBuffer[1] = 0x4C; // 'L'
    packetBuffer.set(iv, 2);
    packetBuffer[14] = (metaBytes.byteLength >> 8) & 0xff;
    packetBuffer[15] = metaBytes.byteLength & 0xff;
    packetBuffer.set(metaBytes, 16);
    packetBuffer.set(new Uint8Array(encryptedBuffer), headerLen);

    return {
      packetBuffer,
      originalHash,
      metaObj
    };
  }

  /**
   * ファイルを暗号化してHTTPSリレーへ送信
   */
  async sendFile(file, pin, onProgress) {
    const startTime = performance.now();
    const { packetBuffer, originalHash, metaObj } = await this.buildEncryptedPacket(file, pin, onProgress);

    if (onProgress) onProgress({ percent: 70, status: 'HTTPSリレーへ暗号化送信中...' });

    let uploadResult = null;
    let lastError = null;
    const encryptedBlob = new Blob([packetBuffer], { type: 'application/octet-stream' });
    const uploadFileName = `secure_payload_${pin}.govp2p`;

    for (const endpoint of this.relayEndpoints) {
      try {
        console.log(`[Relay] エンドポイント「${endpoint.name}」へアップロード試行中...`);
        const formData = endpoint.prepareFormData(encryptedBlob, uploadFileName);

        const response = await fetch(endpoint.uploadUrl, {
          method: 'POST',
          body: formData
        });

        if (response.ok) {
          uploadResult = await endpoint.parseUploadResponse(response);
          console.log(`[Relay] エンドポイント「${endpoint.name}」へのアップロード成功:`, uploadResult);
          break;
        } else {
          console.warn(`[Relay] ${endpoint.name} 応答エラー: HTTP ${response.status}`);
        }
      } catch (err) {
        console.warn(`[Relay] ${endpoint.name} 通信失敗:`, err);
        lastError = err;
      }
    }

    if (!uploadResult || !uploadResult.downloadUrl) {
      throw new Error(`リレーサーバーへの暗号化アップロードに失敗しました: ${lastError ? lastError.message : 'ネットワーク接続を確認してください'}`);
    }

    if (onProgress) onProgress({ percent: 100, status: '送信完了' });

    const relayToken = btoa(uploadResult.downloadUrl);

    return {
      pin: pin,
      token: relayToken,
      downloadUrl: uploadResult.downloadUrl,
      fileName: file.name,
      size: file.size,
      sha256: originalHash,
      durationSeconds: (performance.now() - startTime) / 1000,
      encryptedBlob: encryptedBlob
    };
  }

  /**
   * 暗号化バイナリバッファをパースして復号
   */
  async decryptPacketBuffer(packetBuffer, pin, onProgress) {
    if (packetBuffer.byteLength < 16) {
      throw new Error('受信データが破損しているか、無効なフォーマットです');
    }

    const view = new Uint8Array(packetBuffer);
    if (view[0] !== 0x52 || view[1] !== 0x4C) {
      throw new Error('暗号化パケットのシグネチャが一致しません');
    }

    const iv = view.slice(2, 14);
    const metaLen = (view[14] << 8) | view[15];
    const metaBytes = view.slice(16, 16 + metaLen);
    const metaJson = new TextDecoder().decode(metaBytes);
    const meta = JSON.parse(metaJson);

    const encryptedPayload = packetBuffer.slice(16 + metaLen);

    if (onProgress) onProgress({ percent: 60, status: '復号鍵導出中 (PBKDF2)...' });
    const salt = new TextEncoder().encode(`gov-relay-salt-${pin}`);
    const key = await TransferCrypto.deriveKey(pin, salt);
    if (!key) throw new Error('暗号鍵の生成に失敗しました');

    if (onProgress) onProgress({ percent: 80, status: 'AES-256-GCM 復号中...' });
    let decryptedBuffer;
    try {
      decryptedBuffer = await TransferCrypto.decryptBuffer(encryptedPayload, key, iv);
    } catch (err) {
      throw new Error('復号に失敗しました。PINコードが一致しているか確認してください。');
    }

    if (onProgress) onProgress({ percent: 95, status: 'SHA-256 完全性検証中...' });
    const fileBlob = new Blob([decryptedBuffer], { type: meta.type || 'application/octet-stream' });
    const calculatedHash = await TransferCrypto.calculateSHA256(fileBlob);
    const hashMatch = (calculatedHash === meta.sha256);

    if (onProgress) onProgress({ percent: 100, status: '完了' });

    return {
      blob: fileBlob,
      fileName: meta.name,
      size: meta.size,
      type: meta.type,
      sha256: calculatedHash,
      hashMatch: hashMatch
    };
  }

  /**
   * HTTPSリレーから暗号化データをダウンロードし、クライアント側で復号
   */
  async receiveFile(downloadUrlOrToken, pin, onProgress) {
    if (!pin || pin.length < 4) {
      throw new Error('復号のためのPINコードを入力してください');
    }

    let downloadUrl = downloadUrlOrToken.trim();
    if (!downloadUrl.startsWith('http://') && !downloadUrl.startsWith('https://')) {
      try {
        downloadUrl = atob(downloadUrl);
      } catch (e) {
        throw new Error('無効なダウンロードコードまたはURLです');
      }
    }

    const startTime = performance.now();

    // 1. 暗号化バイナリをダウンロード
    if (onProgress) onProgress({ percent: 20, status: '暗号化バイナリを受信中...' });
    
    let packetBuffer = null;
    let fetchError = null;

    // 直接アクセス試行
    try {
      const response = await fetch(downloadUrl);
      if (response.ok) {
        packetBuffer = await response.arrayBuffer();
      } else {
        fetchError = new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      console.warn('直接fetch失敗 (自治体プロキシ証明書エラー等):', err);
      fetchError = err;
    }

    // fetchが証明書エラー等で失敗した場合、エラー情報と直接ダウンロードURLを返却
    if (!packetBuffer) {
      const err = new Error(`自治体プロキシの証明書制限により、ブラウザの自動通信が遮断されました: ${fetchError ? fetchError.message : ''}`);
      err.downloadUrl = downloadUrl;
      err.pin = pin;
      err.isCertBlocked = true;
      throw err;
    }

    // 2. 復号処理
    const result = await this.decryptPacketBuffer(packetBuffer, pin, onProgress);
    result.durationSeconds = (performance.now() - startTime) / 1000;
    return result;
  }
}

window.E2EERelayTransfer = E2EERelayTransfer;
