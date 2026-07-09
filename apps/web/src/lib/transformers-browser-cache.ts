// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

type CacheProgress = {
  progress: number;
  loaded: number;
  total: number;
};

type TransformersCacheInterface = {
  match(request: string): Promise<Response | undefined>;
  put(
    request: string,
    response: Response,
    progress_callback?: (data: CacheProgress) => void,
  ): Promise<void>;
  delete?(request: string): Promise<boolean>;
};

const TRANSFORMERS_OPFS_DIR = 'eco-transformers-cache';
const DATA_SUFFIX = '.bin';
const META_SUFFIX = '.json';

type StoredResponseMetadata = {
  request: string;
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
  sizeBytes: number;
};

function supportsOpfsCache(): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.storage?.getDirectory === 'function';
}

function getCacheKey(request: string): string {
  return encodeURIComponent(request);
}

function getDataFileName(request: string): string {
  return `${getCacheKey(request)}${DATA_SUFFIX}`;
}

function getMetadataFileName(request: string): string {
  return `${getCacheKey(request)}${META_SUFFIX}`;
}

async function getOpfsCacheDirectory(
  create = true,
): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsOpfsCache()) {
    return null;
  }

  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(TRANSFORMERS_OPFS_DIR, { create });
  } catch {
    return null;
  }
}

async function removeEntryIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await directory.removeEntry(name);
    return true;
  } catch {
    return false;
  }
}

async function writeTextFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  value: string,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();

  try {
    await writable.write(value);
    await writable.close();
  } catch (error) {
    await writable.abort();
    throw error;
  }
}

export function createTransformersBrowserCache(): TransformersCacheInterface | null {
  if (!supportsOpfsCache()) {
    return null;
  }

  return {
    async match(request: string): Promise<Response | undefined> {
      const directory = await getOpfsCacheDirectory(false);
      if (!directory) {
        return undefined;
      }

      try {
        const [dataHandle, metadataHandle] = await Promise.all([
          directory.getFileHandle(getDataFileName(request), { create: false }),
          directory.getFileHandle(getMetadataFileName(request), { create: false }),
        ]);

        const [dataFile, metadataFile] = await Promise.all([
          dataHandle.getFile(),
          metadataHandle.getFile(),
        ]);

        const metadata = JSON.parse(
          await metadataFile.text(),
        ) as StoredResponseMetadata;

        const headers = new Headers(metadata.headers);
        headers.set('x-eco-cache-size-bytes', String(dataFile.size));

        return new Response(dataFile, {
          status: metadata.status,
          statusText: metadata.statusText,
          headers,
        });
      } catch {
        return undefined;
      }
    },

    async put(
      request: string,
      response: Response,
      progress_callback?: (data: CacheProgress) => void,
    ): Promise<void> {
      const directory = await getOpfsCacheDirectory(true);
      if (!directory) {
        throw new Error('Origin private file system is not available.');
      }

      const dataHandle = await directory.getFileHandle(getDataFileName(request), {
        create: true,
      });
      const writable = await dataHandle.createWritable();
      const total = Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0;

      let loaded = 0;

      try {
        if (response.body) {
          const reader = response.body.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            await writable.write(value);
            loaded += value.byteLength;
            progress_callback?.({
              progress: total > 0 ? (loaded / total) * 100 : 0,
              loaded,
              total,
            });
          }
        } else {
          const bytes = new Uint8Array(await response.arrayBuffer());
          await writable.write(bytes);
          loaded = bytes.byteLength;
          progress_callback?.({
            progress: total > 0 ? (loaded / total) * 100 : 100,
            loaded,
            total,
          });
        }

        await writable.close();

        const metadata: StoredResponseMetadata = {
          request,
          headers: [...response.headers.entries()],
          status: response.status,
          statusText: response.statusText,
          sizeBytes: loaded,
        };

        await writeTextFile(
          directory,
          getMetadataFileName(request),
          JSON.stringify(metadata),
        );
      } catch (error) {
        await writable.abort();
        await Promise.all([
          removeEntryIfPresent(directory, getDataFileName(request)),
          removeEntryIfPresent(directory, getMetadataFileName(request)),
        ]);
        throw error;
      }
    },

    async delete(request: string): Promise<boolean> {
      const directory = await getOpfsCacheDirectory(false);
      if (!directory) {
        return false;
      }

      const [dataDeleted, metadataDeleted] = await Promise.all([
        removeEntryIfPresent(directory, getDataFileName(request)),
        removeEntryIfPresent(directory, getMetadataFileName(request)),
      ]);

      return dataDeleted || metadataDeleted;
    },
  };
}

export async function listTransformersCachedRequests(): Promise<string[]> {
  const directory = await getOpfsCacheDirectory(false);
  if (!directory) {
    return [];
  }

  const requests: string[] = [];
  const iterableDirectory = directory as FileSystemDirectoryHandle & AsyncIterable<
    [string, FileSystemHandle]
  >;

  for await (const [name, handle] of iterableDirectory) {
    if (handle.kind !== 'file' || !name.endsWith(META_SUFFIX)) {
      continue;
    }

    try {
      requests.push(decodeURIComponent(name.slice(0, -META_SUFFIX.length)));
    } catch {
      // Ignore malformed filenames and keep scanning.
    }
  }

  return requests;
}

export async function deleteTransformersCachedRequests(
  predicate: (requestUrl: string) => boolean,
): Promise<void> {
  const directory = await getOpfsCacheDirectory(false);
  if (!directory) {
    return;
  }

  const requests = await listTransformersCachedRequests();
  await Promise.all(
    requests
      .filter(predicate)
      .flatMap((request) => [
        removeEntryIfPresent(directory, getDataFileName(request)),
        removeEntryIfPresent(directory, getMetadataFileName(request)),
      ]),
  );
}
