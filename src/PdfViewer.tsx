import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { useReading } from './ReadingContext';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
).toString();

interface PdfViewerProps {
  onNavigateToReader: () => void;
}

const PdfViewer: React.FC<PdfViewerProps> = ({ onNavigateToReader }) => {
    // ── No local pdfData state — use context directly ──────────────────────────
    const [numPages, setNumPages] = useState<number>(0);
    const [scale, setScale] = useState<number>(1.5);
    const [error, setError] = useState<string | null>(null);
    const [isExtracting, setIsExtracting] = useState<boolean>(false);
    const [extractionProgress, setExtractionProgress] = useState<number>(0);

    const pdfDocumentRef = useRef<any>(null);
    const pdfContainerRef = useRef<HTMLDivElement>(null);

    // Word the user clicked in the PDF text layer — used as speed-read start point.
    // `occurrence` is the 0-based index of this specific instance on the page
    // (in PDF content-stream order = DOM order), so we can re-highlight and
    // jump to the exact occurrence even when the word appears multiple times.
    const [selectedTargetWord, setSelectedTargetWord] = useState<{
        word: string;
        page: number;
        occurrence: number;
    } | null>(null);

    // ── CSS Custom Highlight API helpers ──────────────────────────────────────
    // Supported in Chromium 105+ and Safari 17.2+ (covers Tauri's WKWebView on
    // macOS 14+). If unavailable the pill still shows the selection; no crash.

    const applyHighlight = useCallback((range: Range) => {
        if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
            (CSS as any).highlights.set('sr-target', new (window as any).Highlight(range));
        }
    }, []);

    const clearHighlight = useCallback(() => {
        if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
            (CSS as any).highlights.delete('sr-target');
        }
    }, []);

    const {
        setPageText,
        clearPageTexts,
        setCurrentWordIndex,
        setCurrentReadingPage,
        setTotalPages,
        pdfPath,
        setPdfPath,
        pageTexts,
        // currentViewPage is the source of truth for which page we're on.
        // We initialize currentPage from it so returning from SpeedReader
        // lands on the correct page rather than always jumping back to 1.
        currentViewPage,
        setCurrentViewPage,
        pdfData: contextPdfData,
        setPdfData: setContextPdfData,
        setTargetWord,
    } = useReading();

    // currentPage drives the <Page> component. Initialise from context so
    // switching back from SpeedReader restores the last-viewed page.
    const [currentPage, setCurrentPage] = useState<number>(currentViewPage || 1);

    // Keep local currentPage in sync if context changes externally
    // (e.g. SpeedReader updated currentViewPage while this component was hidden).
    useEffect(() => {
        if (currentViewPage && currentViewPage !== currentPage) {
            setCurrentPage(currentViewPage);
        }
        // Only re-sync when the component first becomes visible / mounts.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);  // intentionally empty — only run on mount

    const fileData = useMemo(() => {
        if (!contextPdfData) return null;
        return { data: contextPdfData };
    }, [contextPdfData]);

    const handleFileSelect = async () => {
        const selected = await open({
            multiple: false,
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });

        if (selected && typeof selected === 'string') {
            try {
                const bytes = await readFile(selected);
                setContextPdfData(bytes);
                setPdfPath(selected);
                setCurrentPage(1);
                setCurrentViewPage(1);
                setError(null);
                clearPageTexts(); // clears word index and reading page too (see context)
                setSelectedTargetWord(null);
                clearHighlight();
            } catch (err) {
                console.error('Error reading file:', err);
                setError('Failed to read the PDF file');
            }
        }
    };

    // Walk the text layer and highlight the n-th occurrence (selectedTargetWord.occurrence)
    // of the target word. This is extracted as a stable callback so the MutationObserver
    // effect below can call it without capturing a stale closure.
    const reapplyHighlight = useCallback(() => {
        if (!selectedTargetWord || selectedTargetWord.page !== currentPage) {
            clearHighlight();
            return;
        }
        const container = pdfContainerRef.current;
        if (!container) return;
        const textLayer = container.querySelector('.react-pdf__Page__textContent');
        if (!textLayer) return;

        const needle = selectedTargetWord.word.toLowerCase();
        // 'g' flag required for exec-loop; reset lastIndex per span below.
        const wordRe = new RegExp(
            `(?<![a-zA-Z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9])`,
            'ig'
        );

        // Count every individual word match across span texts (character-level),
        // not one count per span — a span can contain the word multiple times.
        let found = 0;
        for (const span of Array.from(textLayer.querySelectorAll('span'))) {
            const textNode = span.firstChild;
            if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
            const text = textNode.textContent ?? '';
            wordRe.lastIndex = 0;
            let m;
            while ((m = wordRe.exec(text)) !== null) {
                if (found === selectedTargetWord.occurrence) {
                    try {
                        const range = document.createRange();
                        range.setStart(textNode, m.index);
                        range.setEnd(textNode, m.index + m[0].length);
                        applyHighlight(range);
                    } catch (_) { /* DOM changed between schedule and execution */ }
                    return;
                }
                found++;
            }
        }
    }, [selectedTargetWord, currentPage, applyHighlight, clearHighlight]);

    // MutationObserver keeps the highlight alive at all times.
    // Any time react-pdf rebuilds the text layer (page change, zoom, font load,
    // or any internal re-render) the observer fires and re-applies.
    // A debounce of 80 ms lets the entire text layer finish painting before
    // we query it — without leaving a visible gap.
    useEffect(() => {
        if (!selectedTargetWord || !pdfContainerRef.current) {
            if (!selectedTargetWord) clearHighlight();
            return;
        }

        let debounce: ReturnType<typeof setTimeout>;
        const schedule = () => {
            clearTimeout(debounce);
            debounce = setTimeout(reapplyHighlight, 80);
        };

        const observer = new MutationObserver(schedule);
        observer.observe(pdfContainerRef.current, { childList: true, subtree: true });

        // Run immediately in case the text layer is already painted and no
        // mutations are pending (e.g. user just toggled an unrelated state).
        schedule();

        return () => {
            observer.disconnect();
            clearTimeout(debounce);
        };
    }, [selectedTargetWord, currentPage, reapplyHighlight, clearHighlight]);

    // ── Word selection from PDF text layer ────────────────────────────────────

    // Fires on mouseup inside the PDF container. Captures the selected word
    // (double-click selects a word; click-drag selects a phrase and we take
    // the first word). Clears the browser selection afterward so it doesn't
    // interfere with the next interaction.
    const handleWordSelection = useCallback(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;
        const raw = selection.toString().trim();
        if (!raw) return;
        const firstToken = raw.split(/\s+/)[0];
        const clean = firstToken.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
        if (!clean) return;
        if (selection.rangeCount === 0) return;

        const selRange = selection.getRangeAt(0);

        // ── Determine which occurrence the user clicked ─────────────────────────
        // Walk spans in DOM order (= PDF content-stream order), count how many
        // matching spans appear before the clicked one. That count becomes the
        // `occurrence` index used by reapplyHighlight and extractInitialPages.
        let occurrence = 0;
        let foundOccurrence = false;
        const container = pdfContainerRef.current;
        if (container) {
            const textLayer = container.querySelector('.react-pdf__Page__textContent');
            if (textLayer) {
                const wordRe = new RegExp(
                    `(?<![a-zA-Z0-9])${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z0-9])`,
                    'i'
                );
                let count = 0;
                for (const span of Array.from(textLayer.querySelectorAll('span'))) {
                    const textNode = span.firstChild;
                    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
                    if (!wordRe.test(textNode.textContent ?? '')) continue;
                    // The selection's startContainer is the text node of the clicked span.
                    if (textNode === selRange.startContainer || span === selRange.startContainer) {
                        occurrence = count;
                        foundOccurrence = true;
                        break;
                    }
                    count++;
                }
            }
        }
        // If we couldn't resolve the occurrence (e.g. selection crossed span boundaries),
        // default to 0 — still a valid and useful start position.
        if (!foundOccurrence) occurrence = 0;

        // Apply the highlight immediately using the live Range (before clearing selection).
        applyHighlight(selRange.cloneRange());

        setSelectedTargetWord({ word: clean, page: currentPage, occurrence });
        selection.removeAllRanges();
    }, [currentPage, applyHighlight]);

    // ── Text extraction ────────────────────────────────────────────────────────

    const extractPageText = useCallback(async (pageNumber: number): Promise<string> => {
        if (!pdfDocumentRef.current) throw new Error('PDF document not loaded');
        const page = await pdfDocumentRef.current.getPage(pageNumber);
        const textContent = await page.getTextContent();
        return textContent.items
            .map((item: any) => item.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }, []);

    const extractInitialPages = useCallback(async (startPage: number = 1) => {
        if (!pdfDocumentRef.current) return;

        // When a target word is set, always start extraction from that word's page.
        const effectiveStart = selectedTargetWord ? selectedTargetWord.page : startPage;

        // ── Critical: clear stale pages before a target-word jump ──────────────
        // getAllWords() in SpeedReader concatenates every page in pageTexts in
        // sorted order.  If old pages from a previous reading session are still in
        // the map, globalIdx = idxOnPage would point to the wrong word.
        // Clearing first ensures the map only ever holds the pages we extract now,
        // so words[idxOnPage] === targetWord is guaranteed.
        if (selectedTargetWord) {
            clearPageTexts(); // also resets currentWordIndex → 0
        }

        setIsExtracting(true);
        setError(null);
        setExtractionProgress(0);

        try {
            const totalPagesToExtract = Math.min(2, numPages - effectiveStart + 1);
            // Local copy so we can read text synchronously — React state won't
            // flush until after this async function returns.
            const extractedTexts = new Map<number, string>();

            for (let i = 0; i < totalPagesToExtract; i++) {
                const pageNum = effectiveStart + i;
                const text = await extractPageText(pageNum);
                setPageText(pageNum, text);
                extractedTexts.set(pageNum, text);
                setExtractionProgress(((i + 1) / totalPagesToExtract) * 100);
            }

            setCurrentReadingPage(effectiveStart);

            if (selectedTargetWord) {
                // After clearPageTexts() above, extractedTexts is the entire new map.
                // effectiveStart === selectedTargetWord.page, so globalIdx === idxOnPage.
                const targetPageText = extractedTexts.get(selectedTargetWord.page);
                if (targetPageText) {
                    const pageWords = targetPageText.split(/\s+/).filter(w => w.length > 0);
                    const needle = selectedTargetWord.word.toLowerCase();

                    // Find the n-th occurrence in extracted text order, matching the
                    // DOM occurrence the user actually clicked (same content-stream order).
                    let matchCount = 0;
                    let idxOnPage = 0; // fallback: start of page
                    for (let i = 0; i < pageWords.length; i++) {
                        const w = pageWords[i]
                            .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '')
                            .toLowerCase();
                        if (w === needle) {
                            if (matchCount === selectedTargetWord.occurrence) {
                                idxOnPage = i;
                                break;
                            }
                            matchCount++;
                        }
                    }

                    setCurrentWordIndex(idxOnPage);
                    setTargetWord({
                        word: selectedTargetWord.word,
                        pageNumber: selectedTargetWord.page,
                        wordIndexOnPage: idxOnPage,
                    });
                }
            }
            // No target: preserve currentWordIndex (resume position).
            // clearPageTexts() on new PDF load already resets it to 0.

            onNavigateToReader();
        } catch (err) {
            console.error('Error extracting pages:', err);
            setError('Failed to extract text from PDF');
        } finally {
            setIsExtracting(false);
            setExtractionProgress(0);
        }
    }, [extractPageText, numPages, setPageText, setCurrentReadingPage, onNavigateToReader,
        selectedTargetWord, setCurrentWordIndex, setTargetWord, clearPageTexts]);

    const preloadNextPage = useCallback(async (pageNumber: number) => {
        if (!pdfDocumentRef.current) return;
        if (pageNumber > numPages || pageTexts.has(pageNumber)) return;

        try {
            const text = await extractPageText(pageNumber);
            setPageText(pageNumber, text);
        } catch (err) {
            console.error(`Error preloading page ${pageNumber}:`, err);
        }
    }, [numPages, pageTexts, extractPageText, setPageText]);

    useEffect(() => {
        (window as any).preloadNextPage = preloadNextPage;
        return () => { delete (window as any).preloadNextPage; };
    }, [preloadNextPage]);

    // ── Document events ────────────────────────────────────────────────────────

    const handleDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
        setTotalPages(numPages);
        setError(null);
    };

    const handleDocumentError = (err: any) => {
        setError(`Failed to load PDF: ${err.message || 'Unknown error'}`);
    };

    // ── Navigation ─────────────────────────────────────────────────────────────

    const goToNextPage = () => {
        if (currentPage < numPages) {
            const next = currentPage + 1;
            setCurrentPage(next);
            setCurrentViewPage(next);
        }
    };

    const goToPreviousPage = () => {
        if (currentPage > 1) {
            const prev = currentPage - 1;
            setCurrentPage(prev);
            setCurrentViewPage(prev);
        }
    };

    const handleZoomIn  = () => setScale(prev => Math.min(3, prev + 0.25));
    const handleZoomOut = () => setScale(prev => Math.max(0.5, prev - 0.25));

    const startReadingFromCurrentPage = () => extractInitialPages(currentPage);

    return (
        <div className="pdf-viewer">
            <style>{`
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
                .pdf-viewer { width: 100%; height: 100vh; background: #111; display: flex; flex-direction: column; font-family: inherit; color: #c8c8c8; -webkit-font-smoothing: antialiased; }

                /* Header */
                .header { padding: 0 18px; height: 44px; background: #181818; border-bottom: 1px solid #252525; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-shrink: 0; }
                .title { font-size: 13px; font-weight: 500; color: #888; letter-spacing: 0.01em; }
                .header-actions { display: flex; gap: 8px; align-items: center; }

                /* Buttons */
                .btn { padding: 5px 12px; background: #1e1e1e; border: 1px solid #2e2e2e; border-radius: 4px; color: #c8c8c8; font-size: 12px; font-family: inherit; cursor: pointer; transition: background 0.12s, border-color 0.12s; white-space: nowrap; }
                .btn:hover { background: #262626; border-color: #3a3a3a; }
                .btn:disabled { opacity: 0.4; cursor: not-allowed; }
                /* "Open PDF" — ghost */
                .btn.primary { background: #1e1e1e; border-color: #363636; color: #aaa; }
                .btn.primary:hover:not(:disabled) { background: #262626; border-color: #484848; color: #c8c8c8; }
                /* "Speed Read" — high-contrast fill, the one key action */
                .btn.success { background: #c8c8c8; border-color: #c8c8c8; color: #111; font-weight: 600; }
                .btn.success:hover:not(:disabled) { background: #b8b8b8; border-color: #b8b8b8; }

                /* Content area */
                .content { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 2rem; overflow-y: auto; }
                .pdf-container { box-shadow: 0 2px 12px rgba(0,0,0,0.6); overflow: hidden; background: #fff; }

                /* Bottom controls */
                .controls { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); background: #181818; border: 1px solid #252525; border-radius: 6px; padding: 8px 16px; display: flex; align-items: center; gap: 1.25rem; box-shadow: 0 4px 16px rgba(0,0,0,0.5); z-index: 1000; }
                .nav-controls { display: flex; align-items: center; gap: 10px; }
                .nav-btn { width: 32px; height: 32px; background: #1e1e1e; border: 1px solid #2e2e2e; border-radius: 4px; color: #c8c8c8; font-size: 1.1rem; cursor: pointer; transition: background 0.12s; display: flex; align-items: center; justify-content: center; }
                .nav-btn:hover:not(:disabled) { background: #262626; }
                .nav-btn:disabled { opacity: 0.25; cursor: not-allowed; }
                .page-info { font-size: 12px; color: #555; min-width: 72px; text-align: center; font-variant-numeric: tabular-nums; }
                .zoom-controls { display: flex; align-items: center; gap: 8px; padding-left: 1.25rem; border-left: 1px solid #252525; }
                .zoom-btn { width: 28px; height: 28px; background: #1e1e1e; border: 1px solid #2e2e2e; border-radius: 4px; color: #c8c8c8; font-size: 0.9rem; cursor: pointer; transition: background 0.12s; display: flex; align-items: center; justify-content: center; }
                .zoom-btn:hover { background: #262626; }
                .zoom-level { font-size: 11px; color: #555; min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; }

                /* Empty state */
                .empty-state { text-align: center; padding: 4rem 2rem; }
                .empty-icon { font-size: 3rem; margin-bottom: 1.5rem; opacity: 0.15; }
                .empty-title { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; color: #c8c8c8; }
                .empty-description { font-size: 0.875rem; color: #555; margin-bottom: 2rem; line-height: 1.6; }

                /* Error / loading */
                .error-message { background: #1e1212; border: 1px solid #3a2020; color: #cc8888; padding: 0.75rem 1rem; border-radius: 4px; margin-bottom: 1.5rem; font-size: 13px; }
                .loading-message { background: #181818; border: 1px solid #2a2a2a; color: #888; padding: 0.75rem 1rem; border-radius: 4px; margin-bottom: 1.5rem; display: flex; align-items: center; gap: 0.75rem; font-size: 13px; }
                .spinner { width: 16px; height: 16px; border: 2px solid #333; border-top-color: #888; border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
                @keyframes spin { to { transform: rotate(360deg); } }
                .progress-bar-container { width: 100%; max-width: 200px; height: 3px; background: #2a2a2a; border-radius: 2px; overflow: hidden; }
                .progress-bar-fill { height: 100%; background: #555; transition: width 0.3s; }

                /* Target word pill — monochrome */
                .target-pill { display: flex; align-items: center; gap: 6px; background: #1e1e1e; border: 1px solid #363636; border-radius: 4px; padding: 4px 10px; font-size: 11px; color: #888; max-width: 220px; min-width: 0; }
                .target-pill-word { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #c8c8c8; }
                .target-pill-page { flex-shrink: 0; background: #2a2a2a; border-radius: 3px; padding: 1px 5px; font-size: 10px; color: #666; }
                .target-clear-btn { flex-shrink: 0; background: none; border: none; color: #555; cursor: pointer; font-size: 0.85rem; padding: 0 2px; line-height: 1; transition: color 0.12s; font-family: inherit; }
                .target-clear-btn:hover { color: #c8c8c8; }
                .selection-hint { font-size: 11px; color: #333; text-align: center; padding: 6px 0 0; pointer-events: none; user-select: none; }
                /* CSS Custom Highlight API — marks the target word in the PDF text layer */
                ::highlight(sr-target) { background-color: rgba(180, 180, 180, 0.45); color: inherit; }
            `}</style>

            <div className="header">
                <div className="title">PDF Viewer</div>
                <div className="header-actions">
                    {/* Target word pill — shown when user has selected a start word */}
                    {selectedTargetWord && (
                        <div className="target-pill" title={`Start speed reading from "${selectedTargetWord.word}"`}>
                            <span className="target-pill-word">Start: "{selectedTargetWord.word}"</span>
                            <span className="target-pill-page">p.{selectedTargetWord.page}</span>
                            <button
                                className="target-clear-btn"
                                onClick={() => { setSelectedTargetWord(null); clearHighlight(); }}
                                title="Clear target word"
                                type="button"
                            >
                                ✕
                            </button>
                        </div>
                    )}

                    <button className="btn primary" onClick={handleFileSelect}>
                        {pdfPath ? 'Change PDF' : 'Open PDF'}
                    </button>
                    {fileData && (
                        <button
                            className="btn success"
                            onClick={startReadingFromCurrentPage}
                            disabled={isExtracting}
                        >
                            {isExtracting
                                ? 'Loading...'
                                : selectedTargetWord
                                    ? `Speed Read from "${selectedTargetWord.word}"`
                                    : `Speed Read — p.${currentPage}`}
                        </button>
                    )}
                </div>
            </div>

            <div className="content">
                {error && <div className="error-message">{error}</div>}
                {isExtracting && (
                    <div className="loading-message">
                        <div className="spinner" />
                        <div>
                            <div>Extracting text from pages...</div>
                            <div className="progress-bar-container" style={{ marginTop: '8px' }}>
                                <div className="progress-bar-fill" style={{ width: `${extractionProgress}%` }} />
                            </div>
                        </div>
                    </div>
                )}
                {!fileData ? (
                    <div className="empty-state">
                        <div className="empty-icon">—</div>
                        <h2 className="empty-title">No document open</h2>
                        <p className="empty-description">
                            Open a PDF, then double-click any word to set your start point
                        </p>
                    </div>
                ) : (
                    <div
                        className="pdf-container"
                        ref={pdfContainerRef}
                        onMouseUp={handleWordSelection}
                    >
                        <Document
                            file={fileData}
                            onLoadSuccess={(pdf) => {
                                handleDocumentLoadSuccess({ numPages: pdf.numPages });
                                pdfDocumentRef.current = pdf;
                            }}
                            onLoadError={handleDocumentError}
                        >
                            <Page
                                pageNumber={currentPage}
                                scale={scale}
                                renderTextLayer={true}
                                renderAnnotationLayer={false}
                            />
                        </Document>
                    </div>
                )}
                {fileData && (
                    <p className="selection-hint">
                        Double-click any word to set it as the speed-reading start point
                    </p>
                )}
            </div>

            {contextPdfData && numPages > 0 && (
                <div className="controls">
                    <div className="nav-controls">
                        <button className="nav-btn" onClick={goToPreviousPage} disabled={currentPage <= 1} type="button">‹</button>
                        <div className="page-info">{currentPage} / {numPages}</div>
                        <button className="nav-btn" onClick={goToNextPage} disabled={currentPage >= numPages} type="button">›</button>
                    </div>
                    <div className="zoom-controls">
                        <button className="zoom-btn" onClick={handleZoomOut} type="button">−</button>
                        <div className="zoom-level">{Math.round(scale * 100)}%</div>
                        <button className="zoom-btn" onClick={handleZoomIn} type="button">+</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PdfViewer;