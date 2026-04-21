import React, { useState, useEffect, useRef, useCallback } from 'react';
import './SpeedReader.css';
import { useReading } from './ReadingContext';

interface SpeedReaderProps {
  onNavigateToPdf: () => void;
  isActive: boolean;
  isSplitView: boolean;
  onToggleSplitView: () => void;
}

const SpeedReader: React.FC<SpeedReaderProps> = ({ onNavigateToPdf, isActive, isSplitView, onToggleSplitView }) => {
  const {
    getAllWords,
    currentWordIndex,
    setCurrentWordIndex,
    currentReadingPage,
    setCurrentReadingPage,
    setCurrentViewPage,
    setTargetWord,
    setPdfSelectedTarget,
    pdfPath,
    totalPages,
    pageTexts,
  } = useReading();

  const fallbackText = "It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions, though not quickly enough to prevent a swirl of gritty dust from entering along with him";

  const words = React.useMemo(() => {
    if (pageTexts.size > 0) return getAllWords();
    return fallbackText.split(/\s+/).filter(w => w.length > 0);
  }, [pageTexts, getAllWords]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [wpm, setWpm] = useState(250);
  const [wordSize, setWordSize] = useState(52);
  const [isDark, setIsDark] = useState(true);
  const [showOrpColor, setShowOrpColor] = useState(true);
  const [showOrpBox, setShowOrpBox] = useState(true);
  const [showCenterLine, setShowCenterLine] = useState(true);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preloadRequestedRef = useRef<Set<number>>(new Set());
  const punctuationPauseMs = 100; // Extra pause for punctuation (ms)

  // ─── ORP ─────────────────────────────────────────────────────────────────────

  const getWordParts = () => {
    const word = words[currentWordIndex] || '';
    const orp = Math.round(word.length * 0.3);
    return {
      before: word.substring(0, orp),
      orp: word.charAt(orp),
      after: word.substring(orp + 1),
    };
  };
  const wordParts = getWordParts();

  // ─── Page tracking & preloading ──────────────────────────────────────────────

  const checkAndPreload = useCallback(() => {
    if (pageTexts.size === 0 || words.length === 0) return;
    const sortedPages = Array.from(pageTexts.keys()).sort((a, b) => a - b);

    let cumulative = 0;
    let currentPageNum = currentReadingPage;
    for (const page of sortedPages) {
      const pt = pageTexts.get(page)!;
      if (currentWordIndex < cumulative + pt.wordCount) { currentPageNum = page; break; }
      cumulative += pt.wordCount;
    }
    if (currentPageNum !== currentReadingPage) setCurrentReadingPage(currentPageNum);

    const highestLoaded = sortedPages[sortedPages.length - 1];
    for (let ahead = 1; ahead <= 2; ahead++) {
      const nextPage = highestLoaded + ahead;
      if (nextPage <= totalPages && !pageTexts.has(nextPage) && !preloadRequestedRef.current.has(nextPage)) {
        preloadRequestedRef.current.add(nextPage);
        if (typeof (window as any).preloadNextPage === 'function') {
          (window as any).preloadNextPage(nextPage);
        }
        break;
      }
    }
  }, [currentWordIndex, words.length, currentReadingPage, totalPages, pageTexts, setCurrentReadingPage]);

  useEffect(() => { checkAndPreload(); }, [currentWordIndex, checkAndPreload]);

  useEffect(() => { setCurrentViewPage(currentReadingPage); }, [currentReadingPage, setCurrentViewPage]);

  // ─── Live target word sync ────────────────────────────────────────────────────

  useEffect(() => {
    if (pageTexts.size === 0 || words.length === 0) return;
    const rawWord = words[currentWordIndex] || '';
    const cleanWord = rawWord.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
    if (!cleanWord) return;

    const sortedPages = Array.from(pageTexts.keys()).sort((a, b) => a - b);
    let cumulative = 0, wordPage = currentReadingPage, wordIndexOnPage = currentWordIndex;
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

  useEffect(() => {
    if (pageTexts.size > 0) preloadRequestedRef.current = new Set(Array.from(pageTexts.keys()));
  }, [pdfPath]);

  // ─── Playback ────────────────────────────────────────────────────────────────

  const pause = useCallback(() => {
    setIsPlaying(false);
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  useEffect(() => { if (!isActive) pause(); }, [isActive, pause]);

  const play = useCallback(() => {
    if (currentWordIndex >= words.length) setCurrentWordIndex(0);
    setIsPlaying(true);

    const scheduleNextWord = (index: number) => {
      if (index >= words.length) {
        setIsPlaying(false);
        return;
      }

      // Calculate base interval from WPM
      let delay = 60000 / wpm;

      // Add extra pause if current word ends with punctuation
      const currentWord = words[index] || '';
      if (/[.,;:!?—]$/.test(currentWord)) {
        delay += punctuationPauseMs;
      }

      timeoutRef.current = setTimeout(() => {
        if (index + 1 >= words.length) {
          setIsPlaying(false);
          setCurrentWordIndex(words.length - 1);
        } else {
          setCurrentWordIndex(index + 1);
          scheduleNextWord(index + 1);
        }
      }, delay);
    };

    scheduleNextWord(currentWordIndex);
  }, [currentWordIndex, wpm, words, punctuationPauseMs, setCurrentWordIndex]);

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

  const updateSpeed = (newWpm: number) => {
    setWpm(newWpm);
    if (isPlaying) { pause(); setTimeout(() => play(), 50); }
  };

  const handleBackToPdf = useCallback(() => {
    pause();
    if (pageTexts.size > 0 && words.length > 0) {
      const rawWord = words[currentWordIndex] || '';
      const cleanWord = rawWord.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
      if (cleanWord) {
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
      }
    }
    setPdfSelectedTarget(null);
    onNavigateToPdf();
  }, [pause, currentWordIndex, words, pageTexts, currentReadingPage, setTargetWord, setPdfSelectedTarget, onNavigateToPdf]);

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActive) return;
      if (e.code === 'Space')      { e.preventDefault(); togglePlayPause(); }
      else if (e.code === 'ArrowLeft')  { e.preventDefault(); goBack(); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); goForward(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isActive, togglePlayPause, goBack, goForward]);

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

  // ─── Derived display values ───────────────────────────────────────────────────

  const progress = words.length > 0 ? ((currentWordIndex + 1) / words.length) * 100 : 0;

  const pageInfo = React.useMemo(() => {
    if (pageTexts.size === 0) return null;
    let cumulative = 0;
    for (const page of Array.from(pageTexts.keys()).sort((a, b) => a - b)) {
      const pt = pageTexts.get(page)!;
      if (currentWordIndex < cumulative + pt.wordCount) return { currentPage: page, totalPages };
      cumulative += pt.wordCount;
    }
    return { currentPage: currentReadingPage, totalPages };
  }, [currentWordIndex, pageTexts, totalPages, currentReadingPage]);

  const secsRemaining = words.length > 0
    ? Math.ceil((words.length - currentWordIndex) / (wpm / 60))
    : 0;
  const timeRemaining = secsRemaining >= 60
    ? `${Math.floor(secsRemaining / 60)}m ${secsRemaining % 60}s`
    : `${secsRemaining}s`;

  const filename = pdfPath
    ? (pdfPath.split('/').pop() || pdfPath.split('\\').pop() || pdfPath)
    : null;

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="sr-root" data-theme={isDark ? 'dark' : 'light'}>

      {/* Topbar */}
      <header className="sr-topbar">
        {!isSplitView && (
          <>
            <button className="sr-back-btn" onClick={handleBackToPdf} type="button">
              ← PDF
            </button>
            <div className="sr-topbar-sep" />
          </>
        )}
        <div className="sr-file-info">
          {filename ? (
            <>
              <span className="sr-filename">{filename}</span>
              {pageInfo && (
                <span className="sr-page-badge">
                  p.{pageInfo.currentPage} / {pageInfo.totalPages}
                </span>
              )}
            </>
          ) : (
            <span className="sr-filename-demo">Demo text — open a PDF to begin</span>
          )}
        </div>
        <button
          className="sr-theme-btn"
          onClick={onToggleSplitView}
          type="button"
        >
          {isSplitView ? 'Exit Split' : 'Split'}
        </button>
        <div className="sr-topbar-sep" />
        <button
          className="sr-theme-btn"
          onClick={() => setIsDark(d => !d)}
          type="button"
          title="Toggle light / dark"
        >
          {isDark ? 'Light' : 'Dark'}
        </button>
      </header>

      {/* Word display */}
      <main className="sr-display">
        <div className="sr-word-frame">
          <div className="sr-center-mark" style={{ display: showCenterLine ? undefined : 'none' }} />
          <div className="sr-word" style={{ fontSize: `${wordSize}px` }}>
            <span className="sr-before">{wordParts.before}</span>
            <span
              className="sr-orp"
              style={{
                color: showOrpColor ? undefined : 'inherit',
                background: showOrpBox ? undefined : 'transparent',
              }}
            >{wordParts.orp}</span>
            <span className="sr-after">{wordParts.after}</span>
          </div>
        </div>
      </main>

      {/* Progress + stats strip */}
      <div className="sr-info-strip">
        <div className="sr-progress-track">
          <div className="sr-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="sr-info-stat">{currentWordIndex + 1} / {words.length}</span>
        {words.length > 0 && (
          <span className="sr-info-stat">{timeRemaining} left</span>
        )}
      </div>

      {/* Settings panel */}
      <footer className="sr-panel">
        <div className="sr-panel-inner">

          {/* Speed */}
          <div className="sr-setting-row">
            <span className="sr-setting-label">Speed</span>
            <input
              type="range"
              className="sr-slider"
              min="60"
              max="1000"
              step="10"
              value={wpm}
              onChange={e => updateSpeed(parseInt(e.target.value))}
            />
            <span className="sr-setting-value">{wpm} WPM</span>
          </div>

          {/* Word size */}
          <div className="sr-setting-row">
            <span className="sr-setting-label">Size</span>
            <input
              type="range"
              className="sr-slider"
              min="24"
              max="96"
              step="4"
              value={wordSize}
              onChange={e => setWordSize(parseInt(e.target.value))}
            />
            <span className="sr-setting-value">{wordSize}px</span>
          </div>

          {/* Display toggles */}
          <div className="sr-setting-row">
            <span className="sr-setting-label">Show</span>
            <div className="sr-toggle-group">
              <button
                className={`sr-toggle-btn${showOrpColor ? ' sr-toggle-on' : ''}`}
                onClick={() => setShowOrpColor(v => !v)}
                type="button"
              >Color</button>
              <button
                className={`sr-toggle-btn${showOrpBox ? ' sr-toggle-on' : ''}`}
                onClick={() => setShowOrpBox(v => !v)}
                type="button"
              >Box</button>
              <button
                className={`sr-toggle-btn${showCenterLine ? ' sr-toggle-on' : ''}`}
                onClick={() => setShowCenterLine(v => !v)}
                type="button"
              >Line</button>
            </div>
          </div>

          {/* Transport */}
          <div className="sr-transport">
            <button className="sr-btn" onClick={resetToStart} type="button">Reset</button>
            <button className="sr-btn" onClick={goBack} type="button">← 5</button>
            <button className="sr-btn sr-btn-play" onClick={togglePlayPause} type="button">
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button className="sr-btn" onClick={goForward} type="button">5 →</button>
          </div>

          {/* Shortcuts */}
          <div className="sr-shortcuts">
            <div className="sr-shortcut">
              <span className="sr-key">Space</span>
              <span>Play / Pause</span>
            </div>
            <div className="sr-shortcut">
              <span className="sr-key">←</span>
              <span>Back 5</span>
            </div>
            <div className="sr-shortcut">
              <span className="sr-key">→</span>
              <span>Forward 5</span>
            </div>
          </div>

        </div>
      </footer>
    </div>
  );
};

export default SpeedReader;
