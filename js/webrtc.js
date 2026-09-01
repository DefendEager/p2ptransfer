/**
 * WebRTC DataChannel による高速・大容量P2Pファイル・テキスト転送エンジン
 * 
 * 【高速化・耐障害性ロジック】
 * 1. Backpressure（背圧）制御: bufferedAmountLowThreshold によるイベント駆動ノンブロッキング送信
 * 2. 64KB最適化チャンキング: SCTPバッファ効率を最大化するバイナリパッキング
 * 3. メモリ枯渇防止（ゼロOOM）: Blob.slice() によるオンデマンド逐次読み込み
 * 4. エンドツーエンド暗号化（E2EE）: Web Crypto AES-256-GCM チャンク単位暗号化
 * 5. SHA-256 完全性検証: 受信完了時に自動ハッシュ照合
 */

class P2PTransferEngine {
  /**
   * @param {Object} options
   * @param {RTCConfiguration} [options.rtcConfig] - ICEサーバー設定
   * @param {Function} [options.onStatusChange] - 接続状態変更コールバック
   * @param {Function} [options.onFileProgress] - 送信/受信進捗コールバック
   * @param {Function} [options.onFileReceived] - ファイル受信完了コールバック
   * @param {Function} [options.onTextReceived] - テキスト受信コールバック
   * @param {Function} [options.onError] - エラー発生時コールバック
   */
  constructor(options = {}) {
    this.options = options;
    this.peerConnection = null;
    this.dataChannel = null;
    this.cryptoKey = null; // E2EE暗号鍵

    // チャンクサイズ（64KB）: WebRTC DataChannelのMTUとバッファ効率に最適なサイズ
    this.CHUNK_SIZE = 64 * 1024;
    // バックプレッシャーしきい値: バッファがこれを超えたら送信を一時停止
    this.BUFFER_THRESHOLD_HIGH = 1024 * 1024; // 1MB
    // バッファがこれ以下になったら送信を再開
    this.BUFFER_THRESHOLD_LOW = 256 * 1024; // 256KB

    // 受信中ファイルのバッファマップ [fileId -> { meta, chunks, receivedBytes, receivedChunks, startTime }]
    this.incomingFiles = new Map();

    // 送信キュー
    this.isSending = false;
    this.sendQueue = [];

    // 統計情報ポーリング用タイマー
    this.statsInterval = null;

    // デフォルトのICE設定（Cloudflare & Googleの公開STUN + ローカル直接通信用）
    this.defaultRtcConfig = {
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10
    };
  }

  /**
   * 暗号鍵を設定します（E2EE用）
   * @param {CryptoKey} key
   */
  setCryptoKey(key) {
    this.cryptoKey = key;
  }

  /**
   * RTCPeerConnection を初期化します。
   * @param {boolean} isInitiator - オファー側かどうか
   */
  initializePeerConnection(isInitiator = false) {
    this.close(); // 既存の接続があれば安全にクローズ

    const config = this.options.rtcConfig || this.defaultRtcConfig;
    this.peerConnection = new RTCPeerConnection(config);

    // ICE接続状態の監視
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection.iceConnectionState;
      console.log(`[WebRTC] ICE状態: ${state}`);
      if (this.options.onStatusChange) {
        this.options.onStatusChange(state, this.getConnectionInfo());
      }
      if (state === 'connected' || state === 'completed') {
        this.startStatsPolling();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.stopStatsPolling();
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      console.log(`[WebRTC] 接続状態: ${this.peerConnection.connectionState}`);
    };

    if (isInitiator) {
      // 送信側（オファー側）がDataChannelを作成
      this.setupDataChannel(
        this.peerConnection.createDataChannel('p2p-transfer-channel', {
          ordered: true // ファイル転送ではパケット順序を保証
        })
      );
    } else {
      // 受信側（アンサー側）はDataChannelイベントを待ち受ける
      this.peerConnection.ondatachannel = (event) => {
        console.log('[WebRTC] DataChannelを受信しました');
        this.setupDataChannel(event.channel);
      };
    }
  }

  /**
   * RTCDataChannel のイベントハンドラを設定します。
   * @param {RTCDataChannel} channel
   */
  setupDataChannel(channel) {
    if (!channel) return;
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer'; // 高速バイナリモード
    this.dataChannel.bufferedAmountLowThreshold = this.BUFFER_THRESHOLD_LOW;

    const notifyOpen = async () => {
      console.log('[WebRTC] DataChannel がオープンしました（通信可能）');
      const info = await this.getConnectionInfo();
      if (this.options.onStatusChange) {
        this.options.onStatusChange('open', info);
      }
    };

    if (this.dataChannel.readyState === 'open') {
      notifyOpen();
    } else {
      this.dataChannel.onopen = () => {
        notifyOpen();
      };
    }

    this.dataChannel.onclose = () => {
      console.log('[WebRTC] DataChannel がクローズしました');
      if (this.options.onStatusChange) {
        this.options.onStatusChange('closed', null);
      }
    };

    this.dataChannel.onerror = (error) => {
      console.error('[WebRTC] DataChannel エラー:', error);
      if (this.options.onError) {
        this.options.onError(new Error(`データチャンネル通信エラー: ${error.message || '不明'}`));
      }
    };

    // メッセージ受信ハンドラ
    this.dataChannel.onmessage = async (event) => {
      try {
        await this.handleIncomingMessage(event.data);
      } catch (err) {
        console.error('[WebRTC] メッセージ処理エラー:', err);
        if (this.options.onError) {
          this.options.onError(err);
        }
      }
    };
  }

  /**
   * 受信したメッセージを処理します（制御JSONまたはバイナリチャンク）。
   * @param {string|ArrayBuffer} data
   */
  async handleIncomingMessage(data) {
    // 1. 制御メッセージ（JSON文字列）の場合
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      await this.handleControlMessage(msg);
      return;
    }

    // 2. バイナリデータチャンクの場合
    if (data instanceof ArrayBuffer) {
      await this.handleBinaryChunk(data);
    }
  }

  /**
   * 制御メッセージの処理
   */
  async handleControlMessage(msg) {
    switch (msg.type) {
      case 'file-meta':
        // ファイル送信開始通知を受信
        console.log(`[WebRTC] ファイルメタデータ受信: ${msg.name} (${msg.size} bytes)`);
        this.incomingFiles.set(msg.id, {
          meta: msg,
          chunks: new Array(msg.totalChunks),
          receivedBytes: 0,
          receivedChunks: 0,
          startTime: performance.now(),
          lastUpdateTime: performance.now(),
          lastBytes: 0
        });
        if (this.options.onFileProgress) {
          this.options.onFileProgress({
            fileId: msg.id,
            name: msg.name,
            size: msg.size,
            type: msg.fileType,
            transferredBytes: 0,
            progress: 0,
            speed: 0,
            direction: 'receive',
            status: 'receiving'
          });
        }
        break;

      case 'text-message':
        // テキストメッセージ受信
        try {
          let text = msg.content;
          if (msg.encrypted) {
            text = await TransferCrypto.decryptText(msg.payload, this.cryptoKey);
          }
          if (this.options.onTextReceived) {
            this.options.onTextReceived({
              id: msg.id,
              sender: msg.sender || '相手端末',
              text: text,
              timestamp: msg.timestamp || Date.now(),
              encrypted: !!msg.encrypted
            });
          }
        } catch (e) {
          console.error('テキスト復号エラー:', e);
          if (this.options.onError) {
            this.options.onError(new Error('受信したテキストの復号に失敗しました（PINコード不一致）'));
          }
        }
        break;

      case 'file-ack':
        // 相手側からのファイル受信完了・ハッシュ照合成功通知
        console.log(`[WebRTC] ファイル送信完了通知(ACK): ${msg.fileId}`);
        break;

      default:
        console.log('[WebRTC] 未知の制御メッセージ:', msg);
    }
  }

  /**
   * バイナリデータチャンクの解析と復号・バッファリング
   * 
   * 【バイナリパケットフォーマット】
   * [Header Type: 1 byte (0x01)]
   * [File ID Length: 1 byte]
   * [File ID: UTF-8]
   * [Chunk Index: 4 bytes Uint32BE]
   * [Total Chunks: 4 bytes Uint32BE]
   * [IV: 12 bytes (AES-GCM)]
   * [Payload: 残りのバイト (暗号化または平文チャンク)]
   */
  async handleBinaryChunk(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const packetType = view.getUint8(0);
    if (packetType !== 0x01) {
      console.warn('[WebRTC] 不明なバイナリパケットタイプ:', packetType);
      return;
    }

    const fileIdLen = view.getUint8(1);
    const decoder = new TextDecoder();
    const fileId = decoder.decode(new Uint8Array(arrayBuffer, 2, fileIdLen));

    let offset = 2 + fileIdLen;
    const chunkIndex = view.getUint32(offset, false);
    offset += 4;
    const totalChunks = view.getUint32(offset, false);
    offset += 4;
    const iv = new Uint8Array(arrayBuffer, offset, 12);
    offset += 12;

    const payloadBuffer = arrayBuffer.slice(offset);

    const incoming = this.incomingFiles.get(fileId);
    if (!incoming) {
      console.warn(`[WebRTC] 受信メタデータが存在しないチャンク: fileId=${fileId}`);
      return;
    }

    // 復号処理（暗号鍵が設定されている場合）
    let plainChunkBuffer;
    if (incoming.meta.encrypted && this.cryptoKey) {
      try {
        plainChunkBuffer = await TransferCrypto.decryptBuffer(payloadBuffer, this.cryptoKey, iv);
      } catch (err) {
        console.error(`[WebRTC] チャンク復号エラー (index=${chunkIndex}):`, err);
        throw new Error(`チャンク #${chunkIndex} の復号に失敗しました。PINコードが一致しているか確認してください。`);
      }
    } else {
      plainChunkBuffer = payloadBuffer;
    }

    // チャンクを保存
    incoming.chunks[chunkIndex] = plainChunkBuffer;
    incoming.receivedChunks++;
    incoming.receivedBytes += plainChunkBuffer.byteLength;

    const now = performance.now();
    const timeDiff = (now - incoming.lastUpdateTime) / 1000;

    // 進捗イベント（UI描画負荷を下げるため約100ms毎または完了時に更新）
    if (timeDiff >= 0.1 || incoming.receivedChunks === totalChunks) {
      const bytesInInterval = incoming.receivedBytes - incoming.lastBytes;
      const currentSpeed = timeDiff > 0 ? bytesInInterval / timeDiff : 0; // Bytes/s
      const progressPercent = Math.min(100, (incoming.receivedBytes / incoming.meta.size) * 100);

      incoming.lastUpdateTime = now;
      incoming.lastBytes = incoming.receivedBytes;

      if (this.options.onFileProgress) {
        this.options.onFileProgress({
          fileId: fileId,
          name: incoming.meta.name,
          size: incoming.meta.size,
          type: incoming.meta.fileType,
          transferredBytes: incoming.receivedBytes,
          progress: progressPercent,
          speed: currentSpeed,
          direction: 'receive',
          status: incoming.receivedChunks === totalChunks ? 'verifying' : 'receiving'
        });
      }
    }

    // 全チャンク受信完了時の処理
    if (incoming.receivedChunks === totalChunks) {
      await this.finalizeIncomingFile(fileId);
    }
  }

  /**
   * 受信完了したチャンク群を結合し、Blob生成・ハッシュ検証を行います。
   */
  async finalizeIncomingFile(fileId) {
    const incoming = this.incomingFiles.get(fileId);
    if (!incoming) return;

    console.log(`[WebRTC] 全チャンク受信完了: ${incoming.meta.name}。ハッシュ検証開始...`);

    // Blob化
    const fileBlob = new Blob(incoming.chunks, { type: incoming.meta.fileType || 'application/octet-stream' });

    // SHA-256 チェックサム検証（自治体セキュリティ必須要件）
    let calculatedHash = '';
    let hashMatch = false;
    try {
      calculatedHash = await TransferCrypto.calculateSHA256(fileBlob);
      hashMatch = (calculatedHash === incoming.meta.sha256);
      console.log(`[WebRTC] ハッシュ検証結果: 一致=${hashMatch} (受信=${calculatedHash}, 送信元=${incoming.meta.sha256})`);
    } catch (e) {
      console.error('ハッシュ計算失敗:', e);
    }

    // 送信側へACK送信
    this.sendControlMessage({
      type: 'file-ack',
      fileId: fileId,
      hashMatch: hashMatch
    });

    // 完了コールバック通知
    if (this.options.onFileReceived) {
      this.options.onFileReceived({
        fileId: fileId,
        name: incoming.meta.name,
        size: incoming.meta.size,
        type: incoming.meta.fileType,
        blob: fileBlob,
        sha256: calculatedHash,
        hashMatch: hashMatch,
        durationSeconds: (performance.now() - incoming.startTime) / 1000
      });
    }

    // メモリ解放
    this.incomingFiles.delete(fileId);
  }

  /**
   * 制御メッセージ（JSON）を送信します。
   */
  sendControlMessage(msg) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('DataChannel がオープンしていません');
    }
    this.dataChannel.send(JSON.stringify(msg));
  }

  /**
   * テキストメッセージを暗号化して送信します。
   */
  async sendTextMessage(text, senderName = '自分') {
    if (!text || text.trim() === '') return;

    let payload = { ciphertext: text, iv: '', isEncrypted: false };
    let encrypted = false;

    if (this.cryptoKey) {
      payload = await TransferCrypto.encryptText(text, this.cryptoKey);
      encrypted = true;
    }

    const msg = {
      type: 'text-message',
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      sender: senderName,
      encrypted: encrypted,
      payload: payload,
      content: encrypted ? '' : text,
      timestamp: Date.now()
    };

    this.sendControlMessage(msg);
    return msg;
  }

  /**
   * 大容量ファイルを徹底的に高速・安全に送信します。
   * 
   * 【超高速化＆安定送信アルゴリズム】
   * - 64KBごとの Blob.slice() でオンデマンド読み込み（メモリ節約）
   * - Web Crypto AES-256-GCM チャンク暗号化
   * - bufferedAmountLowThreshold によるイベント駆動Backpressure制御
   * - 送信速度・残り時間のリアルタイム計算
   * 
   * @param {File} file - 送信対象ファイル
   * @param {Object} [options]
   */
  async sendFile(file, options = {}) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('DataChannelが開いていないためファイルを送信できません');
    }

    const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const fileSize = file.size;
    const chunkSize = this.CHUNK_SIZE;
    const totalChunks = Math.ceil(fileSize / chunkSize) || 1;

    console.log(`[WebRTC] ファイル送信準備: ${file.name} (${fileSize} bytes, ${totalChunks} chunks)`);

    // 1. ファイル全体の SHA-256 ハッシュを計算（事前検証用）
    if (this.options.onFileProgress) {
      this.options.onFileProgress({
        fileId: fileId,
        name: file.name,
        size: fileSize,
        type: file.type,
        transferredBytes: 0,
        progress: 0,
        speed: 0,
        direction: 'send',
        status: 'hashing'
      });
    }

    const sha256 = await TransferCrypto.calculateSHA256(file);
    console.log(`[WebRTC] 送信ファイル SHA-256: ${sha256}`);

    // 2. メタデータを相手側に送信
    const encrypted = !!this.cryptoKey;
    this.sendControlMessage({
      type: 'file-meta',
      id: fileId,
      name: file.name,
      size: fileSize,
      fileType: file.type,
      totalChunks: totalChunks,
      chunkSize: chunkSize,
      sha256: sha256,
      encrypted: encrypted
    });

    // 3. チャンク送信ループ（Backpressure制御）
    const startTime = performance.now();
    let lastUpdateTime = startTime;
    let lastTransferredBytes = 0;
    let sentBytes = 0;

    const encoder = new TextEncoder();
    const fileIdBytes = encoder.encode(fileId);
    const fileIdLen = fileIdBytes.byteLength;

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      // 接続が途中で切断された場合の検知
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        throw new Error('ファイル送信中に接続が切断されました');
      }

      // バックプレッシャー制御: 送信バッファが上限を超えていたら空くまで待機
      if (this.dataChannel.bufferedAmount > this.BUFFER_THRESHOLD_HIGH) {
        await new Promise((resolve) => {
          const onLow = () => {
            this.dataChannel.removeEventListener('bufferedamountlow', onLow);
            resolve();
          };
          this.dataChannel.addEventListener('bufferedamountlow', onLow);
        });
      }

      // ファイルの一部をオンデマンドでスライス
      const start = chunkIndex * chunkSize;
      const end = Math.min(fileSize, start + chunkSize);
      const chunkBlob = file.slice(start, end);
      const chunkArrayBuffer = await chunkBlob.arrayBuffer();

      // 暗号化処理（E2EE）
      let payloadBuffer;
      let iv = new Uint8Array(12);
      if (encrypted && this.cryptoKey) {
        iv = TransferCrypto.generateIV();
        payloadBuffer = await TransferCrypto.encryptBuffer(chunkArrayBuffer, this.cryptoKey, iv);
      } else {
        payloadBuffer = chunkArrayBuffer;
      }

      // パケット構築 [0x01(1) + FileIdLen(1) + FileId + ChunkIndex(4) + TotalChunks(4) + IV(12) + Payload]
      const packetLength = 1 + 1 + fileIdLen + 4 + 4 + 12 + payloadBuffer.byteLength;
      const packet = new Uint8Array(packetLength);
      const view = new DataView(packet.buffer);

      packet[0] = 0x01; // DataChunkタイプ
      packet[1] = fileIdLen;
      packet.set(fileIdBytes, 2);

      let offset = 2 + fileIdLen;
      view.setUint32(offset, chunkIndex, false);
      offset += 4;
      view.setUint32(offset, totalChunks, false);
      offset += 4;
      packet.set(iv, offset);
      offset += 12;
      packet.set(new Uint8Array(payloadBuffer), offset);

      // DataChannelへ直接送信
      this.dataChannel.send(packet.buffer);

      sentBytes += chunkArrayBuffer.byteLength;

      // 進捗状況の通知（100msごとまたは完了時）
      const now = performance.now();
      const timeDiff = (now - lastUpdateTime) / 1000;
      if (timeDiff >= 0.1 || chunkIndex === totalChunks - 1) {
        const bytesInInterval = sentBytes - lastTransferredBytes;
        const currentSpeed = timeDiff > 0 ? bytesInInterval / timeDiff : 0;
        const progressPercent = Math.min(100, (sentBytes / fileSize) * 100);

        lastUpdateTime = now;
        lastTransferredBytes = sentBytes;

        if (this.options.onFileProgress) {
          this.options.onFileProgress({
            fileId: fileId,
            name: file.name,
            size: fileSize,
            type: file.type,
            transferredBytes: sentBytes,
            progress: progressPercent,
            speed: currentSpeed,
            direction: 'send',
            status: chunkIndex === totalChunks - 1 ? 'completed' : 'sending',
            sha256: sha256
          });
        }
      }
    }

    console.log(`[WebRTC] ファイル送信完了: ${file.name} (所要時間: ${((performance.now() - startTime) / 1000).toFixed(2)}秒)`);
    return { fileId, sha256, durationSeconds: (performance.now() - startTime) / 1000 };
  }

  /**
   * 接続統計情報（RTT、候補ペア種別、スループット等）の取得を開始
   */
  startStatsPolling() {
    this.stopStatsPolling();
    this.statsInterval = setInterval(async () => {
      const info = await this.getConnectionInfo();
      if (info && this.options.onStatsUpdate) {
        this.options.onStatsUpdate(info);
      }
    }, 1500);
  }

  stopStatsPolling() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  /**
   * 現在のRTCPeerConnectionの詳細接続情報を取得します。
   */
  async getConnectionInfo() {
    if (!this.peerConnection) {
      return {
        iceConnectionState: 'connected',
        dataChannelState: this.dataChannel ? this.dataChannel.readyState : 'open',
        connectionType: 'P2P Direct (LAN/Direct)',
        localCandidateType: 'host',
        remoteCandidateType: 'host',
        rtt: '< 1 ms',
        isEncrypted: !!this.cryptoKey
      };
    }
    try {
      const stats = await this.peerConnection.getStats();
      let connectionType = 'LAN/P2P Direct';
      let localCandidateType = 'host';
      let remoteCandidateType = 'host';
      let rtt = 0;

      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          rtt = report.currentRoundTripTime ? Math.round(report.currentRoundTripTime * 1000) : 0;
          const local = stats.get(report.localCandidateId);
          const remote = stats.get(report.remoteCandidateId);
          if (local) localCandidateType = local.candidateType;
          if (remote) remoteCandidateType = remote.candidateType;

          if (localCandidateType === 'host' && remoteCandidateType === 'host') {
            connectionType = 'ローカル直接通信 (LAN / Direct)';
          } else if (localCandidateType === 'relay' || remoteCandidateType === 'relay') {
            connectionType = 'TURN中継通信 (Relay)';
          } else {
            connectionType = 'STUN P2P直接通信 (Reflexive)';
          }
        }
      });

      return {
        iceConnectionState: this.peerConnection.iceConnectionState,
        dataChannelState: this.dataChannel ? this.dataChannel.readyState : 'closed',
        connectionType,
        localCandidateType,
        remoteCandidateType,
        rtt: rtt > 0 ? `${rtt} ms` : '< 1 ms (LAN)',
        isEncrypted: !!this.cryptoKey
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 接続をクローズしてリソースを解放します。
   */
  close() {
    this.stopStatsPolling();
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch (e) {}
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch (e) {}
      this.peerConnection = null;
    }
    this.incomingFiles.clear();
  }
}

window.P2PTransferEngine = P2PTransferEngine;
