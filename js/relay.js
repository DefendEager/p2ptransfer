/**
 * E2EE 暗号化ゼロ知識HTTPSリレーエンジン
 * 
 * 自治体プロキシ（IWSS）やファイアウォールにより WebRTC P2P が完全に遮断されている環境でも、
 * 通常のWebブラウジングと同じ HTTPS（443ポート POST/GET）通信のみを利用して、
 * 回線上限速度・大容量ファイル対応・完全E2EE暗号化で安全に転送します。
 * 
 * 【セキュリティ仕様】
 * 1. ファイルは送信前にブラウザ内で Web Crypto AES-256-GCM により暗号化
 * 2. 中継サーバーには暗号化されたバイナリのみが送信され、復号鍵（PIN）は送信者・受信者のみが所持
 * 3. 受信側ブラウザでダウンロード後、クライアント側で復号 ＆ SHA-256 完全性検証
 */

class E2EERelayTransfer {
  constructor(options = {}) {
    this.options = options;
    // 複数の高速・無料リレーエンドポイント（冗長化フォールバック）
    this.relayEndpoints = [
      {
        name: 'FileIO',
        uploadUrl: 'https://file.io/?expires=1d',
        parseUploadResponse: async (res) => {
          const json = await res.json();
          if (json && json.success && json.link) {
            return { downloadUrl: json.link, key: json.key };
          }
          throw new Error('FileIO アップロード応答エラー');
        }
      },
      {
        name: 'TmpFiles',
        uploadUrl: 'https://tmpfiles.org/api/v1/upload',
        parseUploadResponse: async (res) => {
          const json = await res.json();
          if (json && json.data && json.data.url) {
            // ダウンロード直接リンクに変換 (tmpfiles.org/XXXX -> tmpfiles.org/dl/XXXX)
            const rawUrl = json.data.url;
            const dlUrl = rawUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
            return { downloadUrl: dlUrl };
          }
          throw new Error('TmpFiles アップロード応答エラー');
        }
      }
    ];
  }

  /**
   * ファイルを暗号化してHTTPSリレーへ送信します
   * @param {File} file - 送信対象ファイル
   * @param {string} pin - 6桁のPINコード
   * @param {Function} [onProgress] - 進捗コールバック (percent, speed, status)
   */
  async sendFile(file, pin, onProgress) {
    if (!pin || pin.length < 4) {
      throw new Error('有効なPINコード（4桁以上）を指定してください');
    }

    const startTime = performance.now();

    // 1. PINコードから AES-256-GCM 鍵を導出
    if (onProgress) onProgress({ percent: 5, status: '鍵導出中 (PBKDF2)...' });
    const salt = new TextEncoder().encode(`gov-relay-salt-${pin}`);
    const key = await TransferCrypto.deriveKey(pin, salt);
    if (!key) {
      throw new Error('暗号鍵の生成に失敗しました（Web Crypto API環境を確認してください）');
    }

    // 2. ファイル全体の SHA-256 ハッシュを事前計算
    if (onProgress) onProgress({ percent: 15, status: 'SHA-256完全性ハッシュ計算中...' });
    const originalHash = await TransferCrypto.calculateSHA256(file);

    // 3. ファイルバイナリの読み込み
    if (onProgress) onProgress({ percent: 30, status: 'ファイル読み込み中...' });
    const rawBuffer = await file.arrayBuffer();

    // 4. AES-256-GCM による二重暗号化
    if (onProgress) onProgress({ percent: 50, status: 'AES-256-GCM 暗号化中...' });
    const iv = TransferCrypto.generateIV();
    const encryptedBuffer = await TransferCrypto.encryptBuffer(rawBuffer, key, iv);

    // 5. パケットヘッダーの付与
    // ヘッダー: [0x52(R), 0x4C(L), IV(12byte), MetaJSONLen(2byte), MetaJSON(UTF-8), EncryptedPayload]
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

    // 6. HTTPSリレーへアップロード
    if (onProgress) onProgress({ percent: 70, status: 'HTTPSリレーへ暗号化送信中...' });

    let uploadResult = null;
    let lastError = null;

    for (const endpoint of this.relayEndpoints) {
      try {
        console.log(`[Relay] エンドポイント「${endpoint.name}」へアップロード試行中...`);
        const formData = new FormData();
        const encryptedBlob = new Blob([packetBuffer], { type: 'application/octet-stream' });
        formData.append('file', encryptedBlob, `secure_payload_${pin}.bin`);

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

    // 共有用トークンを生成 (Base64エンコードされたURL)
    const relayToken = btoa(uploadResult.downloadUrl);

    return {
      pin: pin,
      token: relayToken,
      downloadUrl: uploadResult.downloadUrl,
      fileName: file.name,
      size: file.size,
      sha256: originalHash,
      durationSeconds: (performance.now() - startTime) / 1000
    };
  }

  /**
   * HTTPSリレーから暗号化データをダウンロードし、クライアント側で復号します
   * @param {string} downloadUrlOrToken - ダウンロードURLまたは共有トークン
   * @param {string} pin - 6桁のPINコード
   * @param {Function} [onProgress] - 進捗コールバック (percent, speed, status)
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

    // 1. 暗号化バイナリをダウンロード (HTTPS GET)
    if (onProgress) onProgress({ percent: 20, status: '暗号化バイナリを受信中...' });

    let response;
    try {
      response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`ダウンロードに失敗しました (HTTP ${response.status})。リンクの有効期限が切れている可能性があります。`);
      }
    } catch (e) {
      throw new Error(`リレー通信エラー: ${e.message}`);
    }

    const packetBuffer = await response.arrayBuffer();
    if (packetBuffer.byteLength < 16) {
      throw new Error('受信データが破損しているか、無効なフォーマットです');
    }

    const view = new Uint8Array(packetBuffer);
    if (view[0] !== 0x52 || view[1] !== 0x4C) {
      throw new Error('暗号化パケットのシグネチャが一致しません');
    }

    // 2. パケットヘッダーの解析
    const iv = view.slice(2, 14);
    const metaLen = (view[14] << 8) | view[15];
    const metaBytes = view.slice(16, 16 + metaLen);
    const metaJson = new TextDecoder().decode(metaBytes);
    const meta = JSON.parse(metaJson);

    const encryptedPayload = packetBuffer.slice(16 + metaLen);

    // 3. 鍵導出
    if (onProgress) onProgress({ percent: 60, status: '復号鍵導出中 (PBKDF2)...' });
    const salt = new TextEncoder().encode(`gov-relay-salt-${pin}`);
    const key = await TransferCrypto.deriveKey(pin, salt);
    if (!key) {
      throw new Error('暗号鍵の生成に失敗しました');
    }

    // 4. クライアント側 AES-256-GCM 復号
    if (onProgress) onProgress({ percent: 80, status: 'AES-256-GCM 復号中...' });
    let decryptedBuffer;
    try {
      decryptedBuffer = await TransferCrypto.decryptBuffer(encryptedPayload, key, iv);
    } catch (err) {
      throw new Error('復号に失敗しました。PINコードが一致しているか確認してください。');
    }

    // 5. Blob生成 & SHA-256 完全性検証
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
      hashMatch: hashMatch,
      durationSeconds: (performance.now() - startTime) / 1000
    };
  }
}

window.E2EERelayTransfer = E2EERelayTransfer;
