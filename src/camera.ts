/*
 * Copyright 2023 Google LLC
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA
 */

import initModule, { CameraEvent, Context, FileInfo, Module } from '../build/libapi.mjs';

export type { CameraEvent, Config, FileInfo, SupportedOps } from '../build/libapi.mjs';

export interface TetheredOptions {
  formats?: string[];
  deleteAfterDownload?: boolean;
  timeout?: number;
  signal: AbortSignal;
  onFile?: (file: File, event: CameraEvent) => void;
  onEvent?: (event: CameraEvent) => void;
}

// A helper that allows to distinguish critical errors from library errors.
export function rethrowIfCritical(err: any) {
  // If it's precisely Error, it's a custom error; anything else - SyntaxError,
  // WebAssembly.RuntimeError, TypeError, etc. - is treated as critical here.
  if (err?.constructor !== Error) {
    throw err;
  }
}

const INTERFACE_CLASS = 6; // PTP
const INTERFACE_SUBCLASS = 1; // MTP

let ModulePromise: Promise<Module> | undefined;

export class Camera {
  #queue: Promise<any> = Promise.resolve();
  #context: Context | null = null;
  #disconnecting = false;
  #onDisconnect: (() => void) | null = null;

  static async showPicker() {
    // @ts-ignore
    await navigator.usb.requestDevice({
      filters: [
        {
          classCode: INTERFACE_CLASS,
          subclassCode: INTERFACE_SUBCLASS
        }
      ]
    });
  }

  static async autoDetect() {
    if (!ModulePromise) {
      ModulePromise = initModule();
    }
    let Module = await ModulePromise;
    return Module.detectCameras();
  }

  get isConnected(): boolean {
    try {
      return this.#context !== null && !this.#context.isDeleted();
    } catch {
      return false;
    }
  }

  set onDisconnect(callback: (() => void) | null) {
    this.#onDisconnect = callback;
  }

  async connect() {
    // Clean up previous connection first
    if (this.#context) {
      await this.disconnect();
    }

    try {
      if (!ModulePromise) {
        ModulePromise = initModule();
      }
      let Module = await ModulePromise;
      this.#context = await new Module.Context();
    } catch (e) {
      // Connection failed — force fresh WASM module on next attempt
      this.#context = null;
      ModulePromise = undefined;
      throw e;
    }
  }

  async #schedule<T>(op: (context: Context) => Promise<T>): Promise<T> {
    let res = this.#queue.then(() => {
      if (!this.#context || this.#context.isDeleted()) {
        throw new Error('Camera is disconnected');
      }
      return op(this.#context);
    });
    // Absorb errors to keep the queue chain alive.
    // The error is already propagated to the caller via `res`.
    // Previous code called rethrowIfCritical() here which re-threw
    // RuntimeError, permanently breaking the queue chain.
    this.#queue = res.catch(async (e) => {
      if (this.#isDisconnectError(e)) {
        await this.disconnect();
      }
    });
    return res;
  }

  #isDisconnectError(e: any): boolean {
    if (e instanceof WebAssembly.RuntimeError) return true;
    const msg = e?.message ?? '';
    return msg.includes('device was disconnected') ||
           msg.includes('A transfer error has occurred') ||
           msg.includes('out of bounds');
  }

  async disconnect() {
    if (this.#disconnecting) return;
    this.#disconnecting = true;

    try {
      // 1. Clear context reference FIRST — prevents any queued operation
      //    from touching the (possibly corrupt) context.
      const ctx = this.#context;
      this.#context = null;

      // 2. Reset the operation queue so pending ops get a clean
      //    'Camera is disconnected' error instead of cascading failures.
      this.#queue = Promise.resolve();

      // 3. Try to run the C++ destructor. This calls gp_camera_unref →
      //    gp_camera_exit → libusb close.  It may throw if WASM state is
      //    corrupt — that is expected after a physical disconnect.
      if (ctx) {
        try {
          if (!ctx.isDeleted()) {
            ctx.delete();
          }
        } catch {
          // Swallow — WASM heap may be corrupt.
        }
      }

      // 4. Drop the WASM module so the next connect() creates a fresh
      //    instance.  Once ModulePromise and #context are both null the
      //    old Module becomes unreachable and eligible for GC — including
      //    its entire ArrayBuffer heap and all emval handles.
      ModulePromise = undefined;

      // 5. Notify listener
      if (this.#onDisconnect) {
        try { this.#onDisconnect(); } catch { /* listener error is not our problem */ }
      }
    } finally {
      this.#disconnecting = false;
    }
  }

  async getConfig() {
    return this.#schedule(context => context.configToJS());
  }

  async getSupportedOps() {
    return this.#schedule(async context => context.supportedOps());
  }

  async setConfigValue(name: string, value: string | number | boolean) {
    let uiTimeout: Promise<void> | undefined;
    await this.#schedule(context => {
      // This is terrible, yes... but some configs return too quickly before they're actually updated.
      // We want to wait some time before updating the UI in that case, but not block subsequent ops.
      uiTimeout = new Promise(resolve => setTimeout(resolve, 800));
      return context.setConfigValue(name, value);
    });
    await uiTimeout;
  }

  async capturePreviewAsBlob() {
    return this.#schedule(context => context.capturePreviewAsBlob());
  }

  async captureImageAsFile() {
    return this.#schedule(context => context.captureImageAsFile());
  }

  async consumeEvents() {
    return this.#schedule(context => context.consumeEvents());
  }

  async waitForEvent(timeout: number = 1000): Promise<CameraEvent> {
    return this.#schedule(context => context.waitForEvent(timeout));
  }

  async downloadFile(folder: string, name: string): Promise<File> {
    return this.#schedule(context => context.downloadFile(folder, name));
  }

  async deleteFile(folder: string, name: string): Promise<void> {
    return this.#schedule(context => context.deleteFile(folder, name));
  }

  async listFolders(folder: string = '/'): Promise<string[]> {
    return this.#schedule(context => context.listFolders(folder));
  }

  async listFiles(folder: string = '/'): Promise<FileInfo[]> {
    return this.#schedule(context => context.listFiles(folder));
  }

  async listAllFiles(folder: string = '/'): Promise<FileInfo[]> {
    const files = await this.listFiles(folder);
    const subfolders = await this.listFolders(folder);
    for (const sub of subfolders) {
      const subPath = folder === '/' ? '/' + sub : folder + '/' + sub;
      const subFiles = await this.listAllFiles(subPath);
      files.push(...subFiles);
    }
    return files;
  }

  async startTetheredCapture(options: TetheredOptions): Promise<void> {
    const {
      formats,
      deleteAfterDownload = false,
      timeout = 1000,
      signal,
      onFile,
      onEvent
    } = options;

    const normalizedFormats = formats?.map(f => f.toLowerCase().replace(/^\./, ''));

    while (!signal.aborted) {
      let event: CameraEvent;
      try {
        event = await this.waitForEvent(timeout);
      } catch (e: any) {
        if (signal.aborted) break;
        throw e;
      }

      if (signal.aborted) break;
      if (onEvent) onEvent(event);

      if (event.type === 'file_added' && event.folder && event.name) {
        const ext = event.name.split('.').pop()?.toLowerCase() ?? '';
        const wanted = !normalizedFormats || normalizedFormats.length === 0 ||
                       normalizedFormats.includes(ext);

        if (wanted && onFile) {
          const file = await this.downloadFile(event.folder, event.name);
          onFile(file, event);
        }

        if (deleteAfterDownload || !wanted) {
          await this.deleteFile(event.folder, event.name).catch(() => {});
        }
      }
    }
  }
}
