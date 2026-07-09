// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Mock inference worker that emulates the full Worker message protocol.
 *
 * Used in tests to avoid loading @huggingface/transformers or requiring
 * a real Web Worker environment.
 */

type WorkerState = 'idle' | 'loading' | 'compiling' | 'ready' | 'generating' | 'error';

type MockWorkerOptions = {
  tokenDelay?: number;
  tokens?: string[];
  initDelay?: number;
  failInit?: boolean;
  failDownloadOom?: boolean;
};

type MessageHandler = (event: { data: unknown }) => void;

export class MockInferenceWorker {
  private state: WorkerState = 'idle';
  private listeners: Map<string, Set<MessageHandler>> = new Map();
  private options: Required<MockWorkerOptions>;
  private generateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MockWorkerOptions = {}) {
    this.options = {
      tokenDelay: options.tokenDelay ?? 10,
      tokens: options.tokens ?? ['Hello', ' ', 'world', '!'],
      initDelay: options.initDelay ?? 5,
      failInit: options.failInit ?? false,
      failDownloadOom: options.failDownloadOom ?? false,
    };
  }

  addEventListener(event: string, handler: MessageHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  removeEventListener(event: string, handler: MessageHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  terminate(): void {
    if (this.generateTimer) {
      clearTimeout(this.generateTimer);
      this.generateTimer = null;
    }
    this.listeners.clear();
    this.state = 'idle';
  }

  postMessage(data: unknown): void {
    const msg = data as { type: string; [key: string]: unknown };

    switch (msg.type) {
      case 'init':
        this.handleInit(msg.modelId as string | undefined);
        break;
      case 'download':
        this.handleDownload(msg.modelId as string);
        break;
      case 'generate':
        this.handleGenerate();
        break;
      case 'abort':
        this.handleAbort();
        break;
      case 'health':
        this.emit({ type: 'health', ok: true });
        break;
      case 'unload':
        this.state = 'idle';
        this.emit({ type: 'status', state: 'idle' });
        break;
    }
  }

  /**
   * Inject an error for testing error handling.
   */
  injectError(code: string, message: string, recoverable: boolean): void {
    this.state = 'error';
    this.emit({ type: 'error', code, message, recoverable });
  }

  /**
   * Simulate GPU device loss for testing recovery.
   */
  simulateDeviceLoss(): void {
    this.emit({ type: 'error', code: 'DEVICE_LOST', message: 'GPU device lost', recoverable: true });
  }

  /**
   * Get the current internal state (for test assertions).
   */
  getState(): WorkerState {
    return this.state;
  }

  /**
   * Set the internal state (for custom test scenarios).
   */
  setState(state: WorkerState): void {
    this.state = state;
  }

  /**
   * Emit a message event to all listeners. Public for custom test scenarios
   * (e.g., emitting wasm backend status from overridden postMessage).
   */
  emit(data: unknown): void {
    const handlers = this.listeners.get('message');
    if (handlers) {
      for (const handler of handlers) {
        handler({ data });
      }
    }
  }

  private handleDownload(modelId: string): void {
    if (this.options.failDownloadOom) {
      // Simulate OOM during session creation — files are cached, report ready with warning
      this.state = 'loading';
      this.emit({ type: 'status', state: 'loading', message: 'Downloading model...' });
      setTimeout(() => {
        this.state = 'ready';
        this.emit({
          type: 'status',
          state: 'ready',
          modelId,
          message: 'Downloaded. Model will load when you start a conversation.',
        });
      }, this.options.initDelay);
      return;
    }

    this.state = 'loading';
    this.emit({ type: 'status', state: 'loading', message: 'Downloading model...' });

    // Simulate progress
    setTimeout(() => {
      this.emit({ type: 'progress', progress: 50, loaded: 500, total: 1000, status: 'downloading' });
    }, this.options.initDelay / 2);

    setTimeout(() => {
      this.emit({ type: 'progress', progress: 100, loaded: 1000, total: 1000, status: 'done' });
      this.state = 'ready';
      this.emit({ type: 'status', state: 'ready', modelId });
    }, this.options.initDelay);
  }

  private handleInit(modelId?: string): void {
    if (this.options.failInit) {
      this.state = 'error';
      this.emit({ type: 'error', code: 'INIT_FAILED', message: 'Mock init failure', recoverable: false });
      return;
    }

    this.state = 'loading';
    this.emit({ type: 'status', state: 'loading', message: 'Loading model...' });

    setTimeout(() => {
      this.state = 'compiling';
      this.emit({ type: 'status', state: 'compiling', message: 'Compiling shaders...' });

      setTimeout(() => {
        this.state = 'ready';
        this.emit({ type: 'status', state: 'ready', backend: 'webgpu', ...(modelId && { modelId }) });
      }, this.options.initDelay);
    }, this.options.initDelay);
  }

  private handleGenerate(): void {
    if (this.state !== 'ready') {
      this.emit({ type: 'error', code: 'GENERATION_FAILED', message: 'Worker not ready', recoverable: false });
      return;
    }

    this.state = 'generating';
    let tokenIndex = 0;

    const emitNext = (): void => {
      if (this.state !== 'generating') return;

      if (tokenIndex < this.options.tokens.length) {
        this.emit({ type: 'token', text: this.options.tokens[tokenIndex]! });
        tokenIndex++;
        this.generateTimer = setTimeout(emitNext, this.options.tokenDelay);
      } else {
        this.state = 'ready';
        this.emit({
          type: 'done',
          usage: { promptTokens: 10, completionTokens: this.options.tokens.length },
        });
      }
    };

    this.generateTimer = setTimeout(emitNext, this.options.tokenDelay);
  }

  private handleAbort(): void {
    if (this.state === 'generating') {
      if (this.generateTimer) {
        clearTimeout(this.generateTimer);
        this.generateTimer = null;
      }
      this.state = 'ready';
      this.emit({ type: 'done' });
    }
  }
}
