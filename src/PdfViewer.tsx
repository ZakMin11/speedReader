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

// Strip surrounding punctuation so "word." matches "word" during selection.
const normalizeWord = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

const PdfViewer: React.FC<PdfViewerProps> = ({ onNavigateToReader }) => {
    const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
    const [numPages, setNumPages] = useState<number>(0);
    const [currentPage, setCurrentPage] = useState<number>(1);

    // Refs used by customTextRenderer to track word count across text items.
    // Must be refs (not state) because customTextRenderer is called synchronously
    // for every text span during a single render pass.
    const cumulativeWordsRef = useRef(0);
    const highlightDoneRef   = useRef(false);
    const [scale, setScale] = useState<number>(1.5);
    const [error, setError] = useState<string | null>(null);
    const [isExtracting, setIsExtracting] = useState<boolean>(false);
    const [extractionProgress, setExtractionProgress] = useState<number>(0);

    const pdfDocumentRef = useRef<any>(null);

    const {
        setPageText,
        clearPageTexts,
        setCurrentWordIndex,
        setCurrentReadingPage,
        setTotalPages,
        pdfPath,
        setPdfPath,
        pageTexts,
        currentViewPage,
        setCurrentViewPage,
        setPdfData: setContextPdfData,
        targetWord,
        setTargetWord,
    } = useReading();

    const fileData = useMemo(() => {
        if (!pdfData) return null;
        return { data: pdfData };
    }, [pdfData]);

    // ─── File selection ────────────────────────────────────────────────────────

    const handleFileSelect = async () => {
        const selected = await open({
            multiple: false,
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });

        if (selected && typeof selected === 'string') {
            try {
                const bytes = await readFile(selected);
                setPdfData(bytes);
                setContextPdfData(bytes);
                setPdfPath(selected);
                setCurrentPage(1);
                setCurrentViewPage(1);
                setError(null);
                setTargetWord(null);   // clear bookmark for new document
                clearPageTexts();
            } catch (err) {
                console.error('Error reading file:', err);
                setError('Failed to read the PDF file');
            }
        }
    };

    // ─── Sync visible page with currentViewPage ───────────────────────────────
    // SpeedReader updates currentViewPage as it reads. Since PdfViewer is now
    // always mounted (display:none when hidden), we react to context changes so
    // the PDF is already showing the right page when the user switches back.

    useEffect(() => {
        if (currentViewPage >= 1) setCurrentPage(currentViewPage);
    }, [currentViewPage]);

    // ─── Restore PDF bytes from disk on mount ─────────────────────────────────
    // (Re-reading avoids the "object cannot be cloned" error that occurs when
    // react-pdf transfers the ArrayBuffer to the PDF.js worker, detaching it.)

    useEffect(() => {
        if (pdfPath && !pdfData) {
            readFile(pdfPath).then(bytes => {
                setPdfData(bytes);
            }).catch(err => {
                console.error('Error reloading PDF from path:', err);
                setError('Failed to reload PDF file');
            });
        }
    }, [pdfPath]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Text selection → target word ─────────────────────────────────────────
    // When the user drags to select text in the PDF, the first word of the
    // selection becomes the new target word bookmark.  If the page's text has
    // already been extracted we resolve the word index immediately; otherwise
    // we store it with wordIndexOnPage = -1 and resolve it during extraction.

    const handleTextSelection = useCallback(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;

        const selectedText = selection.toString().trim();
        if (!selectedText) return;

        const rawFirst = selectedText.split(/\s+/)[0];
        const cleanFirst = rawFirst.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
        if (!cleanFirst) return;

        const pageText = pageTexts.get(currentPage);
        if (pageText) {
            const words = pageText.text.split(/\s+/).filter(w => w.length > 0);
            const idx = words.findIndex(w => normalizeWord(w) === normalizeWord(cleanFirst));

            if (idx !== -1) {
                // Page already extracted — resolve absolute word index now so the
                // speed reader can jump straight to it without re-extracting.
                let cumulative = 0;
                Array.from(pageTexts.keys())
                    .sort((a, b) => a - b)
                    .forEach(p => { if (p < currentPage) cumulative += pageTexts.get(p)!.wordCount; });

                setCurrentWordIndex(cumulative + idx);
                setTargetWord({ word: cleanFirst, pageNumber: currentPage, wordIndexOnPage: idx });
                return;
            }
        }

        // Page not extracted yet — store word + page, resolve during extraction.
        setTargetWord({ word: cleanFirst, pageNumber: currentPage, wordIndexOnPage: -1 });
    }, [pageTexts, currentPage, setCurrentWordIndex, setTargetWord]);

    // ─── Highlight exactly one word in the PDF text layer ────────────────────
    // react-pdf calls customTextRenderer once per text span (itemIndex 0, 1, 2…).
    // We count words cumulatively across spans so we can locate the exact span
    // and exact position within that span that corresponds to wordIndexOnPage,
    // then highlight only that one occurrence — never all matches of the word.

    const customTextRenderer = useCallback(
        ({ str, itemIndex }: { str: string; itemIndex: number }) => {
            if (
                !targetWord ||
                targetWord.pageNumber !== currentPage ||
                targetWord.wordIndexOnPage < 0
            ) return str;

            // itemIndex 0 marks the start of a fresh page render — reset counters.
            if (itemIndex === 0) {
                cumulativeWordsRef.current = 0;
                highlightDoneRef.current   = false;
            }

            // Already placed the highlight in an earlier span.
            if (highlightDoneRef.current) return str;

            // How many non-whitespace tokens are in this span?
            const spanWords  = str.split(/\s+/).filter(w => w.length > 0);
            const startCount = cumulativeWordsRef.current;
            cumulativeWordsRef.current += spanWords.length;

            // Is the target word inside this span?
            const localIdx = targetWord.wordIndexOnPage - startCount;
            if (localIdx < 0 || localIdx >= spanWords.length) return str;

            // Mark it and stop looking in subsequent spans.
            highlightDoneRef.current = true;
            let seen = 0;
            return str.replace(/\S+/g, match => {
                if (seen === localIdx) { seen++; return `<mark style="background:rgba(255,213,0,0.85);color:inherit;border-radius:3px;padding:0 3px;outline:2px solid rgba(200,160,0,0.8);">${match}</mark>`; }
                seen++;
                return match;
            });
        },
        [targetWord, currentPage]
        // cumulativeWordsRef and highlightDoneRef are refs — intentionally omitted.
    );

    // ─── Text extraction ───────────────────────────────────────────────────────

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

        setIsExtracting(true);
        setError(null);
        setExtractionProgress(0);

        try {
            const totalPagesToExtract = Math.min(2, numPages - startPage + 1);
            let firstPageText = '';

            for (let i = 0; i < totalPagesToExtract; i++) {
                const pageNum = startPage + i;
                const text = await extractPageText(pageNum);
                setPageText(pageNum, text);
                if (i === 0) firstPageText = text;
                setExtractionProgress(((i + 1) / totalPagesToExtract) * 100);
            }

            setCurrentReadingPage(startPage);

            // If there's a pending target word on the start page, resolve its
            // word index now (wordIndexOnPage was -1 before extraction).
            let startWordIndex = 0;
            if (targetWord && targetWord.pageNumber === startPage && firstPageText) {
                const words = firstPageText.split(/\s+/).filter(w => w.length > 0);
                const idx = words.findIndex(
                    w => normalizeWord(w) === normalizeWord(targetWord.word)
                );
                if (idx !== -1) {
                    startWordIndex = idx;
                    // Persist the resolved index back into the target word data.
                    setTargetWord({ ...targetWord, wordIndexOnPage: idx });
                }
            } else if (targetWord && targetWord.pageNumber === startPage &&
                       targetWord.wordIndexOnPage !== -1) {
                startWordIndex = targetWord.wordIndexOnPage;
            }

            setCurrentWordIndex(startWordIndex);
            console.log(`Extracted ${totalPagesToExtract} pages from page ${startPage}, starting at word ${startWordIndex}`);
            onNavigateToReader();
        } catch (err) {
            console.error('Error extracting pages:', err);
            setError('Failed to extract text from PDF');
        } finally {
            setIsExtracting(false);
            setExtractionProgress(0);
        }
    }, [extractPageText, numPages, setPageText, setCurrentReadingPage, setCurrentWordIndex,
        onNavigateToReader, targetWord, setTargetWord]);

    // ─── Preload a specific page (called from SpeedReader via window global) ───
    // SpeedReader passes the exact page number it wants loaded so we can keep
    // 2 pages buffered ahead regardless of the current viewer page.

    const preloadNextPage = useCallback(async (pageToLoad: number) => {
        if (pageToLoad <= numPages && !pageTexts.has(pageToLoad)) {
            try {
                console.log(`Preloading page ${pageToLoad}...`);
                const text = await extractPageText(pageToLoad);
                setPageText(pageToLoad, text);
                console.log(`Preloaded page ${pageToLoad}`);
            } catch (err) {
                console.error(`Error preloading page ${pageToLoad}:`, err);
            }
        }
    }, [numPages, pageTexts, extractPageText, setPageText]);

    useEffect(() => {
        (window as any).preloadNextPage = preloadNextPage;
        return () => { delete (window as any).preloadNextPage; };
    }, [preloadNextPage]);

    // ─── Document event handlers ───────────────────────────────────────────────

    const handleDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
        setTotalPages(numPages);
        setError(null);
    };

    const handleDocumentError = (error: any) => {
        setError(`Failed to load PDF: ${error.message || 'Unknown error'}`);
    };

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

    const startReadingFromCurrentPage = () => {
        // If the user has bookmarked a specific word, start extraction from that
        // word's page so the speed reader begins there.  Otherwise start from
        // whatever page is currently visible in the viewer.
        const startPage = targetWord ? targetWord.pageNumber : currentPage;
        extractInitialPages(startPage);
    };

    // ─── Derived UI values ─────────────────────────────────────────────────────

    const speedReadLabel = isExtracting
        ? 'Loading...'
        : targetWord
            ? `⚡ Speed Read from "${targetWord.word}" (p.${targetWord.pageNumber})`
            : `⚡ Speed Read from Page ${currentPage}`;

    return (
        <div className="pdf-viewer">
            <style>{`
                * { margin: 0; padding: 0; box-sizing: border-box; }

                .pdf-viewer {
                    width: 100%;
                    height: 100vh;
                    background: #1a1a1a;
                    display: flex;
                    flex-direction: column;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    color: #e0e0e0;
                }

                .header {
                    padding: 1rem 2rem;
                    background: #242424;
                    border-bottom: 1px solid #333;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 1rem;
                }

                .title { font-size: 1.25rem; font-weight: 600; color: #fff; }

                .header-actions { display: flex; gap: 0.75rem; align-items: center; }

                .btn {
                    padding: 0.5rem 1rem;
                    background: #3a3a3a;
                    border: 1px solid #555;
                    border-radius: 6px;
                    color: #e0e0e0;
                    font-size: 0.875rem;
                    cursor: pointer;
                    transition: all 0.2s;
                    white-space: nowrap;
                }
                .btn:hover { background: #4a4a4a; border-color: #666; }
                .btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .btn.primary { background: #0066cc; border-color: #0066cc; color: #fff; }
                .btn.primary:hover:not(:disabled) { background: #0052a3; }
                .btn.success { background: #48bb78; border-color: #48bb78; color: #fff; }
                .btn.success:hover:not(:disabled) { background: #38a169; }

                .target-badge {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    background: #1a3a1a;
                    border: 1px solid #38a169;
                    border-radius: 6px;
                    padding: 4px 10px;
                    font-size: 0.8rem;
                    color: #68d391;
                    white-space: nowrap;
                }
                .target-badge button {
                    background: none;
                    border: none;
                    color: #68d391;
                    cursor: pointer;
                    font-size: 1rem;
                    line-height: 1;
                    padding: 0 0 0 4px;
                    opacity: 0.7;
                }
                .target-badge button:hover { opacity: 1; }

                .content {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    padding: 2rem;
                    overflow-y: auto;
                }

                .selection-hint {
                    font-size: 0.75rem;
                    color: #555;
                    margin-bottom: 0.5rem;
                    text-align: center;
                    width: 100%;
                }

                .pdf-container {
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                    border-radius: 4px;
                    overflow: hidden;
                    background: #fff;
                }

                .controls {
                    position: fixed;
                    bottom: 2rem;
                    left: 50%;
                    transform: translateX(-50%);
                    background: #242424;
                    border: 1px solid #333;
                    border-radius: 8px;
                    padding: 0.75rem 1.5rem;
                    display: flex;
                    align-items: center;
                    gap: 1.5rem;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                    z-index: 1000;
                }

                .nav-controls { display: flex; align-items: center; gap: 1rem; }

                .nav-btn {
                    width: 36px; height: 36px;
                    background: #3a3a3a; border: 1px solid #555;
                    border-radius: 6px; color: #e0e0e0;
                    font-size: 1.25rem; cursor: pointer; transition: all 0.2s;
                    display: flex; align-items: center; justify-content: center;
                }
                .nav-btn:hover:not(:disabled) { background: #4a4a4a; border-color: #666; }
                .nav-btn:disabled { opacity: 0.3; cursor: not-allowed; }

                .page-info {
                    font-size: 0.875rem; color: #999;
                    min-width: 80px; text-align: center;
                }

                .zoom-controls {
                    display: flex; align-items: center; gap: 0.5rem;
                    padding-left: 1.5rem; border-left: 1px solid #333;
                }
                .zoom-btn {
                    width: 32px; height: 32px;
                    background: #3a3a3a; border: 1px solid #555;
                    border-radius: 6px; color: #e0e0e0;
                    font-size: 1rem; cursor: pointer; transition: all 0.2s;
                    display: flex; align-items: center; justify-content: center;
                }
                .zoom-btn:hover { background: #4a4a4a; }
                .zoom-level { font-size: 0.75rem; color: #999; min-width: 48px; text-align: center; }

                .empty-state { text-align: center; padding: 4rem 2rem; }
                .empty-icon { font-size: 4rem; margin-bottom: 1.5rem; opacity: 0.3; }
                .empty-title { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.75rem; color: #fff; }
                .empty-description { font-size: 1rem; color: #999; margin-bottom: 2rem; line-height: 1.6; }

                .error-message {
                    background: #7c2020; border: 1px solid #c43a3a;
                    color: #ff9999; padding: 1rem; border-radius: 6px; margin-bottom: 2rem;
                }

                .loading-message {
                    background: #2d5a7b; border: 1px solid #4a8ec2;
                    color: #a8d5ff; padding: 1rem; border-radius: 6px;
                    margin-bottom: 2rem; display: flex; align-items: center; gap: 0.75rem;
                }

                .spinner {
                    width: 20px; height: 20px;
                    border: 3px solid #4a8ec2; border-top-color: #a8d5ff;
                    border-radius: 50%; animation: spin 0.8s linear infinite;
                }
                @keyframes spin { to { transform: rotate(360deg); } }

                .progress-bar-container {
                    width: 100%; max-width: 300px; height: 6px;
                    background: #4a8ec2; border-radius: 3px; overflow: hidden;
                }
                .progress-bar-fill {
                    height: 100%; background: #a8d5ff; transition: width 0.3s;
                }

                /* Ensure the PDF text layer <mark> elements render above the text */
                .react-pdf__Page__textContent mark {
                    position: relative;
                    z-index: 1;
                }
            `}</style>

            <div className="header">
                <div className="title">📄 PDF Viewer</div>
                <div className="header-actions">
                    {/* Persistent target word badge */}
                    {targetWord && (
                        <div className="target-badge">
                            📍 <strong>"{targetWord.word}"</strong> — p.{targetWord.pageNumber}
                            <button
                                onClick={() => setTargetWord(null)}
                                title="Clear target word"
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
                            {speedReadLabel}
                        </button>
                    )}
                </div>
            </div>

            <div className="content" onMouseUp={handleTextSelection}>
                {error && <div className="error-message">{error}</div>}

                {isExtracting && (
                    <div className="loading-message">
                        <div className="spinner"></div>
                        <div>
                            <div>Extracting text from pages...</div>
                            <div className="progress-bar-container" style={{ marginTop: '8px' }}>
                                <div className="progress-bar-fill" style={{ width: `${extractionProgress}%` }}></div>
                            </div>
                        </div>
                    </div>
                )}

                {pdfData && (
                    <div className="selection-hint">
                        {targetWord
                            ? `Showing highlight for "${targetWord.word}" — select different text to change`
                            : 'Select a word in the PDF to set your reading start point'}
                    </div>
                )}

                {!fileData ? (
                    <div className="empty-state">
                        <div className="empty-icon">📄</div>
                        <h2 className="empty-title">No PDF Loaded</h2>
                        <p className="empty-description">
                            Open a PDF, select a word to bookmark your start point, then click Speed Read
                        </p>
                    </div>
                ) : (
                    <div className="pdf-container">
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
                                customTextRenderer={customTextRenderer}
                            />
                        </Document>
                    </div>
                )}
            </div>

            {pdfData && numPages > 0 && (
                <div className="controls">
                    <div className="nav-controls">
                        <button
                            className="nav-btn"
                            onClick={goToPreviousPage}
                            disabled={currentPage <= 1}
                            type="button"
                        >‹</button>
                        <div className="page-info">{currentPage} / {numPages}</div>
                        <button
                            className="nav-btn"
                            onClick={goToNextPage}
                            disabled={currentPage >= numPages}
                            type="button"
                        >›</button>
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
