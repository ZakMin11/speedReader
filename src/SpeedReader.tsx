import React, { useState, useEffect, useRef, useCallback } from 'react';
import './SpeedReader.css';
import { useReading } from './ReadingContext';

interface SpeedReaderProps {
  onNavigateToPdf: () => void;
  isActive: boolean;
}

const SpeedReader: React.FC<SpeedReaderProps> = ({ onNavigateToPdf, isActive }) => {
  const {
    getAllWords,
    currentWordIndex,
    setCurrentWordIndex,
    currentReadingPage,
    setCurrentReadingPage,
    setCurrentViewPage,
    setTargetWord,
    pdfPath,
    totalPages,
    pageTexts,
  } = useReading();

  // Fallback text for when no PDF is loaded
  const fallbackText = "It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions, though not quickly enough to prevent a swirl of gritty dust from entering along with him";

  const words = React.useMemo(() => {
    if (pageTexts.size > 0) {
      return getAllWords();
    }
    return fallbackText.split(/\s+/).filter(word => word.length > 0);
  }, [pageTexts, getAllWords]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpm] = useState(250);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const preloadRequestedRef = useRef<Set<number>>(new Set());

  // ─── ORP display ────────────────────────────────────────────────────────────

  const calculateORP = (word: string): number => Math.round(word.length * 0.35);

  const getWordParts = () => {
    const word = words[currentWordIndex] || '';
    const orpIndex = calculateORP(word);
    return {
      before: word.substring(0, orpIndex),
      orp: word.charAt(orpIndex),
      after: word.substring(orpIndex + 1),
    };
  };

  const wordParts = getWordParts();

  // ─── Page tracking & preloading ─────────────────────────────────────────────
  // Figures out which page the current word belongs to, updates currentReadingPage,
  // and ensures the next pages are preloaded so end-to-end reading never stalls.

  const checkAndPreload = useCallback(() => {
    if (pageTexts.size === 0 || words.length === 0) return;

    const sortedPages = Array.from(pageTexts.keys()).sort((a, b) => a - b);

    // Determine which page the current word index falls on.
    let cumulative = 0;
    let currentPageNum = currentReadingPage;
    for (const page of sortedPages) {
      const pt = pageTexts.get(page)!;
      if (currentWordIndex < cumulative + pt.wordCount) {
        currentPageNum = page;
        break;
      }
      cumulative += pt.wordCount;
    }

    if (currentPageNum !== currentReadingPage) {
      setCurrentReadingPage(currentPageNum);
    }

    // Keep up to 2 unread pages preloaded ahead of the highest loaded page.
    const highestLoaded = sortedPages[sortedPages.length - 1];
    for (let ahead = 1; ahead <= 2; ahead++) {
      const nextPage = highestLoaded + ahead;
      if (
        nextPage <= totalPages &&
        !pageTexts.has(nextPage) &&
        !preloadRequestedRef.current.has(nextPage)
      ) {
        preloadRequestedRef.current.add(nextPage);
        if (typeof (window as any).preloadNextPage === 'function') {
          // Pass the specific page number to load (not just "next after current").
          (window as any).preloadNextPage(nextPage);
        }
        break; // One async request at a time; the next will trigger on the following tick.
      }
    }
  }, [currentWordIndex, words.length, currentReadingPage, totalPages, pageTexts, setCurrentReadingPage]);

  // Run preload check on every word advance (during playback and manual nav).
  useEffect(() => {
    checkAndPreload();
  }, [currentWordIndex, checkAndPreload]);

  // Sync PDF viewer page so "Back to PDF" always lands on the current reading page.
  useEffect(() => {
    setCurrentViewPage(currentReadingPage);
  }, [currentReadingPage, setCurrentViewPage]);

  // ─── Live target word sync ────────────────────────────────────────────────────
  // Mirror the currently-displayed ORP word into the shared targetWord context
  // on every word advance.  This means:
  //   • The badge here always shows the live word.
  //   • The PDF viewer highlights the exact word you were on when you return.
  // PdfViewer is hidden (display:none) so React reconciles without painting —
  // the JS cost is ~100 fast string ops per word, acceptable at any WPM.
  useEffect(() => {
    if (pageTexts.size === 0 || words.length === 0) return;

    const rawWord = words[currentWordIndex] || '';
    const cleanWord = rawWord.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
    if (!cleanWord) return;

    // Compute which page this word is on and its index within that page.
    const sortedPages = Array.from(pageTexts.keys()).sort((a, b) => a - b);
    let cumulative = 0;
    let wordPage = currentReadingPage;
    let wordIndexOnPage = currentWordIndex;
    for (const page of sortedPages) {
      const pt = pageTexts.get(page)!;
      if (currentWordIndex < cumulative + pt.wordCount) {
        wordPage = page;
        wordIndexOnPage = currentWordIndex - cumulative;
        break;
      }
      cumulative += pt.wordCount;
    }

    setTargetWord({ word: cleanWord, pageNumber: wordPage, wordIndexOnPage });
  }, [currentWordIndex, pageTexts, words, currentReadingPage, setTargetWord]);

  // Reset preload tracking when a new PDF is loaded.
  useEffect(() => {
    if (pageTexts.size > 0) {
      preloadRequestedRef.current = new Set(Array.from(pageTexts.keys()));
    }
  }, [pdfPath]);

  // ─── Playback ────────────────────────────────────────────────────────────────

  const pause = useCallback(() => {
    setIsPlaying(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Auto-pause when the view is hidden so the reader doesn't run in the background.
  useEffect(() => {
    if (!isActive) pause();
  }, [isActive, pause]);

  const play = useCallback(() => {
    if (currentWordIndex >= words.length) setCurrentWordIndex(0);
    setIsPlaying(true);

    intervalRef.current = setInterval(() => {
      setCurrentWordIndex(prev => {
        const next = prev + 1;
        if (next >= words.length) {
          setIsPlaying(false);
          clearInterval(intervalRef.current!);
          intervalRef.current = null;
          return words.length - 1;
        }
        return next;
      });
    }, 60000 / wpm);
  }, [currentWordIndex, wpm, words.length, setCurrentWordIndex]);

  const togglePlayPause = useCallback(() => {
    if (isPlaying) pause(); else play();
  }, [isPlaying, pause, play]);

  // ─── Navigation ──────────────────────────────────────────────────────────────

  const goBack = useCallback(() => {
    const wasPlaying = isPlaying;
    if (wasPlaying) pause();
    setCurrentWordIndex(prev => Math.max(0, prev - 5));
    if (wasPlaying) setTimeout(() => play(), 50);
  }, [isPlaying, pause, play, setCurrentWordIndex]);

  const goForward = useCallback(() => {
    const wasPlaying = isPlaying;
    if (wasPlaying) pause();
    setCurrentWordIndex(prev => Math.min(words.length - 1, prev + 5));
    if (wasPlaying) setTimeout(() => play(), 50);
  }, [isPlaying, pause, play, setCurrentWordIndex, words.length]);

  const resetToStart = useCallback(() => {
    const wasPlaying = isPlaying;
    if (wasPlaying) pause();
    setCurrentWordIndex(0);
    setCurrentReadingPage(1);
    if (wasPlaying) setTimeout(() => play(), 50);
  }, [isPlaying, pause, play, setCurrentWordIndex, setCurrentReadingPage]);

  // ─── Speed ───────────────────────────────────────────────────────────────────

  const updateSpeed = (newWpm: number) => {
    setWpm(newWpm);
    if (isPlaying) { pause(); setTimeout(() => play(), 50); }
  };

  // ─── Keyboard shortcuts (only when this view is active) ──────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isActive) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlayPause(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); goBack(); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); goForward(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isActive, togglePlayPause, goBack, goForward]);

  // Cleanup interval on unmount.
  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  // ─── Derived display values ───────────────────────────────────────────────────

  const progress = words.length > 0 ? ((currentWordIndex + 1) / words.length) * 100 : 0;

  // Page info derived directly from word index + loaded pages.
  const pageInfo = React.useMemo(() => {
    if (pageTexts.size === 0) return null;
    let cumulative = 0;
    for (const page of Array.from(pageTexts.keys()).sort((a, b) => a - b)) {
      const pt = pageTexts.get(page)!;
      if (currentWordIndex < cumulative + pt.wordCount) {
        return { currentPage: page, totalPages };
      }
      cumulative += pt.wordCount;
    }
    return { currentPage: currentReadingPage, totalPages };
  }, [currentWordIndex, pageTexts, totalPages, currentReadingPage]);

  // The clean word currently being displayed (used in the live badge).
  const currentCleanWord = (words[currentWordIndex] || '')
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');

  return (
    <div className="speed-reader-container">
      <div className="speed-reader-content">

        {/* ── Header row ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1>⚡ Speed Reader</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>

            {/* Live target word badge — updates on every word advance */}
            {pageTexts.size > 0 && currentCleanWord && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: '#f0fff4',
                border: '1px solid #68d391',
                borderRadius: '8px',
                padding: '6px 12px',
                fontSize: '0.8rem',
                color: '#276749',
                fontWeight: 600,
                minWidth: 0,
                maxWidth: '220px',
              }}>
                <span style={{ flexShrink: 0 }}>📍</span>
                <span style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  "{currentCleanWord}"
                </span>
                {pageInfo && (
                  <span style={{
                    flexShrink: 0,
                    background: '#c6f6d5',
                    borderRadius: '4px',
                    padding: '1px 6px',
                    fontSize: '0.75rem',
                  }}>
                    p.{pageInfo.currentPage}
                  </span>
                )}
              </div>
            )}

            <button
              onClick={onNavigateToPdf}
              style={{
                padding: '0.5rem 1rem',
                background: '#667eea',
                border: 'none',
                borderRadius: '8px',
                color: 'white',
                fontSize: '0.875rem',
                cursor: 'pointer',
                fontWeight: '600',
              }}
            >
              📄 Back to PDF
            </button>
          </div>
        </div>

        {/* ── File info bar ── */}
        {pdfPath && pageInfo && (
          <div style={{
            background: '#f0f4ff',
            padding: '12px 16px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontSize: '0.875rem',
            color: '#4a5568',
            border: '1px solid #d1dbf5',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <div>
              <strong>Reading:</strong>{' '}
              {pdfPath.split('/').pop() || pdfPath.split('\\').pop()}
            </div>
            <div style={{ fontSize: '0.75rem', color: '#718096' }}>
              Page {pageInfo.currentPage} of {pageInfo.totalPages}
            </div>
          </div>
        )}

        {!pdfPath && (
          <div style={{
            background: '#fff3cd',
            padding: '12px 16px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontSize: '0.875rem',
            color: '#856404',
            border: '1px solid #ffeaa7',
          }}>
            ℹ️ No PDF loaded. Using demo text. Open a PDF and click "Speed Read" to start.
          </div>
        )}

        {/* ── ORP display ── */}
        <div className="reader-display">
          <div className="center-line"></div>
          <div className="word-container">
            <span className="word-before">{wordParts.before}</span>
            <span className="word-orp">{wordParts.orp}</span>
            <span className="word-after">{wordParts.after}</span>
          </div>
        </div>

        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }}></div>
        </div>

        <div className="info-text">
          Word {currentWordIndex + 1} of {words.length}
          {words.length > 0 && (
            <> • {Math.ceil((words.length - currentWordIndex) / (wpm / 60))}s remaining</>
          )}
        </div>

        {/* ── Controls ── */}
        <div className="controls">
          <div className="control-row">
            <div className="speed-control">
              <label htmlFor="speedSlider">Speed:</label>
              <input
                type="range"
                id="speedSlider"
                min="60"
                max="1000"
                value={wpm}
                step="10"
                onChange={(e) => updateSpeed(parseInt(e.target.value))}
              />
              <span className="speed-value">{wpm} WPM</span>
            </div>
          </div>

          <div className="control-row button-group">
            <button className={isPlaying ? 'btn-secondary' : 'btn-primary'} onClick={togglePlayPause}>
              {isPlaying ? '⏸️ Pause' : '▶️ Play'}
            </button>
            <button className="btn-secondary" onClick={goBack}>⏮️ Back 5</button>
            <button className="btn-secondary" onClick={goForward}>⏭️ Forward 5</button>
            <button className="btn-reset" onClick={resetToStart}>⏮️ Reset</button>
          </div>
        </div>

        <div className="keyboard-shortcuts">
          <h3>⌨️ Keyboard Shortcuts</h3>
          <div className="shortcut"><span className="key">Space</span><span>Play / Pause</span></div>
          <div className="shortcut"><span className="key">← Left</span><span>Back 5 words</span></div>
          <div className="shortcut"><span className="key">→ Right</span><span>Forward 5 words</span></div>
        </div>

      </div>
    </div>
  );
};

export default SpeedReader;
