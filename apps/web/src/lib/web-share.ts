// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Web Share API utility with fallback to download.
 *
 * Uses navigator.share when available (mobile browsers, some desktop).
 * Falls back to creating a temporary download link for the blob.
 */

/**
 * Check whether the browser supports native sharing with file attachments.
 * Returns false in SSR or when the Web Share API is unavailable.
 */
export function canNativeShare(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!navigator.share) return false;
  if (!navigator.canShare) return false;

  try {
    const testFile = new File([], 'test.png', { type: 'image/png' });
    return navigator.canShare({ files: [testFile] });
  } catch {
    return false;
  }
}

/**
 * Share an image blob via the Web Share API, with a download fallback.
 *
 * @param blob - The image blob to share
 * @param text - Share text / description
 * @param filename - Downloaded file name (default: 'eco-impact.png')
 * @returns true if native share was used, false if fallback download was triggered
 */
export async function shareImage(
  blob: Blob,
  text: string,
  filename = 'eco-impact.png',
): Promise<boolean> {
  if (canNativeShare()) {
    try {
      const file = new File([blob], filename, { type: blob.type || 'image/png' });
      await navigator.share({ text, files: [file] });
      return true;
    } catch (err) {
      // AbortError means user cancelled -- not an error, but native was attempted
      if (err instanceof Error && err.name === 'AbortError') {
        return true;
      }
      // Fall through to download fallback
    }
  }

  // Fallback: create a temporary download link
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Revoke after a short delay to ensure download starts
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return false;
}
