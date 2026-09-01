/**
 * ハイブリッド・シグナリングマネージャー
 * 
 * 1. オンラインモード: 6桁PIN / QRコード自動接続（PeerJS公開サーバー使用）
 * 2. 完全オフライン/閉域網モード: インターネット不要の手動SDP/QRコード交換接続
 */

class SignalingManager {
  constructor(options = {}) {
    this.options = options;
    this.peer = null;
    this.peerConnection = null;
    this.currentPin = null;
    this.engine = options.engine;
    this.isHost = false;

    // 自治体向けデフォルトプレフィックス（ルーム衝突回避）
    this.PIN_PREFIX = 'gov-p2p-';
  }

  /**
   * 6桁のランダムな数字PINコードを生成します。
   * @returns {string} 6桁のPIN（例: "582914"）
   */
  static generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * オンラインモード：ホストとして待機（PINコードを発行）
   * @param {string} [customPin] - 指定のPIN（省略時は自動生成）
   */
  async hostSession(customPin = null) {
    const pin = customPin || SignalingManager.generatePin();
    this.currentPin = pin;
    this.isHost = true;

    // 暗号鍵の生成（PINコードからPBKDF2で導出）
    const salt = new TextEncoder().encode(`gov-salt-${pin}`);
    const key = await TransferCrypto.deriveKey(pin, salt);
    this.engine.setCryptoKey(key);

    return new Promise((resolve, reject) => {
      const peerId = `${this.PIN_PREFIX}${pin}`;
      
      // 既存のPeerを破棄
      if (this.peer) {
        this.peer.destroy();
      }

      // PeerJS インスタンス生成（WebRTCシグナリング用）
      this.peer = new Peer(peerId, {
        debug: 1,
        config: this.engine.defaultRtcConfig
      });

      this.peer.on('open', (id) => {
        console.log(`[Signaling] ホストとして接続待機中: PIN=${pin} (PeerId=${id})`);
        resolve({ pin, peerId: id });
      });

      this.peer.on('connection', (conn) => {
        console.log(`[Signaling] クライアントからの接続要求を受信: ${conn.peer}`);
        this.handlePeerConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.error('[Signaling] Peerエラー:', err);
        if (err.type === 'unavailable-id') {
          // ID衝突時は別のPINで再試行
          console.warn('PIN衝突のため再生成します...');
          this.hostSession().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * オンラインモード：クライアントとしてPINコードに接続
   * @param {string} pin - 相手の6桁PINコード
   */
  async joinSession(pin) {
    if (!pin || pin.length < 4) {
      throw new Error('有効なPINコードを入力してください');
    }
    this.currentPin = pin;
    this.isHost = false;

    // 暗号鍵の導出（相手と同一のPINから同一の鍵を生成）
    const salt = new TextEncoder().encode(`gov-salt-${pin}`);
    const key = await TransferCrypto.deriveKey(pin, salt);
    this.engine.setCryptoKey(key);

    return new Promise((resolve, reject) => {
      const randomClientId = `${this.PIN_PREFIX}client-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      const targetPeerId = `${this.PIN_PREFIX}${pin}`;

      // 15秒の接続タイムアウト
      let isSettled = false;
      const timeoutId = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          this.destroy();
          reject(new Error('接続タイムアウト: 相手端末が見つからないか、ネットワーク制限により接続できませんでした'));
        }
      }, 15000);

      this.currentReject = (reason) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutId);
          this.destroy();
          reject(new Error(reason || '接続がキャンセルされました'));
        }
      };

      if (this.peer) {
        this.peer.destroy();
      }

      this.peer = new Peer(randomClientId, {
        debug: 1,
        config: this.engine.defaultRtcConfig
      });

      this.peer.on('open', () => {
        console.log(`[Signaling] ターゲット (${targetPeerId}) に接続試行中...`);
        const conn = this.peer.connect(targetPeerId, {
          reliable: true
        });

        conn.on('open', () => {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timeoutId);
            console.log('[Signaling] ホストとの接続が確立しました！');
            this.handlePeerConnection(conn);
            resolve({ pin, connected: true });
          }
        });

        conn.on('error', (err) => {
          if (!isSettled) {
            isSettled = true;
            clearTimeout(timeoutId);
            console.error('[Signaling] 接続エラー:', err);
            reject(new Error('相手端末が見つかりません。PINコードを確認してください。'));
          }
        });
      });

      this.peer.on('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutId);
          console.error('[Signaling] Peerエラー:', err);
          reject(err);
        }
      });
    });
  }

  /**
   * 接続試行を手動でキャンセルします
   */
  cancelSession() {
    if (this.currentReject) {
      this.currentReject('接続をキャンセルしました');
      this.currentReject = null;
    } else {
      this.destroy();
    }
  }

  /**
   * PeerJS の DataConnection をエンジンの DataChannel として結合
   * @param {DataConnection} conn
   */
  handlePeerConnection(conn) {
    if (!conn) return;

    const bindEngine = () => {
      // PeerConnectionをエンジンに共有
      if (conn.peerConnection) {
        this.engine.peerConnection = conn.peerConnection;
      }

      // RTCDataChannel を取得してエンジンに結合
      const rawDc = conn.dataChannel || conn._dc;
      if (rawDc) {
        this.engine.setupDataChannel(rawDc);
      }

      if (this.options.onConnected) {
        this.options.onConnected({
          pin: this.currentPin,
          peerId: conn.peer,
          isHost: this.isHost,
          connectionType: 'P2P Direct'
        });
      }
    };

    if (conn.open) {
      bindEngine();
    } else {
      conn.on('open', () => {
        console.log('[Signaling] PeerJS DataConnection オープン');
        bindEngine();
      });
    }

    conn.on('close', () => {
      console.log('[Signaling] ピア接続が切断されました');
      if (this.options.onDisconnected) {
        this.options.onDisconnected();
      }
    });

    conn.on('error', (err) => {
      console.error('[Signaling] コネクションエラー:', err);
      if (this.options.onError) {
        this.options.onError(err);
      }
    });
  }

  /* ==========================================================
   * 完全オフライン/閉域網モード（手動SDP / QRコード交換）
   * インターネット接続が完全禁止された自治体PC等で使用します。
   * ========================================================== */

  /**
   * オフライン：オファー（SDP）を生成します。
   * @param {string} [passphrase] - オフライン用共通暗号パスフレーズ
   * @returns {Promise<string>} 圧縮されたBase64 SDP文字列
   */
  async createOfflineOffer(passphrase = 'gov-offline-secure') {
    this.engine.initializePeerConnection(true);

    if (passphrase) {
      const salt = new TextEncoder().encode(`gov-offline-salt-${passphrase}`);
      const key = await TransferCrypto.deriveKey(passphrase, salt);
      this.engine.setCryptoKey(key);
    }

    const pc = this.engine.peerConnection;

    return new Promise((resolve, reject) => {
      const candidates = [];

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          candidates.push(e.candidate);
        } else {
          // ICE収集完了時、オファーSDPと候補をパックして返す
          const offerPayload = {
            sdp: pc.localDescription,
            candidates: candidates
          };
          const jsonString = JSON.stringify(offerPayload);
          const encoded = btoa(unescape(encodeURIComponent(jsonString)));
          resolve(encoded);
        }
      };

      pc.createOffer().then((offer) => {
        return pc.setLocalDescription(offer);
      }).catch(reject);
    });
  }

  /**
   * オフライン：オファーSDPを読み込んでアンサー（SDP）を生成します。
   * @param {string} offerBase64 - 相手のオファー文字列
   * @param {string} [passphrase] - オフライン用共通暗号パスフレーズ
   * @returns {Promise<string>} 圧縮されたBase64 アンサーSDP文字列
   */
  async createOfflineAnswer(offerBase64, passphrase = 'gov-offline-secure') {
    this.engine.initializePeerConnection(false);

    if (passphrase) {
      const salt = new TextEncoder().encode(`gov-offline-salt-${passphrase}`);
      const key = await TransferCrypto.deriveKey(passphrase, salt);
      this.engine.setCryptoKey(key);
    }

    const pc = this.engine.peerConnection;
    const jsonString = decodeURIComponent(escape(atob(offerBase64)));
    const offerPayload = JSON.parse(jsonString);

    await pc.setRemoteDescription(new RTCSessionDescription(offerPayload.sdp));

    // ICE Candidateを追加
    if (offerPayload.candidates && Array.isArray(offerPayload.candidates)) {
      for (const cand of offerPayload.candidates) {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      }
    }

    return new Promise((resolve, reject) => {
      const candidates = [];

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          candidates.push(e.candidate);
        } else {
          const answerPayload = {
            sdp: pc.localDescription,
            candidates: candidates
          };
          const answerJson = JSON.stringify(answerPayload);
          const encoded = btoa(unescape(encodeURIComponent(answerJson)));
          resolve(encoded);
        }
      };

      pc.createAnswer().then((answer) => {
        return pc.setLocalDescription(answer);
      }).catch(reject);
    });
  }

  /**
   * オフライン：オファー生成側が相手のアンサーSDPを適用して接続を完了します。
   * @param {string} answerBase64 - 相手のアンサー文字列
   */
  async applyOfflineAnswer(answerBase64) {
    const pc = this.engine.peerConnection;
    if (!pc) {
      throw new Error('PeerConnection が初期化されていません');
    }

    const jsonString = decodeURIComponent(escape(atob(answerBase64)));
    const answerPayload = JSON.parse(jsonString);

    await pc.setRemoteDescription(new RTCSessionDescription(answerPayload.sdp));

    if (answerPayload.candidates && Array.isArray(answerPayload.candidates)) {
      for (const cand of answerPayload.candidates) {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      }
    }

    console.log('[Signaling] オフライン接続のネゴシエーションが完了しました');
  }

  /**
   * 接続をクリーンアップ
   */
  destroy() {
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }
  }
}

window.SignalingManager = SignalingManager;
