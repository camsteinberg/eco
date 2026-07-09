// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock BroadcastChannel (jsdom does not provide it)
// ---------------------------------------------------------------------------

type MockChannelHandler = (event: { data: unknown }) => void;

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  name: string;
  onmessage: MockChannelHandler | null = null;
  private handlers: MockChannelHandler[] = [];
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    // Deliver to all OTHER instances on the same channel name
    for (const inst of MockBroadcastChannel.instances) {
      if (inst !== this && inst.name === this.name && !inst.closed) {
        const event = { data };
        if (inst.onmessage) inst.onmessage(event);
        for (const h of inst.handlers) h(event);
      }
    }
  }

  addEventListener(_event: string, handler: MockChannelHandler): void {
    this.handlers.push(handler);
  }

  removeEventListener(_event: string, handler: MockChannelHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  close(): void {
    this.closed = true;
    const idx = MockBroadcastChannel.instances.indexOf(this);
    if (idx >= 0) MockBroadcastChannel.instances.splice(idx, 1);
  }
}

// ---------------------------------------------------------------------------
// Mock navigator.locks
// ---------------------------------------------------------------------------

type LockCallback = (lock: { name: string } | null) => Promise<unknown>;

type PendingLockRequest = {
  name: string;
  options: { ifAvailable?: boolean; steal?: boolean };
  callback: LockCallback;
  resolve: (val: unknown) => void;
  reject: (err: unknown) => void;
};

class MockWebLocks {
  private heldLocks = new Map<string, { releaseResolve: (() => void) | null }>();
  private waitingQueue: PendingLockRequest[] = [];

  async request(
    name: string,
    optionsOrCallback: Record<string, unknown> | LockCallback,
    maybeCallback?: LockCallback,
  ): Promise<unknown> {
    let options: { ifAvailable?: boolean; steal?: boolean } = {};
    let callback: LockCallback;

    if (typeof optionsOrCallback === "function") {
      callback = optionsOrCallback;
    } else {
      options = optionsOrCallback as { ifAvailable?: boolean; steal?: boolean };
      callback = maybeCallback!;
    }

    if (options.ifAvailable) {
      if (this.heldLocks.has(name)) {
        // Lock not available
        return callback(null);
      }
      // Acquire immediately
      return this._acquire(name, callback);
    }

    if (this.heldLocks.has(name)) {
      // Queue it
      return new Promise<unknown>((resolve, reject) => {
        this.waitingQueue.push({ name, options, callback, resolve, reject });
      });
    }

    return this._acquire(name, callback);
  }

  private async _acquire(name: string, callback: LockCallback): Promise<unknown> {
    const entry: { releaseResolve: (() => void) | null } = { releaseResolve: null };
    this.heldLocks.set(name, entry);

    try {
      const result = await callback({ name });
      return result;
    } finally {
      this.heldLocks.delete(name);
      this._processQueue(name);
    }
  }

  /** Simulate the leader releasing the lock (e.g. tab closing). */
  releaseLock(name: string): void {
    this.heldLocks.delete(name);
    this._processQueue(name);
  }

  private _processQueue(name: string): void {
    const idx = this.waitingQueue.findIndex((r) => r.name === name);
    if (idx >= 0) {
      const next = this.waitingQueue.splice(idx, 1)[0]!;
      this._acquire(name, next.callback).then(next.resolve, next.reject);
    }
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let mockLocks: MockWebLocks;

beforeEach(() => {
  MockBroadcastChannel.instances = [];
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);

  mockLocks = new MockWebLocks();
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    locks: mockLocks,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Lazy import to ensure mocks are in place before the module evaluates
async function loadCoordinator() {
  // Force fresh module for each test
  const mod = await import("../../lib/inference-coordinator");
  return mod;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InferenceCoordinator", () => {
  it("calls onBecomeLeader when lock acquired", async () => {
    const { InferenceCoordinator } = await loadCoordinator();
    const onBecomeLeader = vi.fn();
    const onBecomeFollower = vi.fn();

    const coordinator = new InferenceCoordinator({
      onBecomeLeader,
      onBecomeFollower,
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });

    await coordinator.start();
    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 10));

    expect(onBecomeLeader).toHaveBeenCalled();
    expect(onBecomeFollower).not.toHaveBeenCalled();

    coordinator.cleanup();
  });

  it("calls onBecomeFollower when lock already held", async () => {
    const { InferenceCoordinator } = await loadCoordinator();

    // First coordinator acquires the lock
    const leader = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });
    await leader.start();
    await new Promise((r) => setTimeout(r, 10));

    // Second coordinator should become follower
    const onBecomeLeader = vi.fn();
    const onBecomeFollower = vi.fn();
    const follower = new InferenceCoordinator({
      onBecomeLeader,
      onBecomeFollower,
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });

    await follower.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(onBecomeFollower).toHaveBeenCalled();
    expect(onBecomeLeader).not.toHaveBeenCalled();

    leader.cleanup();
    follower.cleanup();
  });

  it("falls back to leader mode when Web Locks unavailable", async () => {
    // Remove navigator.locks
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      locks: undefined,
    });

    const { InferenceCoordinator } = await loadCoordinator();
    const onBecomeLeader = vi.fn();
    const onBecomeFollower = vi.fn();

    const coordinator = new InferenceCoordinator({
      onBecomeLeader,
      onBecomeFollower,
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });

    await coordinator.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(onBecomeLeader).toHaveBeenCalled();
    expect(coordinator.role).toBe("leader");

    coordinator.cleanup();
  });

  it("leader broadcasts tokens via BroadcastChannel with sequence numbers", async () => {
    const { InferenceCoordinator } = await loadCoordinator();

    const followerTokens: { token: string; messageId: string; seq: number }[] = [];

    const leader = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });
    await leader.start();
    await new Promise((r) => setTimeout(r, 10));

    const follower = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: (token, messageId, seq) => {
        followerTokens.push({ token, messageId, seq });
      },
      onGenerateRequest: vi.fn(),
    });
    await follower.start();
    await new Promise((r) => setTimeout(r, 10));

    // Leader broadcasts tokens
    leader.broadcastToken("Hello", "msg-1", 0);
    leader.broadcastToken(" world", "msg-1", 1);
    await new Promise((r) => setTimeout(r, 10));

    expect(followerTokens).toHaveLength(2);
    expect(followerTokens[0]).toEqual({ token: "Hello", messageId: "msg-1", seq: 0 });
    expect(followerTokens[1]).toEqual({ token: " world", messageId: "msg-1", seq: 1 });

    leader.cleanup();
    follower.cleanup();
  });

  it("follower receives tokens in correct order", async () => {
    const { InferenceCoordinator } = await loadCoordinator();

    const received: string[] = [];

    const leader = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });
    await leader.start();
    await new Promise((r) => setTimeout(r, 10));

    const follower = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: (token) => {
        received.push(token);
      },
      onGenerateRequest: vi.fn(),
    });
    await follower.start();
    await new Promise((r) => setTimeout(r, 10));

    leader.broadcastToken("A", "msg-1", 0);
    leader.broadcastToken("B", "msg-1", 1);
    leader.broadcastToken("C", "msg-1", 2);
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toEqual(["A", "B", "C"]);

    leader.cleanup();
    follower.cleanup();
  });

  it("follower can send generate request to leader via BroadcastChannel", async () => {
    const { InferenceCoordinator } = await loadCoordinator();

    const generateRequests: { prompt: string; messageId: string }[] = [];

    const leader = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: (prompt, messageId) => {
        generateRequests.push({ prompt, messageId });
      },
    });
    await leader.start();
    await new Promise((r) => setTimeout(r, 10));

    const follower = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });
    await follower.start();
    await new Promise((r) => setTimeout(r, 10));

    follower.requestGenerate("Hello!", "msg-2");
    await new Promise((r) => setTimeout(r, 10));

    expect(generateRequests).toHaveLength(1);
    expect(generateRequests[0]).toEqual({ prompt: "Hello!", messageId: "msg-2" });

    leader.cleanup();
    follower.cleanup();
  });

  it("new leader announces via BroadcastChannel when acquiring lock after leader death", async () => {
    const { InferenceCoordinator } = await loadCoordinator();

    const followerOnBecomeLeader = vi.fn();

    // Create leader that holds the lock with a never-resolving promise
    const leader = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });
    await leader.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(leader.role).toBe("leader");

    // Create follower that is waiting for the lock
    const follower = new InferenceCoordinator({
      onBecomeLeader: followerOnBecomeLeader,
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });
    await follower.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(follower.role).toBe("follower");

    // Simulate leader tab closing - cleanup releases the lock
    leader.cleanup();
    await new Promise((r) => setTimeout(r, 50));

    // Follower should have become leader
    expect(followerOnBecomeLeader).toHaveBeenCalled();
    expect(follower.role).toBe("leader");

    follower.cleanup();
  });

  it("new leader broadcasts new-leader announcement", async () => {
    const { InferenceCoordinator } = await loadCoordinator();

    let newLeaderReceived = false;

    const leader = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });
    await leader.start();
    await new Promise((r) => setTimeout(r, 10));

    // Create follower that will take over when leader dies
    const follower = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });
    await follower.start();
    await new Promise((r) => setTimeout(r, 10));

    // Create observer AFTER leader and follower are established.
    // The observer also becomes a follower, but it listens for new-leader messages.
    const observer = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
      onNewLeader: () => {
        newLeaderReceived = true;
      },
    });
    await observer.start();
    await new Promise((r) => setTimeout(r, 10));

    // Leader dies -- the follower (which was queued FIRST for the lock)
    // should become the new leader and broadcast new-leader announcement.
    leader.cleanup();
    await new Promise((r) => setTimeout(r, 50));

    // The observer should have received the new-leader announcement
    expect(newLeaderReceived).toBe(true);

    observer.cleanup();
    follower.cleanup();
  });

  it("cleanup closes BroadcastChannel and stops coordination", async () => {
    const { InferenceCoordinator } = await loadCoordinator();

    const coordinator = new InferenceCoordinator({
      onBecomeLeader: vi.fn(),
      onBecomeFollower: vi.fn(),
      onTokenFromLeader: vi.fn(),
      onGenerateRequest: vi.fn(),
    });
    await coordinator.start();
    await new Promise((r) => setTimeout(r, 10));

    expect(coordinator.role).toBe("leader");

    coordinator.cleanup();

    // After cleanup, should be in a cleaned-up state
    // broadcastToken should not throw
    coordinator.broadcastToken("test", "msg", 0);
    expect(coordinator.role).toBe("leader"); // role doesn't reset, just channel closes
  });
});
