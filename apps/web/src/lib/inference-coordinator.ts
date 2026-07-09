// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Multi-tab inference coordinator.
 *
 * Uses the Web Locks API for leader election and BroadcastChannel for
 * cross-tab token forwarding. Ensures only one tab owns the GPU inference
 * Worker at a time, preventing WebGPU device-loss errors from concurrent
 * access across tabs.
 *
 * Leader tab: creates and owns the inference Worker, broadcasts tokens.
 * Follower tabs: route generate requests to the leader via BroadcastChannel,
 * receive tokens back for rendering.
 *
 * When the leader tab closes, the Web Lock is automatically released and
 * the next waiting follower acquires it, becoming the new leader.
 */

const LOCK_NAME = "eco-inference-leader";
const CHANNEL_NAME = "eco-inference-tokens";
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Channel message types
// ---------------------------------------------------------------------------

type TokenMessage = {
  type: "token";
  token: string;
  messageId: string;
  seq: number;
};

type DoneMessage = {
  type: "done";
  messageId: string;
};

type GenerateMessage = {
  type: "generate";
  prompt: string;
  messageId: string;
};

type NewLeaderMessage = {
  type: "new-leader";
};

type HeartbeatMessage = {
  type: "heartbeat";
};

type ChannelMessage =
  | TokenMessage
  | DoneMessage
  | GenerateMessage
  | NewLeaderMessage
  | HeartbeatMessage;

// ---------------------------------------------------------------------------
// Coordinator callbacks
// ---------------------------------------------------------------------------

export type CoordinatorCallbacks = {
  onBecomeLeader: () => void;
  onBecomeFollower: () => void;
  onTokenFromLeader: (token: string, messageId: string, seq: number) => void;
  onGenerateRequest: (prompt: string, messageId: string) => void;
  /** Called when a new leader announces itself (optional). */
  onNewLeader?: () => void;
  /** Called when generation completes for a forwarded request (optional). */
  onDone?: (messageId: string) => void;
};

// ---------------------------------------------------------------------------
// InferenceCoordinator
// ---------------------------------------------------------------------------

export class InferenceCoordinator {
  private _isLeader = false;
  private _started = false;
  private _cleanedUp = false;
  private channel: BroadcastChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private lockReleaseResolve: (() => void) | null = null;
  private callbacks: CoordinatorCallbacks;

  constructor(callbacks: CoordinatorCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Start the coordination process. Attempts to acquire the Web Lock.
   * If the lock is available, becomes leader. Otherwise, becomes follower
   * and queues a blocking lock request that will fire when the leader releases.
   *
   * This method resolves promptly (does not block on lock acquisition).
   * The lock is held via a fire-and-forget request whose callback returns
   * a never-resolving Promise.
   */
  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    // Create BroadcastChannel for token forwarding
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this._setupChannelHandler();
    }

    // Check if Web Locks API is available
    if (typeof navigator === "undefined" || !navigator.locks) {
      // Fallback: single-tab mode, always leader
      this._isLeader = true;
      this.callbacks.onBecomeLeader();
      return;
    }

    // Fire-and-forget: attempt non-blocking lock acquisition.
    // We do NOT await this -- the lock callback holds a never-resolving
    // Promise that keeps the lock alive until cleanup() resolves it.
    void navigator.locks.request(
      LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        if (lock) {
          // Lock acquired -- we are the leader
          this._isLeader = true;
          this.callbacks.onBecomeLeader();
          this._startHeartbeat();

          // Hold the lock until cleanup resolves this promise
          return new Promise<void>((resolve) => {
            this.lockReleaseResolve = resolve;
          });
        }

        // Lock not available -- we are a follower
        this._isLeader = false;
        this.callbacks.onBecomeFollower();
        this.lastHeartbeat = Date.now();

        // Queue a blocking request that waits for the lock
        this._waitForLock();

        return undefined;
      },
    );

    // Give the microtask queue a tick so the lock callback can run
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  /**
   * Queue a blocking lock request. When the current leader releases
   * (tab closes), this request will resolve and we become the new leader.
   */
  private _waitForLock(): void {
    if (this._cleanedUp) return;
    if (typeof navigator === "undefined" || !navigator.locks) return;

    void navigator.locks.request(LOCK_NAME, async () => {
      if (this._cleanedUp) return;

      this._isLeader = true;
      this.callbacks.onBecomeLeader();
      this._startHeartbeat();

      // Announce new leader to all tabs
      this.channel?.postMessage({ type: "new-leader" } satisfies NewLeaderMessage);

      // Hold the lock until cleanup
      return new Promise<void>((resolve) => {
        this.lockReleaseResolve = resolve;
      });
    });
  }

  /**
   * Set up message handler on the BroadcastChannel.
   */
  private _setupChannelHandler(): void {
    if (!this.channel) return;

    this.channel.onmessage = (event: { data: unknown }) => {
      if (this._cleanedUp) return;
      const msg = event.data as ChannelMessage;

      switch (msg.type) {
        case "token":
          this.callbacks.onTokenFromLeader(msg.token, msg.messageId, msg.seq);
          break;

        case "done":
          this.callbacks.onDone?.(msg.messageId);
          break;

        case "generate":
          if (this._isLeader) {
            this.callbacks.onGenerateRequest(msg.prompt, msg.messageId);
          }
          break;

        case "new-leader":
          this.callbacks.onNewLeader?.();
          break;

        case "heartbeat":
          this.lastHeartbeat = Date.now();
          break;
      }
    };
  }

  /**
   * Start the heartbeat timer (leader only).
   */
  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this._isLeader && this.channel && !this._cleanedUp) {
        this.channel.postMessage({ type: "heartbeat" } satisfies HeartbeatMessage);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat timer.
   */
  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Check if the leader's heartbeat has timed out (follower diagnostic).
   * Returns true if the last heartbeat was received more than
   * HEARTBEAT_TIMEOUT_MS ago. Lock-stealing on stale heartbeat is not yet
   * implemented.
   */
  isHeartbeatStale(): boolean {
    if (this._isLeader) return false;
    if (this.lastHeartbeat === 0) return false;
    return Date.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Public API for cross-tab communication
  // -------------------------------------------------------------------------

  /**
   * Broadcast a generated token to all follower tabs.
   * Should only be called by the leader.
   */
  broadcastToken(token: string, messageId: string, seq: number): void {
    if (!this.channel || this._cleanedUp) return;
    this.channel.postMessage({
      type: "token",
      token,
      messageId,
      seq,
    } satisfies TokenMessage);
  }

  /**
   * Broadcast that generation is complete for a given message.
   * Should only be called by the leader.
   */
  broadcastDone(messageId: string): void {
    if (!this.channel || this._cleanedUp) return;
    this.channel.postMessage({
      type: "done",
      messageId,
    } satisfies DoneMessage);
  }

  /**
   * Request the leader to generate a response. Called by follower tabs.
   */
  requestGenerate(prompt: string, messageId: string): void {
    if (!this.channel || this._cleanedUp) return;
    this.channel.postMessage({
      type: "generate",
      prompt,
      messageId,
    } satisfies GenerateMessage);
  }

  /**
   * Clean up resources: close BroadcastChannel, release lock, stop heartbeat.
   */
  cleanup(): void {
    this._cleanedUp = true;
    this._stopHeartbeat();

    // Release the Web Lock (if we held it), allowing a waiting follower to acquire
    if (this.lockReleaseResolve) {
      this.lockReleaseResolve();
      this.lockReleaseResolve = null;
    }

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }

  /**
   * Current role of this tab.
   */
  get role(): "leader" | "follower" {
    return this._isLeader ? "leader" : "follower";
  }

  /**
   * Whether this coordinator has been cleaned up.
   */
  get isCleanedUp(): boolean {
    return this._cleanedUp;
  }
}
