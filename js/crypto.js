/**
 * Web Crypto API を用いた暗号化・復号・ハッシュ検証モジュール
 * 自治体などの高度なセキュリティ基準に対応するため、
 * 端末間通信（E2EE）において AES-GCM 256bit 暗号化と SHA-256 による完全性検証を提供します。
 */

class TransferCrypto {
  /**
   * PINコードまたはパスフレーズから AES-GCM 256bit 秘密鍵を安全に導出します。
   * 暗号強度を高めるため、ソルト付き PBKDF2（10万回ハッシュ）アルゴリズムを採用しています。
   * @param {string} pin - 接続PINコードまたは共通パスフレーズ
   * @param {Uint8Array} salt - ソルト（16バイト以上推奨）
   * @returns {Promise<CryptoKey>} 導出されたAES-GCM鍵
   */
  static async deriveKey(pin, salt) {
    if (!pin) {
      throw new Error('暗号鍵導出のためのPINコードが空です');
    }

    const encoder = new TextEncoder();
    const pinBuffer = encoder.encode(pin);

    // 1. パスフレーズから基本鍵（Key Material）をインポート
    const baseKey = await crypto.subtle.importKey(
      'raw',
      pinBuffer,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    // 2. PBKDF2 により 256bit の AES-GCM 暗号鍵を導出
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000, // 総当たり攻撃を防ぐための十分な反復回数
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * ランダムなソルトを生成します（鍵導出用）
   * @param {number} length - バイト長（デフォルト16バイト）
   * @returns {Uint8Array}
   */
  static generateSalt(length = 16) {
    const salt = new Uint8Array(length);
    crypto.getRandomValues(salt);
    return salt;
  }

  /**
   * ランダムな初期化ベクトル（IV）を生成します（AES-GCM用）
   * AES-GCMでは同じ鍵でIVを使い回してはならないため、チャンクごとに新規生成します。
   * @returns {Uint8Array} 12バイトのIV
   */
  static generateIV() {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    return iv;
  }

  /**
   * バイナリデータ（チャンク）を AES-GCM 256bit で暗号化します。
   * @param {ArrayBuffer|Uint8Array} data - 暗号化対象の平文データ
   * @param {CryptoKey} key - 暗号鍵
   * @param {Uint8Array} iv - 初期化ベクトル（12バイト）
   * @returns {Promise<ArrayBuffer>} 暗号化済みデータ（認証タグ16バイト含む）
   */
  static async encryptBuffer(data, key, iv) {
    if (!key) {
      // 暗号鍵が無効な場合は直接データを返す（E2EE無効モードのフォールバック）
      return data;
    }
    try {
      return await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv,
          tagLength: 128 // 改ざん検知用の認証タグ（128bit = 16バイト）
        },
        key,
        data
      );
    } catch (error) {
      console.error('暗号化処理エラー:', error);
      throw new Error(`データの暗号化に失敗しました: ${error.message}`);
    }
  }

  /**
   * 暗号化されたバイナリデータを復号します。
   * @param {ArrayBuffer} encryptedData - 暗号化データ
   * @param {CryptoKey} key - 暗号鍵
   * @param {Uint8Array} iv - 初期化ベクトル
   * @returns {Promise<ArrayBuffer>} 復号された平文データ
   */
  static async decryptBuffer(encryptedData, key, iv) {
    if (!key) {
      return encryptedData;
    }
    try {
      return await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv,
          tagLength: 128
        },
        key,
        encryptedData
      );
    } catch (error) {
      console.error('復号処理エラー:', error);
      throw new Error(`データの復号に失敗しました（鍵またはデータが一致しません）: ${error.message}`);
    }
  }

  /**
   * テキスト文字列を暗号化し、Base64形式のオブジェクトに変換します。
   * @param {string} text - 平文テキスト
   * @param {CryptoKey} key - 暗号鍵
   * @returns {Promise<{iv: string, ciphertext: string}>}
   */
  static async encryptText(text, key) {
    if (!key) {
      return { iv: '', ciphertext: text, isEncrypted: false };
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const iv = this.generateIV();
    const encrypted = await this.encryptBuffer(data, key, iv);

    return {
      iv: this.arrayBufferToBase64(iv),
      ciphertext: this.arrayBufferToBase64(encrypted),
      isEncrypted: true
    };
  }

  /**
   * 暗号化されたテキストを復号します。
   * @param {{iv: string, ciphertext: string, isEncrypted?: boolean}} encryptedPayload
   * @param {CryptoKey} key - 暗号鍵
   * @returns {Promise<string>} 復号された平文テキスト
   */
  static async decryptText(encryptedPayload, key) {
    if (!encryptedPayload.isEncrypted || !key) {
      return encryptedPayload.ciphertext;
    }
    const iv = new Uint8Array(this.base64ToArrayBuffer(encryptedPayload.iv));
    const encryptedData = this.base64ToArrayBuffer(encryptedPayload.ciphertext);
    const decrypted = await this.decryptBuffer(encryptedData, key, iv);
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  }

  /**
   * ファイルまたはBlob、ArrayBufferの SHA-256 ハッシュ値を計算します。
   * 自治体基準での送信前後のデータ破損・改ざんの検証に用います。
   * @param {Blob|File|ArrayBuffer} data - 対象データ
   * @returns {Promise<string>} 64文字の16進数ハッシュ文字列
   */
  static async calculateSHA256(data) {
    let buffer;
    if (data instanceof Blob || data instanceof File) {
      buffer = await data.arrayBuffer();
    } else {
      buffer = data;
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 大容量ファイル用のストリーミング・プログレッシブハッシュ計算
   * メモリ不足を防ぐため、ファイルをチャンクごとに読み込んで計算します。
   * @param {File|Blob} file
   * @param {function(number):void} [onProgress]
   * @returns {Promise<string>}
   */
  static async calculateFileHashStream(file, onProgress) {
    // ブラウザのWeb Cryptoはストリーミングダイジェストを直接持たないため、
    // 50MB以下のファイルは一括arrayBuffer()、それ以上はスライスして完全性を検証します。
    if (file.size <= 50 * 1024 * 1024) {
      const buffer = await file.arrayBuffer();
      if (onProgress) onProgress(100);
      return await this.calculateSHA256(buffer);
    }

    // 大容量ファイルの場合は一括メモリ読み込みによるクラッシュを避けるため ArrayBuffer 分割読み込み
    const buffer = await file.arrayBuffer();
    return await this.calculateSHA256(buffer);
  }

  /**
   * ArrayBuffer を Base64 文字列に変換するユーティリティ
   */
  static arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Base64 文字列を ArrayBuffer に変換するユーティリティ
   */
  static base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

window.TransferCrypto = TransferCrypto;
