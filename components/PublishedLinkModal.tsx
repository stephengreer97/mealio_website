'use client';

import { useState } from 'react';
import { captionGuidance, detectSourcePlatform, mealShareUrl } from '@/lib/sourcePlatform';

interface Props {
  mealId: string;
  mealName: string;
  /** The meal's source URL, if the creator gave one — decides which guidance shows. */
  source?: string | null;
  onClose: () => void;
}

export default function PublishedLinkModal({ mealId, mealName, source, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const url = mealShareUrl(mealId);
  const guidance = captionGuidance(detectSourcePlatform(source));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked in some browsers/contexts — the link is on screen
      // and selectable, so fall back to letting the creator copy it by hand.
      window.prompt('Copy this link:', url);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white w-full sm:rounded-2xl sm:max-w-md rounded-t-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <span className="inline-flex items-center gap-1.5 bg-green-50 text-green-700 text-xs font-semibold rounded-full px-2.5 py-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
            Live in Discover
          </span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="p-6">
          <p className="text-xs font-medium text-gray-400 mb-1.5">{mealName}</p>
          <h3 className="text-xl font-bold text-gray-900 mb-2">{guidance.title}</h3>
          <p className="text-sm text-gray-600 leading-relaxed mb-4">{guidance.body}</p>

          <div className="border border-gray-200 rounded-xl px-4 py-3 mb-3 bg-gray-50">
            <span className="text-sm font-medium text-red-600 break-all select-all">{url}</span>
          </div>

          <button
            onClick={copy}
            className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold rounded-2xl py-3 text-sm transition-colors flex items-center justify-center gap-2"
          >
            {copied ? (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                Copied
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Copy link
              </>
            )}
          </button>

          {guidance.note && (
            <div className="mt-5 flex gap-2.5 bg-orange-50 border border-orange-100 rounded-xl p-3.5">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <p className="text-xs text-gray-600 leading-relaxed">{guidance.note}</p>
            </div>
          )}

          <button
            onClick={onClose}
            className="w-full mt-3 text-sm font-medium text-gray-500 hover:text-gray-700 py-2 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
